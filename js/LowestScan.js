(() => {
  'use strict';

  // ================================================================
  // LOWEST SCAN MODULE
  // Purpose:
  //   Find active USDT-M symbols whose current price is MinY..MaxY %
  //   below the price approximately SEC seconds ago.
  //
  // Example:
  //   SEC=14400, MinY=3, MaxY=8 -> symbols down 3%..8% vs ~4h ago.
  //
  // Integration:
  //   - Uses the existing #windowSec / #minIncrease / #maxIncrease inputs.
  //   - Renders the existing candidate grid with Entry / Stop / Follow.
  //   - Keeps active Follow rows at the top and does not stop monitors.
  //   - Stores rows in CryptoOfferData.scanState.results so current Follow.js
  //     can capture and preserve LowestScan rows without modification.
  // ================================================================

  const BASE = 'https://fapi.binance.com';
  const MAX_SEC = 7 * 24 * 60 * 60; // 7 days, entered as seconds.
  const MIN_SEC = 60;               // Historical reference uses 1m candles.
  const CONCURRENCY = 6;
  const REQUEST_TIMEOUT_MS = 12000;
  const RETRIES = 2;

  let running = false;
  let controller = null;

  const $ = id => document.getElementById(id);
  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function fmtPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const digits = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtPct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(3)}%` : '—';
  }

  function fmtDuration(sec) {
    sec = Number(sec);
    if (!Number.isFinite(sec)) return '—';
    if (sec % 3600 === 0) return `${sec / 3600}h`;
    if (sec % 60 === 0) return `${sec / 60}m`;
    return `${sec}s`;
  }

  function fmtTime(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '—';
    return new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(n));
  }

  function setStatus(text, cls = 'info') {
    const el = $('mainStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('good', 'warn', 'bad', 'info');
    if (cls) el.classList.add(cls);
  }

  function setProgress(percent, stageText) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = $('progressBar');
    const text = $('progressText');
    const stage = $('stageText');
    if (bar) bar.style.width = `${p}%`;
    if (text) text.textContent = `${Math.round(p)}%`;
    if (stage) stage.textContent = stageText || 'LowestScan';
  }

  function log(message) {
    const el = $('logBox');
    if (!el) return;
    const t = new Date().toLocaleTimeString('tr-TR');
    el.textContent += `\n[${t}] ${message}`;
    el.scrollTop = el.scrollHeight;
  }

  async function fetchJson(path, { signal, retries = RETRIES, timeout = REQUEST_TIMEOUT_MS } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), timeout);
      const onAbort = () => timeoutController.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await fetch(`${BASE}${path}`, {
          signal: timeoutController.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });

        if (response.status === 418 || response.status === 429) {
          const retryAfter = Number(response.headers.get('Retry-After'));
          const error = new Error(`HTTP ${response.status}`);
          error.retryDelayMs = Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : 800 * Math.pow(2, attempt);
          throw error;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        return await response.json();
      } catch (error) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        lastError = error;
        if (attempt < retries) {
          const wait = Number.isFinite(error?.retryDelayMs)
            ? error.retryDelayMs
            : 350 * Math.pow(2, attempt);
          await sleep(wait);
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError || new Error(`Request failed: ${path}`);
  }

  function activeSymbols(exchangeInfo) {
    const symbols = Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [];
    return symbols
      .filter(s => s?.status === 'TRADING')
      .filter(s => s?.quoteAsset === 'USDT')
      .filter(s => s?.contractType === 'PERPETUAL')
      // 2026 USDM can also contain traditional-equity products. Keep this coin-only.
      .filter(s => !s?.underlyingType || s.underlyingType === 'COIN')
      .map(s => s.symbol)
      .filter(Boolean);
  }

  function tickerPriceMap(raw) {
    const map = new Map();
    for (const x of Array.isArray(raw) ? raw : []) {
      const p = num(x?.price);
      if (x?.symbol && p > 0) map.set(x.symbol, p);
    }
    return map;
  }

  function nearestReferencePrice(kline, targetTime) {
    if (!Array.isArray(kline) || kline.length < 7) return NaN;
    const openTime = num(kline[0]);
    const open = num(kline[1]);
    const close = num(kline[4]);
    const closeTime = num(kline[6]);
    if (!(open > 0) || !(close > 0)) return NaN;

    // Choose the closest available 1m endpoint to the requested timestamp.
    if (Number.isFinite(openTime) && Number.isFinite(closeTime)) {
      return Math.abs(targetTime - openTime) <= Math.abs(closeTime - targetTime) ? open : close;
    }
    return close;
  }

  async function referencePrice(symbol, targetTime, signal) {
    const minuteStart = Math.floor(targetTime / 60000) * 60000;
    const endTime = minuteStart + 60000 - 1;
    const path = `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${minuteStart}&endTime=${endTime}&limit=1`;
    const raw = await fetchJson(path, { signal });
    if (!Array.isArray(raw) || !raw.length) return null;
    const price = nearestReferencePrice(raw[0], targetTime);
    if (!(price > 0)) return null;
    return {
      price,
      candleOpenTime: num(raw[0][0]),
      candleCloseTime: num(raw[0][6])
    };
  }

  async function mapLimit(items, limit, worker, signal, onProgress) {
    const out = new Array(items.length);
    let next = 0;
    let done = 0;

    async function runWorker() {
      while (true) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const index = next++;
        if (index >= items.length) return;
        try {
          out[index] = await worker(items[index], index);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          out[index] = null;
        } finally {
          done++;
          onProgress?.(done, items.length);
        }
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
    await Promise.all(workers);
    return out;
  }

  function preservedFollowRows() {
    const rows = window.CryptoFlowScanner?.modules?.follow?.getPreservedRows?.();
    return Array.isArray(rows) ? rows.filter(r => r && typeof r.symbol === 'string') : [];
  }

  function genericReason(row) {
    if (row?.lowestScan?.reason) return row.lowestScan.reason;
    if (row?.chartAnalysis?.reason) return row.chartAnalysis.reason;
    if (Array.isArray(row?.reasons) && row.reasons.length) return row.reasons.join(' • ');
    return row?.result === 'SELECT' ? 'SELECT' : 'Active Follow';
  }

  function genericCurrentPrice(row) {
    const candidates = [
      row?.decisionPrice,
      row?.snapshot2,
      row?.price,
      row?.currentPrice,
      row?.referencePrice
    ];
    for (const x of candidates) {
      const n = num(x);
      if (n > 0) return n;
    }
    return NaN;
  }

  function resultPill(result) {
    const r = String(result || 'SELECT').toUpperCase();
    const cls = r === 'SELECT' ? 'select' : 'caution';
    return `<span class="pill ${cls}">${esc(r)}</span>`;
  }

  function renderRow(row, index) {
    const symbol = row.symbol;
    const reason = genericReason(row);
    const price = genericCurrentPrice(row);
    const drop = num(row?.lowestScan?.dropPct);
    const liveChange = Number.isFinite(drop) ? `Drop ${drop.toFixed(3)}%` : '';

    return `<tr data-symbol="${esc(symbol)}">
      <td>${index + 1}</td>
      <td class="symbol">${esc(symbol)}</td>
      <td><span class="ysMark unknown">—</span></td>
      <td>${resultPill(row.result || 'SELECT')}</td>
      <td class="decisionCell na">—</td>
      <td class="decisionCell na">—</td>
      <td><input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" placeholder="Entry Price" inputmode="decimal"></td>
      <td><input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" placeholder="Stop Price" inputmode="decimal"></td>
      <td class="num" data-role="current-price">${esc(fmtPrice(price))}</td>
      <td><button class="followBtn" data-action="follow" data-symbol="${esc(symbol)}" type="button">Follow</button></td>
      <td class="monitorCell"><span class="monitorDot off" title="OFF" aria-label="OFF"></span></td>
      <td class="monitorReason"><span class="reasonText" title="${esc(reason)}">${esc(reason)}</span><div class="monitorTime"></div></td>
      <td class="liveChangeCell" data-role="live-change">${esc(liveChange)}</td>
      <td class="liveResultCell" data-role="live-result"></td>
    </tr>`;
  }

  function syncScanState(rows, startedAt, completedAt, settings) {
    window.CryptoOfferData = window.CryptoOfferData || {};
    const state = window.CryptoOfferData.scanState || {};
    // Keep the original StartScan state object alive when it exists. Follow.js
    // already reads scanState.results, so no Follow.js change is required.
    state.results = rows;
    state.startedAt = startedAt;
    state.completedAt = completedAt;
    state.lowestScan = true;
    state.lowestScanSettings = settings;
    window.CryptoOfferData.scanState = state;

    window.CryptoOfferData.lowestScanState = {
      startedAt,
      completedAt,
      settings,
      results: rows.filter(r => r?.lowestScan)
    };
  }

  function renderResults(matches, startedAt, completedAt, settings) {
    const body = $('candidateBody');
    if (!body) return;

    const preserved = preservedFollowRows();
    const preservedSymbols = new Set(preserved.map(r => r.symbol));
    const fresh = matches.filter(r => !preservedSymbols.has(r.symbol));
    const rows = [...preserved, ...fresh];

    syncScanState(rows, startedAt, completedAt, settings);

    const title = $('candidateResponseTitle');
    if (title) title.textContent = `LowestScan - ${fmtTime(completedAt)}`;

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="14" class="empty">LowestScan: belirtilen düşüş aralığında coin bulunamadı.</td></tr>';
    } else {
      body.innerHTML = rows.map(renderRow).join('');
    }

    // Follow.js restores active task values/statuses after any grid re-render.
    document.dispatchEvent(new CustomEvent('cryptooffer:candidates-rendered'));
  }

  function readSettings() {
    const sec = num($('windowSec')?.value);
    const minDrop = num($('minIncrease')?.value);
    const maxDrop = num($('maxIncrease')?.value);

    if (!(sec >= MIN_SEC && sec <= MAX_SEC)) {
      throw new Error(`LowestScan için Sec. ${MIN_SEC}–${MAX_SEC} saniye arasında olmalı.`);
    }
    if (!(minDrop > 0 && minDrop <= 100)) {
      throw new Error('MinY 0–100% arasında pozitif olmalı.');
    }
    if (!(maxDrop > 0 && maxDrop <= 100)) {
      throw new Error('MaxY 0–100% arasında pozitif olmalı.');
    }
    if (maxDrop < minDrop) {
      throw new Error('MaxY, MinY değerinden küçük olamaz.');
    }

    return { sec: Math.round(sec), minDrop, maxDrop };
  }

  async function scan(customSettings = null) {
    if (running) return null;
    const settings = customSettings || readSettings();
    const startedAt = Date.now();

    running = true;
    controller = new AbortController();
    const signal = controller.signal;

    const button = $('lowestScanBtn');
    const cancelButton = $('cancelBtn');
    if (button) {
      button.disabled = true;
      button.textContent = 'LowestScan…';
    }
    if (cancelButton) cancelButton.disabled = false;

    // Keep current Follow monitors alive across this scan.
    document.dispatchEvent(new CustomEvent('cryptooffer:scan-start', {
      detail: { reason: 'New LowestScan', preserveFollow: true }
    }));

    setProgress(1, 'LowestScan');
    setStatus(`LowestScan: ${fmtDuration(settings.sec)} geçmiş fiyatı hazırlanıyor…`, 'info');

    try {
      const [timeRaw, exchangeInfo, tickerRaw] = await Promise.all([
        fetchJson('/fapi/v1/time', { signal }),
        fetchJson('/fapi/v1/exchangeInfo', { signal }),
        fetchJson('/fapi/v2/ticker/price', { signal })
      ]);

      const serverTime = num(timeRaw?.serverTime);
      if (!Number.isFinite(serverTime)) throw new Error('Server time alınamadı.');

      const symbols = activeSymbols(exchangeInfo);
      const prices = tickerPriceMap(tickerRaw);
      const eligible = symbols.filter(symbol => prices.has(symbol));
      const targetTime = serverTime - settings.sec * 1000;

      setProgress(5, 'Reference Prices');
      setStatus(`LowestScan: ${eligible.length} coin için ${fmtDuration(settings.sec)} önceki fiyat okunuyor…`, 'info');

      let requestErrors = 0;
      const rows = await mapLimit(
        eligible,
        CONCURRENCY,
        async symbol => {
          try {
            const ref = await referencePrice(symbol, targetTime, signal);
            if (!ref) return null;

            const currentPrice = prices.get(symbol);
            const changePct = ((currentPrice / ref.price) - 1) * 100;
            const dropPct = -changePct;

            if (!(dropPct >= settings.minDrop && dropPct <= settings.maxDrop)) return null;

            const reason = `${fmtDuration(settings.sec)}: ${fmtPrice(ref.price)} → ${fmtPrice(currentPrice)} • Drop ${dropPct.toFixed(3)}%`;
            return {
              symbol,
              result: 'SELECT',
              snapshot2: currentPrice,
              decisionPrice: currentPrice,
              price: currentPrice,
              fastChange: changePct,
              reasons: [reason],
              lowestScan: {
                sec: settings.sec,
                minDrop: settings.minDrop,
                maxDrop: settings.maxDrop,
                referencePrice: ref.price,
                currentPrice,
                changePct,
                dropPct,
                targetTime,
                referenceCandleOpenTime: ref.candleOpenTime,
                referenceCandleCloseTime: ref.candleCloseTime,
                reason
              }
            };
          } catch (error) {
            if (error?.name === 'AbortError') throw error;
            requestErrors++;
            return null;
          }
        },
        signal,
        (done, total) => {
          const pct = 5 + (done / Math.max(1, total)) * 90;
          setProgress(pct, `LowestScan ${done}/${total}`);
          if (done === total || done % 20 === 0) {
            setStatus(`LowestScan: ${done}/${total} incelendi…`, 'info');
          }
        }
      );

      const matches = rows
        .filter(Boolean)
        .sort((a, b) => b.lowestScan.dropPct - a.lowestScan.dropPct);

      const completedAt = Date.now();
      renderResults(matches, startedAt, completedAt, settings);
      setProgress(100, 'LowestScan Completed');
      setStatus(
        `LowestScan tamamlandı • ${fmtDuration(settings.sec)} • Drop ${settings.minDrop}%–${settings.maxDrop}% • ${matches.length} coin`,
        matches.length ? 'good' : 'warn'
      );
      log(`LowestScan complete: ${matches.length}/${eligible.length} match • request errors ${requestErrors}`);

      const detail = { startedAt, completedAt, settings, all: matches, select: matches, requestErrors };
      window.dispatchEvent(new CustomEvent('lowestscan:complete', { detail }));
      return detail;
    } catch (error) {
      if (error?.name === 'AbortError') {
        setProgress(0, 'LowestScan Cancelled');
        setStatus('LowestScan iptal edildi.', 'warn');
        window.dispatchEvent(new CustomEvent('lowestscan:cancelled'));
        return null;
      }

      console.error('LowestScan error:', error);
      setProgress(0, 'LowestScan Error');
      setStatus(`LowestScan hata: ${error?.message || error}`, 'bad');
      window.dispatchEvent(new CustomEvent('lowestscan:error', {
        detail: { message: error?.message || String(error) }
      }));
      throw error;
    } finally {
      running = false;
      controller = null;
      const button = $('lowestScanBtn');
      const cancelButton = $('cancelBtn');
      if (button) {
        button.disabled = false;
        button.textContent = 'LowestScan';
      }
      if (cancelButton) cancelButton.disabled = true;
    }
  }

  function cancel() {
    controller?.abort();
  }

  function bindUI() {
    const button = $('lowestScanBtn');
    const cancelButton = $('cancelBtn');
    if (!button) return;

    button.addEventListener('click', async () => {
      if (running) return;
      try {
        await scan();
      } catch (_) {
        // UI is already updated in scan().
      }
    });

    if (cancelButton) {
      cancelButton.addEventListener('click', () => {
        if (running) cancel();
      });
    }
  }

  window.LowestScan = {
    scan,
    cancel,
    get running() { return running; },
    config: Object.freeze({ minSec: MIN_SEC, maxSec: MAX_SEC, concurrency: CONCURRENCY })
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI, { once: true });
  } else {
    bindUI();
  }
})();
