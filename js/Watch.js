/*
 * Watch.js — LONG entry timing layer
 * ------------------------------------------------------------
 * Purpose:
 *   - Reads SELECT rows already present in #candidateBody.
 *   - Does NOT select coins and does NOT modify scanner logic.
 *   - Does NOT modify Follow state, inputs, buttons, timers or decisions.
 *   - Assumes the SELECT stage already handled higher-timeframe direction/context.
 *   - Watch itself only handles short-term LONG entry timing with 3m + 1m.
 *
 * Signal meaning:
 *   GREEN  / ENTRY    -> LONG entry timing is currently ready.
 *   YELLOW / WAIT     -> Candidate is still valid but timing is not ready.
 *   RED    / NO ENTRY -> Current LONG structure is invalid / actively bearish.
 *
 * Public REST usage is intentionally cached:
 *   1m refresh ~15s, 3m ~30s.
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    cycleMs: 15000,
    requestTimeoutMs: 9000,
    concurrency: 4,
    cacheTtl: Object.freeze({ '1m': 12000, '3m': 30000 }),
    limits: Object.freeze({ '1m': 80, '3m': 90 }),
    minClosedBars: Object.freeze({ '1m': 45, '3m': 55 }),
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
    const [bars3, bars1] = await Promise.all([
      fetchKlines(symbol, '3m', signal),
      fetchKlines(symbol, '1m', signal)
    ]);

    const c3 = closedBars(bars3);
    const c1 = closedBars(bars1);
    if (
      c3.length < CONFIG.minClosedBars['3m']
      || c1.length < CONFIG.minClosedBars['1m']
    ) {
      return { status: 'YELLOW', label: 'WAIT', reason: 'Yeterli kapanmış mum verisi henüz yok.', at: now() };
    }

    const live1 = last(bars1) || last(c1);
    const currentPrice = Number(live1?.close ?? last(c1)?.close);
    if (!Number.isFinite(currentPrice)) {
      return { status: 'YELLOW', label: 'WAIT', reason: 'Anlık fiyat okunamadı.', at: now() };
    }

    // ---------- 3m structure + pullback + candidate HL + EMA20 reclaim ----------
    // Higher-timeframe direction/context is assumed to have been validated by SELECT.
    // Watch therefore uses 3m as its complete setup/timing layer.
    const closes3 = c3.map(b => b.close);
    const ema20_3s = emaSeries(closes3, 20);
    const ema20_3 = last(ema20_3s);
    const atr3 = atr(c3, 14);
    const lows3 = pivots(c3, 'low');
    const highs3 = pivots(c3, 'high');

    // Confirmed 3m pivot lows remain the structural safety reference.
    // If price breaks the latest confirmed structural low, do not allow LONG entry.
    const confirmedHlLow3 = last(lows3);
    const breakStructure3 = !!(
      confirmedHlLow3
      && Number.isFinite(atr3)
      && currentPrice < confirmedHlLow3.value - atr3 * 0.08
    );

    if (breakStructure3) {
      return {
        status: 'RED',
        label: 'NO ENTRY',
        reason: '3m yapısal dip aşağı kırıldı; yeni yapı kurulmadan LONG giriş yok.',
        at: now(),
        price: currentPrice
      };
    }

    // Confirmed 3m HL remains available as a fallback. For entry timing, the
    // latest CLOSED 3m candle is treated as a candidate HL when its low remains
    // above the latest confirmed structural low. This avoids waiting for two
    // future 3m candles before Watch can react.
    const prevConfirmedHlLow3 = lows3[lows3.length - 2];
    const hasConfirmedHL3 = !!(
      confirmedHlLow3
      && prevConfirmedHlLow3
      && confirmedHlLow3.value > prevConfirmedHlLow3.value + (Number.isFinite(atr3) ? atr3 * 0.02 : 0)
    );
    const confirmedHlRecent3 = !!(confirmedHlLow3 && confirmedHlLow3.index >= c3.length - 14);

    const candidateIndex3 = c3.length - 1;
    const candidateBar3 = last(c3);
    const candidateTolerance3 = Number.isFinite(atr3) ? atr3 * 0.02 : 0;
    const candidateHL3 = !!(
      candidateBar3
      && confirmedHlLow3
      && candidateBar3.low > confirmedHlLow3.value + candidateTolerance3
    ) ? {
      index: candidateIndex3,
      value: candidateBar3.low,
      time: candidateBar3.closeTime,
      candidate: true
    } : null;

    const candidateIntact3 = !!(
      candidateHL3
      && Number.isFinite(atr3)
      && currentPrice >= candidateHL3.value - atr3 * 0.08
    );

    const entryHlLow3 = candidateIntact3
      ? candidateHL3
      : (hasConfirmedHL3 ? confirmedHlLow3 : null);
    const hasHL3 = !!entryHlLow3;
    const hlRecent3 = !!entryHlLow3 && (entryHlLow3.candidate || confirmedHlRecent3);

    const peakBeforeHL3 = entryHlLow3 ? last(highs3.filter(h => h.index < entryHlLow3.index)) : null;
    const fallbackHigh3 = entryHlLow3
      ? maxHigh(c3.slice(Math.max(0, entryHlLow3.index - 14), entryHlLow3.index + 1))
      : maxHigh(c3.slice(-16));
    const peak3 = peakBeforeHL3?.value ?? fallbackHigh3;
    const pullbackAtr3 = Number.isFinite(atr3) && atr3 > 0 && entryHlLow3 && Number.isFinite(peak3)
      ? (peak3 - entryHlLow3.value) / atr3
      : NaN;
    const pullbackSeen3 = Number.isFinite(pullbackAtr3) && pullbackAtr3 >= 0.25 && pullbackAtr3 <= 3.0;
    const reclaim3 = currentPrice >= ema20_3;

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

    // Do not light GREEN after price has already run too far away from the 3m
    // HL/value area. noChase is measured entirely in ATR3.
    const fromHlAtr3 = entryHlLow3 && Number.isFinite(atr3) && atr3 > 0
      ? (currentPrice - entryHlLow3.value) / atr3
      : Infinity;
    const fromEmaAtr3 = Number.isFinite(atr3) && atr3 > 0
      ? (currentPrice - ema20_3) / atr3
      : Infinity;
    const noChase3 = fromHlAtr3 >= 0 && fromHlAtr3 <= 1.60 && fromEmaAtr3 <= 0.90;

    if (hasHL3 && hlRecent3 && pullbackSeen3 && reclaim3 && trigger1 && noChase3) {
      return {
        status: 'GREEN',
        label: 'ENTRY',
        reason: `LONG timing hazır: 3m ${entryHlLow3?.candidate ? 'candidate HL' : 'confirmed HL'}/pullback + EMA20 uygun • 1m yukarı trigger aktif • uzama ${fromHlAtr3.toFixed(2)} ATR.`,
        at: now(),
        price: currentPrice,
        metrics: {
          pullbackAtr: pullbackAtr3,
          fromHlAtr: fromHlAtr3,
          fromEmaAtr: fromEmaAtr3,
          hlType: entryHlLow3?.candidate ? 'candidate' : 'confirmed',
          timingTf: '3m'
        }
      };
    }

    const waits = [];
    if (!hasHL3 || !hlRecent3 || !pullbackSeen3) waits.push('3m güncel pullback + HL');
    if (hasHL3 && hlRecent3 && pullbackSeen3 && !reclaim3) waits.push('3m EMA20 geri alımı');
    if (hasHL3 && hlRecent3 && pullbackSeen3 && reclaim3 && !trigger1) waits.push('1m yeniden yukarı kırılım');
    if (!noChase3 && hasHL3 && hlRecent3) waits.push('yeni 3m pullback (hareket uzamış)');

    return {
      status: 'YELLOW',
      label: 'WAIT',
      reason: `Bekle: ${waits.join(' • ') || 'giriş şartları tamamlanmadı'}.`,
      at: now(),
      price: currentPrice,
      metrics: {
        pullbackAtr: Number.isFinite(pullbackAtr3) ? pullbackAtr3 : null,
        fromHlAtr: Number.isFinite(fromHlAtr3) ? fromHlAtr3 : null,
        fromEmaAtr: Number.isFinite(fromEmaAtr3) ? fromEmaAtr3 : null,
        hlType: entryHlLow3?.candidate ? 'candidate' : (entryHlLow3 ? 'confirmed' : null),
        timingTf: '3m'
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
