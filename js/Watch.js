/*
 * Watch.js — LONG entry timing layer
 * ------------------------------------------------------------
 * Purpose:
 *   - Reads SELECT rows already present in #candidateBody.
 *   - Does NOT select coins and does NOT modify scanner logic.
 *   - Does NOT modify Follow state, inputs, buttons, timers or decisions.
 *   - Always evaluates LONG entry timing, regardless of which scanner
 *     produced the SELECT row (including scanners whose source strategy
 *     was SHORT).
 *
 * Signal meaning:
 *   GREEN  / ENTRY    -> LONG entry timing is currently ready.
 *   YELLOW / WAIT     -> Candidate is still valid but timing is not ready.
 *   RED    / NO ENTRY -> Current LONG structure is invalid / actively bearish.
 *
 * Public REST usage is intentionally cached:
 *   1m refresh ~15s, 5m ~45s, 15m ~90s.
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    cycleMs: 15000,
    requestTimeoutMs: 9000,
    concurrency: 4,
    cacheTtl: Object.freeze({ '1m': 12000, '5m': 45000, '15m': 90000 }),
    limits: Object.freeze({ '1m': 80, '5m': 90, '15m': 90 }),
    minClosedBars: Object.freeze({ '1m': 45, '5m': 55, '15m': 55 }),
    cooldownDefaultMs: 120000,
    endpoint: 'https://fapi.binance.com/fapi/v1/klines'
  });

  const body = document.getElementById('candidateBody');
  const button = document.getElementById('watchBtn');
  const mainStatus = document.getElementById('mainStatus');
  if (!body || !button) return;

  const cache = new Map();
  const signals = new Map();
  let active = false;
  let running = false;
  let rerunRequested = false;
  let timer = null;
  let mutationTimer = null;
  let cycleController = null;
  let cooldownUntil = 0;

  const now = () => Date.now();
  const finite = value => Number.isFinite(Number(value));
  const last = arr => arr?.[arr.length - 1];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function setMainStatus(message, cls = 'info') {
    if (!mainStatus) return;
    mainStatus.textContent = message;
    mainStatus.classList.remove('good', 'warn', 'bad', 'info');
    if (cls) mainStatus.classList.add(cls);
  }

  function symbolOf(tr) {
    const raw = tr?.dataset?.symbol
      || tr?.querySelector('[data-symbol]')?.getAttribute('data-symbol')
      || tr?.querySelector('.symbolBtn')?.textContent
      || tr?.children?.[1]?.textContent
      || '';
    return String(raw).trim().toUpperCase();
  }

  function isSelectRow(tr) {
    if (!tr || !tr.matches('tr[data-symbol]')) return false;
    if (tr.querySelector('.pill.select')) return true;
    const resultText = String(
      tr.querySelector('td .pill')?.textContent
      || tr.children?.[4]?.textContent
      || tr.children?.[3]?.textContent
      || ''
    ).trim().toUpperCase();
    return resultText === 'SELECT' || resultText.startsWith('SELECT ');
  }

  function ensureWatchCell(tr) {
    if (!tr || tr.querySelector('td.empty')) return null;
    let cell = tr.querySelector('td[data-role="watch-status"]');
    if (cell) return cell;

    cell = document.createElement('td');
    cell.className = 'watchCell';
    cell.dataset.role = 'watch-status';

    // UI only: Watch column belongs immediately after YS (after the 3rd TD).
    // No Watch signal/decision rule is changed here.
    const cells = Array.from(tr.children).filter(el => el.tagName === 'TD');
    const afterYs = cells[3] || null;
    if (afterYs) tr.insertBefore(cell, afterYs);
    else tr.appendChild(cell);
    return cell;
  }

  function renderSignal(tr, signal) {
    const cell = ensureWatchCell(tr);
    if (!cell) return;

    const current = signal || { status: 'OFF', label: '—', reason: 'Watch kapalı', at: 0 };
    const status = String(current.status || 'OFF').toUpperCase();
    const css = status === 'GREEN' ? 'green' : status === 'RED' ? 'red' : status === 'YELLOW' ? 'yellow' : 'off';

    cell.replaceChildren();
    const badge = document.createElement('span');
    badge.className = `watchSignal ${css}`;
    badge.setAttribute('aria-label', current.label || status);
    badge.title = current.reason || '';

    const dot = document.createElement('span');
    dot.className = 'watchSignalDot';
    dot.setAttribute('aria-hidden', 'true');
    badge.appendChild(dot);

    const text = document.createElement('span');
    text.textContent = current.label || (status === 'GREEN' ? 'ENTRY' : status === 'RED' ? 'NO ENTRY' : status === 'YELLOW' ? 'WAIT' : '—');
    badge.appendChild(text);
    cell.appendChild(badge);

    if (current.at) {
      const t = document.createElement('div');
      t.className = 'watchSignalTime';
      t.textContent = new Intl.DateTimeFormat('tr-TR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(new Date(current.at));
      cell.appendChild(t);
    }
  }

  function syncCells() {
    body.querySelectorAll('td.empty').forEach(td => { td.colSpan = 16; });
    body.querySelectorAll('tr[data-symbol]').forEach(tr => {
      const symbol = symbolOf(tr);
      if (!symbol) return;
      if (!isSelectRow(tr)) {
        const cell = ensureWatchCell(tr);
        if (cell) {
          cell.replaceChildren();
          const badge = document.createElement('span');
          badge.className = 'watchSignal off';
          badge.title = 'Watch yalnız SELECT satırlarını değerlendirir.';
          const dot = document.createElement('span');
          dot.className = 'watchSignalDot';
          badge.appendChild(dot);
          const text = document.createElement('span');
          text.textContent = '—';
          badge.appendChild(text);
          cell.appendChild(badge);
        }
        return;
      }
      const signal = signals.get(symbol);
      renderSignal(tr, signal || (active
        ? { status: 'YELLOW', label: 'WAIT', reason: 'İlk Watch kontrolü bekleniyor.', at: 0 }
        : null));
    });
  }

  function parseBars(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(k => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6])
    })).filter(b => [b.open, b.high, b.low, b.close].every(Number.isFinite));
  }

  function closedBars(bars) {
    const t = now();
    return bars.filter(b => b.closeTime < t);
  }

  function emaSeries(values, period) {
    if (!values?.length) return [];
    const alpha = 2 / (period + 1);
    const out = new Array(values.length);
    let e = Number(values[0]);
    out[0] = e;
    for (let i = 1; i < values.length; i++) {
      e = Number(values[i]) * alpha + e * (1 - alpha);
      out[i] = e;
    }
    return out;
  }

  function macd(values) {
    const e12 = emaSeries(values, 12);
    const e26 = emaSeries(values, 26);
    const line = values.map((_, i) => e12[i] - e26[i]);
    const signal = emaSeries(line, 9);
    const hist = line.map((v, i) => v - signal[i]);
    return { line, signal, hist };
  }

  function atr(bars, period = 14) {
    if (!bars || bars.length < 2) return NaN;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      const pc = bars[i - 1].close;
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
    }
    const slice = trs.slice(-period);
    return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : NaN;
  }

  function pivots(bars, kind, left = 2, right = 2) {
    const result = [];
    const field = kind === 'low' ? 'low' : 'high';
    for (let i = left; i < bars.length - right; i++) {
      const v = bars[i][field];
      let ok = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (kind === 'low' ? bars[j][field] <= v : bars[j][field] >= v) { ok = false; break; }
      }
      if (ok) result.push({ index: i, value: v, time: bars[i].closeTime });
    }
    return result;
  }

  function maxHigh(bars) {
    return bars.reduce((m, b) => Math.max(m, b.high), -Infinity);
  }

  function cacheKey(symbol, interval) {
    return `${symbol}|${interval}`;
  }

  async function fetchKlines(symbol, interval, signal) {
    const key = cacheKey(symbol, interval);
    const cached = cache.get(key);
    const ttl = CONFIG.cacheTtl[interval] || 15000;
    if (cached && now() - cached.at < ttl) return cached.bars;

    if (cooldownUntil > now()) {
      const seconds = Math.ceil((cooldownUntil - now()) / 1000);
      const error = new Error(`İstek bekleme süresi aktif (${seconds} sn).`);
      error.code = 'COOLDOWN';
      throw error;
    }

    const controller = new AbortController();
    const abortForward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortForward, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    try {
      const qs = new URLSearchParams({
        symbol,
        interval,
        limit: String(CONFIG.limits[interval] || 80)
      });
      const response = await fetch(`${CONFIG.endpoint}?${qs}`, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });

      if (response.status === 418 || response.status === 429) {
        const retryHeader = Number(response.headers.get('Retry-After'));
        const retryMs = Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader * 1000
          : CONFIG.cooldownDefaultMs;
        cooldownUntil = now() + Math.max(CONFIG.cooldownDefaultMs, retryMs);
        const error = new Error('Public veri servisi istek sınırı verdi; Watch otomatik beklemeye geçti.');
        error.code = 'RATE_LIMIT';
        throw error;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const bars = parseBars(payload);
      cache.set(key, { at: now(), bars });
      return bars;
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abortForward);
    }
  }

  async function evaluate(symbol, signal) {
    const [bars15, bars5, bars1] = await Promise.all([
      fetchKlines(symbol, '15m', signal),
      fetchKlines(symbol, '5m', signal),
      fetchKlines(symbol, '1m', signal)
    ]);

    const c15 = closedBars(bars15);
    const c5 = closedBars(bars5);
    const c1 = closedBars(bars1);
    if (c15.length < CONFIG.minClosedBars['15m'] || c5.length < CONFIG.minClosedBars['5m'] || c1.length < CONFIG.minClosedBars['1m']) {
      return { status: 'YELLOW', label: 'WAIT', reason: 'Yeterli kapanmış mum verisi henüz yok.', at: now() };
    }

    const live1 = last(bars1) || last(c1);
    const currentPrice = Number(live1?.close ?? last(c1)?.close);
    if (!Number.isFinite(currentPrice)) {
      return { status: 'YELLOW', label: 'WAIT', reason: 'Anlık fiyat okunamadı.', at: now() };
    }

    // ---------- 15m LONG context ----------
    const closes15 = c15.map(b => b.close);
    const ema20_15s = emaSeries(closes15, 20);
    const ema50_15s = emaSeries(closes15, 50);
    const macd15 = macd(closes15);
    const atr15 = atr(c15, 14);
    const ema20_15 = last(ema20_15s);
    const ema50_15 = last(ema50_15s);
    const ema20_15_prev = ema20_15s[Math.max(0, ema20_15s.length - 4)];
    const close15 = last(c15).close;
    const hist15 = last(macd15.hist);
    const hist15Prev = macd15.hist[macd15.hist.length - 2];
    const lows15 = pivots(c15, 'low');
    const lastLow15 = last(lows15);
    const prevLow15 = lows15[lows15.length - 2];
    const hl15 = !!(lastLow15 && prevLow15 && lastLow15.value > prevLow15.value);
    const emaSlope15Up = ema20_15 > ema20_15_prev;
    const emaSlope15Down = ema20_15 < ema20_15_prev;
    const hardBreak15 = !!(lastLow15 && Number.isFinite(atr15) && close15 < lastLow15.value - atr15 * 0.08);
    const strongBear15 = ema20_15 < ema50_15 && emaSlope15Down && close15 < ema20_15 && hist15 < 0 && hist15 <= hist15Prev;
    const bullish15 = ema20_15 > ema50_15 && emaSlope15Up && close15 > ema20_15;
    const transition15 = hl15 && emaSlope15Up && close15 >= ema20_15 * 0.998 && hist15 > hist15Prev;
    const longContext15 = bullish15 || transition15;

    if (hardBreak15 || strongBear15) {
      return {
        status: 'RED',
        label: 'NO ENTRY',
        reason: hardBreak15
          ? '15m LONG yapısı kırılmış durumda; yeni yapı kurulmadan giriş yok.'
          : '15m EMA/MACD yapısı aktif olarak aşağı yönlü; LONG giriş yok.',
        at: now(),
        price: currentPrice
      };
    }

    // ---------- 5m pullback + HL ----------
    const closes5 = c5.map(b => b.close);
    const ema20_5s = emaSeries(closes5, 20);
    const ema20_5 = last(ema20_5s);
    const atr5 = atr(c5, 14);
    const lows5 = pivots(c5, 'low');
    const highs5 = pivots(c5, 'high');

    // Confirmed HL is kept for structure protection / RED decisions.
    // pivots(..., right=2) deliberately waits for two candles on the right.
    const confirmedHlLow = last(lows5);
    const prevConfirmedHlLow = lows5[lows5.length - 2];
    const hasConfirmedHL5 = !!(
      confirmedHlLow
      && prevConfirmedHlLow
      && confirmedHlLow.value > prevConfirmedHlLow.value + (Number.isFinite(atr5) ? atr5 * 0.02 : 0)
    );
    const confirmedHlRecent = !!(confirmedHlLow && confirmedHlLow.index >= c5.length - 11);

    // ENTRY timing must not wait another two 5m candles. At every 5m close,
    // treat the latest closed candle's low as a candidate HL when it remains
    // above the latest confirmed structural low. The later 1m breakout/momentum
    // trigger is the confirmation that price has actually started to accelerate up.
    const candidateIndex5 = c5.length - 1;
    const candidateBar5 = last(c5);
    const candidateBaseLow5 = confirmedHlLow;
    const candidateTolerance5 = Number.isFinite(atr5) ? atr5 * 0.02 : 0;
    const candidateHL5 = !!(
      candidateBar5
      && candidateBaseLow5
      && candidateBar5.low > candidateBaseLow5.value + candidateTolerance5
    ) ? {
      index: candidateIndex5,
      value: candidateBar5.low,
      time: candidateBar5.closeTime,
      candidate: true
    } : null;

    const candidateIntact5 = !!(
      candidateHL5
      && Number.isFinite(atr5)
      && currentPrice >= candidateHL5.value - atr5 * 0.08
    );

    // Candidate HL has priority for ENTRY timing because it is the freshest closed
    // 5m information. If it is not available/intact, fall back to confirmed HL.
    const entryHlLow = candidateIntact5
      ? candidateHL5
      : (hasConfirmedHL5 ? confirmedHlLow : null);
    const hasHL5 = !!entryHlLow;
    const hlRecent = !!entryHlLow && (entryHlLow.candidate || confirmedHlRecent);

    const peakBeforeHL = entryHlLow ? last(highs5.filter(h => h.index < entryHlLow.index)) : null;
    const fallbackHigh = entryHlLow
      ? maxHigh(c5.slice(Math.max(0, entryHlLow.index - 10), entryHlLow.index + 1))
      : maxHigh(c5.slice(-12));
    const peak = peakBeforeHL?.value ?? fallbackHigh;
    const pullbackAtr = Number.isFinite(atr5) && atr5 > 0 && entryHlLow && Number.isFinite(peak)
      ? (peak - entryHlLow.value) / atr5
      : NaN;
    const pullbackSeen = Number.isFinite(pullbackAtr) && pullbackAtr >= 0.25 && pullbackAtr <= 3.0;

    // Structural RED still uses only the confirmed pivot low, not the candidate HL.
    const breakHL5 = !!(
      confirmedHlLow
      && Number.isFinite(atr5)
      && currentPrice < confirmedHlLow.value - atr5 * 0.08
    );
    const reclaim5 = currentPrice >= ema20_5;

    if (breakHL5) {
      return {
        status: 'RED',
        label: 'NO ENTRY',
        reason: '5m son HL aşağı kırıldı; yeni pullback/HL yapısı kurulmadan LONG giriş yok.',
        at: now(),
        price: currentPrice
      };
    }

    // ---------- 1m live re-acceleration trigger ----------
    const closes1Live = c1.map(b => b.close);
    if (bars1.length && last(bars1).closeTime >= now()) closes1Live.push(currentPrice);
    const ema9_1 = last(emaSeries(closes1Live, 9));
    const ema20_1 = last(emaSeries(closes1Live, 20));
    const macd1 = macd(closes1Live);
    const hist1 = last(macd1.hist);
    const hist1Prev = macd1.hist[macd1.hist.length - 2];
    const atr1 = atr(c1, 14);
    const microWindow = c1.slice(-4);
    const microHigh = maxHigh(microWindow);
    const breakout1 = Number.isFinite(microHigh) && currentPrice > microHigh + (Number.isFinite(atr1) ? atr1 * 0.01 : 0);
    const momentum1 = ema9_1 > ema20_1 && (hist1 > 0 || hist1 > hist1Prev);
    const trigger1 = breakout1 && momentum1;

    // Do not light GREEN after price has already run too far away from the HL/value area.
    const fromHlAtr = entryHlLow && Number.isFinite(atr5) && atr5 > 0 ? (currentPrice - entryHlLow.value) / atr5 : Infinity;
    const fromEmaAtr = Number.isFinite(atr5) && atr5 > 0 ? (currentPrice - ema20_5) / atr5 : Infinity;
    const noChase = fromHlAtr >= 0 && fromHlAtr <= 1.60 && fromEmaAtr <= 0.90;

    if (longContext15 && hasHL5 && hlRecent && pullbackSeen && reclaim5 && trigger1 && noChase) {
      return {
        status: 'GREEN',
        label: 'ENTRY',
        reason: `LONG timing hazır: 15m yapı uygun • 5m ${entryHlLow?.candidate ? 'candidate HL' : 'confirmed HL'}/pullback tamam • 1m yukarı trigger aktif • uzama ${fromHlAtr.toFixed(2)} ATR.`,
        at: now(),
        price: currentPrice,
        metrics: { pullbackAtr, fromHlAtr, fromEmaAtr, hlType: entryHlLow?.candidate ? 'candidate' : 'confirmed' }
      };
    }

    const waits = [];
    if (!longContext15) waits.push('15m LONG dönüş/trend teyidi');
    if (!hasHL5 || !hlRecent || !pullbackSeen) waits.push('5m güncel pullback + HL');
    if (hasHL5 && hlRecent && pullbackSeen && !reclaim5) waits.push('5m EMA20 geri alımı');
    if (longContext15 && hasHL5 && hlRecent && pullbackSeen && reclaim5 && !trigger1) waits.push('1m yeniden yukarı kırılım');
    if (!noChase && hasHL5 && hlRecent) waits.push('yeni pullback (hareket uzamış)');

    return {
      status: 'YELLOW',
      label: 'WAIT',
      reason: `Bekle: ${waits.join(' • ') || 'giriş şartları tamamlanmadı'}.`,
      at: now(),
      price: currentPrice,
      metrics: {
        pullbackAtr: Number.isFinite(pullbackAtr) ? pullbackAtr : null,
        fromHlAtr: Number.isFinite(fromHlAtr) ? fromHlAtr : null,
        fromEmaAtr: Number.isFinite(fromEmaAtr) ? fromEmaAtr : null,
        hlType: entryHlLow?.candidate ? 'candidate' : (entryHlLow ? 'confirmed' : null)
      }
    };
  }

  function selectRows() {
    return Array.from(body.querySelectorAll('tr[data-symbol]'))
      .filter(isSelectRow)
      .map(tr => ({ tr, symbol: symbolOf(tr) }))
      .filter(x => x.symbol);
  }

  function rowsForSymbol(symbol) {
    return Array.from(body.querySelectorAll('tr[data-symbol]')).filter(tr => symbolOf(tr) === symbol);
  }

  function publish(symbol, result) {
    signals.set(symbol, result);
    rowsForSymbol(symbol).forEach(tr => renderSignal(tr, result));
    window.dispatchEvent(new CustomEvent('watch:signal', { detail: { symbol, ...result } }));
  }

  async function processQueue(items, signal) {
    let cursor = 0;
    const workerCount = clamp(CONFIG.concurrency, 1, Math.max(1, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length && !signal.aborted) {
        const item = items[cursor++];
        publish(item.symbol, {
          status: 'YELLOW', label: 'WAIT', reason: 'Watch kontrol ediyor…', at: signals.get(item.symbol)?.at || 0
        });
        try {
          const result = await evaluate(item.symbol, signal);
          if (!signal.aborted) publish(item.symbol, result);
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') return;
          const rateLimited = error?.code === 'RATE_LIMIT' || error?.code === 'COOLDOWN';
          publish(item.symbol, {
            status: 'YELLOW',
            label: 'WAIT',
            reason: rateLimited
              ? error.message
              : `Veri yenilenemedi; yanlış ENTRY vermemek için WAIT. ${error?.message || error}`,
            at: now()
          });
        }
      }
    });
    await Promise.all(workers);
  }

  async function runCycle() {
    if (!active) return;
    if (running) { rerunRequested = true; return; }

    const items = selectRows();
    syncCells();
    if (!items.length) {
      button.title = 'Watch aktif ancak grid üzerinde SELECT satırı yok.';
      return;
    }

    running = true;
    rerunRequested = false;
    cycleController = new AbortController();
    button.disabled = false;

    try {
      await processQueue(items, cycleController.signal);
      if (!cycleController.signal.aborted) {
        const values = items.map(x => signals.get(x.symbol)).filter(Boolean);
        const green = values.filter(x => x.status === 'GREEN').length;
        const yellow = values.filter(x => x.status === 'YELLOW').length;
        const red = values.filter(x => x.status === 'RED').length;
        button.title = `Watch aktif • ENTRY ${green} • WAIT ${yellow} • NO ENTRY ${red}`;
      }
    } finally {
      running = false;
      cycleController = null;
      if (active && rerunRequested) {
        rerunRequested = false;
        queueMicrotask(runCycle);
      }
    }
  }

  function scheduleNext() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (active) runCycle(); }, CONFIG.cycleMs);
  }

  function start() {
    const items = selectRows();
    if (!items.length) {
      syncCells();
      setMainStatus('Watch başlatılamadı: grid üzerinde SELECT satırı yok.', 'warn');
      return false;
    }
    active = true;
    button.textContent = 'Stop Watch';
    button.classList.add('watchActiveBtn');
    button.setAttribute('aria-pressed', 'true');
    items.forEach(({ tr, symbol }) => renderSignal(tr, signals.get(symbol) || {
      status: 'YELLOW', label: 'WAIT', reason: 'İlk Watch kontrolü bekleniyor.', at: 0
    }));
    scheduleNext();
    runCycle();
    window.dispatchEvent(new CustomEvent('watch:started'));
    return true;
  }

  function stop() {
    active = false;
    rerunRequested = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (cycleController) cycleController.abort();
    cycleController = null;
    button.textContent = 'Watch';
    button.classList.remove('watchActiveBtn');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Griddeki SELECT coinleri her zaman LONG giriş zamanlaması için izler';
    window.dispatchEvent(new CustomEvent('watch:stopped'));
  }

  button.addEventListener('click', () => {
    if (active) stop();
    else start();
  });

  const observer = new MutationObserver(mutations => {
    // Ignore DOM mutations produced only by Watch's own status cell. This
    // prevents an observer/render loop while still reacting to scanner or
    // Follow row replacements.
    const externalMutation = mutations.some(m => {
      const target = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
      return !target?.closest?.('td[data-role="watch-status"]');
    });
    if (!externalMutation) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      syncCells();
      if (active) runCycle();
    }, 120);
  });
  observer.observe(body, { childList: true, subtree: true });

  syncCells();
  button.setAttribute('aria-pressed', 'false');

  window.Watch = Object.freeze({
    start,
    stop,
    scanNow: runCycle,
    analyzeSymbol: async symbol => evaluate(String(symbol || '').trim().toUpperCase(), new AbortController().signal),
    getState: () => ({
      active,
      running,
      cooldownUntil,
      signals: Object.fromEntries(Array.from(signals.entries()))
    }),
    config: CONFIG
  });
})();
