(() => {
  'use strict';

  // Volume Increase Scan (Binance USD-M Futures)
  // ONLY selection criterion: quote trade volume in the last X seconds is
  // A%..B% above the immediately preceding X seconds. X, A and B are read
  // from the EXISTING Scan Settings inputs in index.html.
  // Stream data must be collected for two complete windows before evaluating.
  // This module does not create an additional panel or modify other scanners.

  const EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  const WS_BASES = [
    'wss://fstream.binance.com/market/stream?streams=',
    'wss://fstream.binance.com/stream?streams='
  ];
  const STREAMS_PER_SOCKET = 90;
  const AUTO_REFRESH_MS = 15000; // Only for Volume Increase Scan when #autoScan is checked.
  const RECONNECT_DELAY_MS = 2500;
  const CONNECT_TIMEOUT_MS = 16000;
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const fmt = (value, digits = 2) => Number.isFinite(value)
    ? Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : '—';
  const money = value => Number.isFinite(value)
    ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '—';

  const state = {
    running: false,
    token: 0,
    streamGeneration: 0,
    symbols: new Set(),
    // Each symbol has one quote-volume accumulator per elapsed second.
    // This avoids keeping thousands of individual aggTrade messages in memory.
    volumes: new Map(),
    sockets: [],
    expectedSockets: 0,
    openSockets: 0,
    wsBaseIndex: 0,
    timer: null,
    reconnectTimer: null,
    connectTimeout: null,
    startedAt: 0,
    readySince: 0,
    receivedTrades: 0,
    settings: null,
    cancelWasDisabled: true,
    lastRows: [],
    lastError: '',
    lastSnapshotAt: 0,
    nextSnapshotAt: 0
  };

  function show(message, kind = 'info', stage = 'Volume Scan', progress = null) {
    const status = $('mainStatus');
    if (status) {
      status.textContent = message;
      status.classList.remove('good', 'warn', 'bad', 'info');
      status.classList.add(kind);
    }
    if ($('stageText')) $('stageText').textContent = stage;
    if (progress !== null) {
      const percent = Math.max(0, Math.min(100, progress));
      if ($('progressText')) $('progressText').textContent = `${Math.round(percent)}%`;
      if ($('progressBar')) $('progressBar').style.width = `${percent}%`;
    }
  }

  function setGridPlaceholder(message) {
    if ($('candidateResponseTitle')) $('candidateResponseTitle').textContent = 'Volume Increase Scan';
    const body = $('candidateBody');
    if (body) {
      // Existing table has exactly sixteen columns; do not create another table.
      body.innerHTML = `<tr><td colspan="16" class="empty">${escapeHtml(message)}</td></tr>`;
    }
  }

  function readSettings() {
    const sec = Number($('windowSec')?.value);
    const min = Number($('minIncrease')?.value);
    const max = Number($('maxIncrease')?.value);
    if (!Number.isInteger(sec) || sec < 1 || sec > 604800) {
      throw new Error('Scan Settings: Sec. 1–604800 arasında tam sayı olmalı.');
    }
    if (!Number.isFinite(min) || min < 0 || min > 100) {
      throw new Error('Scan Settings: MinY% 0–100 arasında olmalı.');
    }
    if (!Number.isFinite(max) || max < min || max > 100) {
      throw new Error('Scan Settings: MaxY% en az MinY% kadar ve en fazla 100 olmalı.');
    }
    return { windowSec: sec, minIncrease: min, maxIncrease: max };
  }

  function setControls(running) {
    const button = $('volumeIncreaseScanBtn');
    if (button) {
      button.textContent = running ? 'Stop Volume Scan' : 'Volume Increase Scan';
      button.classList.toggle('danger', running);
      button.title = running ? 'Hacim taramasını durdurur' : 'Scan Settings değerlerini kullanarak hacim taramasını başlatır';
    }
    const cancel = $('cancelBtn');
    if (cancel && running) {
      state.cancelWasDisabled = cancel.disabled;
      cancel.disabled = false;
    } else if (cancel && state.cancelWasDisabled) {
      cancel.disabled = true;
    }
  }

  async function loadSymbols() {
    const response = await fetch(EXCHANGE_INFO, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Binance exchangeInfo HTTP ${response.status}`);
    const json = await response.json();
    const symbols = (json.symbols || [])
      .filter(x => x.status === 'TRADING' && x.contractType === 'PERPETUAL' &&
        x.quoteAsset === 'USDT' && x.marginAsset === 'USDT')
      .map(x => x.symbol);
    if (!symbols.length) throw new Error('Binance USDT perpetual coin listesi boş döndü.');
    return new Set(symbols);
  }

  function autoEnabled() {
    return $('autoScan')?.checked === true;
  }

  function closeSockets() {
    for (const socket of state.sockets) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch (_) { /* close is best effort */ }
    }
    state.sockets = [];
    state.openSockets = 0;
    if (state.connectTimeout !== null) clearTimeout(state.connectTimeout);
    state.connectTimeout = null;
  }

  function recordTrade(trade) {
    if (!trade || !state.symbols.has(trade.s)) return;
    if (trade.e !== 'aggTrade') return;
    const t = Number(trade.T);
    const price = Number(trade.p);
    const quantity = Number(trade.q);
    const now = Date.now();
    if (!Number.isFinite(t) || t > now + 2000 || t < now - state.settings.windowSec * 2000 - 2000 ||
        !(price > 0) || !(quantity > 0)) return;
    // Binance aggTrade: p * q = USDT traded. This is volume, NOT price growth.
    const second = Math.floor(t / 1000);
    let coin = state.volumes.get(trade.s);
    if (!coin) {
      coin = { seconds: new Map(), lastPrice: price };
      state.volumes.set(trade.s, coin);
    }
    coin.seconds.set(second, (coin.seconds.get(second) || 0) + price * quantity);
    coin.lastPrice = price;
    state.receivedTrades++;
  }

  function onMessage(event) {
    try {
      const parsed = JSON.parse(event.data);
      // Combined streams carry { stream, data: { e:'aggTrade', ... } }.
      const payload = parsed?.data ?? parsed;
      if (Array.isArray(payload)) payload.forEach(recordTrade);
      else recordTrade(payload);
    } catch (_) { /* ignore malformed frames and subscribe ACKs */ }
  }

  function scheduleReconnect(message) {
    if (!state.running || state.reconnectTimer !== null) return;
    closeSockets();
    state.volumes.clear();
    state.receivedTrades = 0;
    state.readySince = 0;
    state.lastRows = [];
    state.lastSnapshotAt = 0;
    state.nextSnapshotAt = 0;
    // Try the alternate official-compatible URL form on next attempt.
    state.wsBaseIndex = (state.wsBaseIndex + 1) % WS_BASES.length;
    show(`Volume Scan: ${message} Yeniden bağlanılıyor; hacim pencereleri yeniden doldurulacak.`,
      'warn', 'Reconnecting', 0);
    setGridPlaceholder('Binance bağlantısı yenileniyor. Hacim verileri yeniden toplanıyor…');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.running) openStreams();
    }, RECONNECT_DELAY_MS);
  }

  function openStreams() {
    if (!state.running) return;
    const generation = ++state.streamGeneration;
    const names = [...state.symbols];
    const groups = [];
    for (let i = 0; i < names.length; i += STREAMS_PER_SOCKET) {
      groups.push(names.slice(i, i + STREAMS_PER_SOCKET));
    }
    state.expectedSockets = groups.length;
    state.openSockets = 0;
    state.readySince = 0;
    state.volumes.clear();
    state.receivedTrades = 0;
    state.lastSnapshotAt = 0;
    state.nextSnapshotAt = 0;

    try {
      groups.forEach(group => {
        const streams = group.map(s => `${s.toLowerCase()}@aggTrade`).join('/');
        const socket = new WebSocket(WS_BASES[state.wsBaseIndex] + streams);
        state.sockets.push(socket);
        socket.onopen = () => {
          if (!state.running || generation !== state.streamGeneration) return;
          state.openSockets++;
          if (state.openSockets === state.expectedSockets) {
            state.readySince = Date.now();
            show(`Volume Scan: ${names.length} coin, ${state.openSockets} WS bağlantısı hazır. ` +
              `İki adet ${state.settings.windowSec}s hacim penceresi toplanıyor…`,
              'info', 'Collecting Volume', 0);
          }
        };
        socket.onmessage = event => {
          if (state.running && generation === state.streamGeneration) onMessage(event);
        };
        socket.onerror = () => {
          // onclose normally follows; the timeout also handles stuck connects.
        };
        socket.onclose = event => {
          if (state.running && generation === state.streamGeneration) {
            scheduleReconnect(`WebSocket kapandı (code ${event.code || 'unknown'}).`);
          }
        };
      });
    } catch (error) {
      scheduleReconnect(`Bağlantı hatası: ${error.message || error}.`);
      return;
    }

    state.connectTimeout = setTimeout(() => {
      if (state.running && generation === state.streamGeneration &&
          state.openSockets < state.expectedSockets) {
        scheduleReconnect('Bazı WebSocket bağlantıları açılamadı.');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  function computeRows(now = Date.now()) {
    const nowSec = Math.floor(now / 1000);
    const x = state.settings.windowSec;
    // Both windows have exactly X one-second buckets; current second is partial.
    // The completed warmup guarantees full observed historical coverage.
    const previousStartSec = nowSec - x * 2 + 1;
    const latestStartSec = nowSec - x + 1;
    const rows = [];
    for (const [symbol, coin] of state.volumes) {
      let previous = 0;
      let latest = 0;
      for (const [second, quoteVolume] of coin.seconds) {
        if (second < previousStartSec) {
          coin.seconds.delete(second);
        } else if (second < latestStartSec) {
          previous += quoteVolume;
        } else if (second <= nowSec) {
          latest += quoteVolume;
        }
      }
      // With zero previous volume, % increase is undefined: skip that coin.
      if (previous <= 0) continue;
      const increase = (latest / previous - 1) * 100;
      if (increase >= state.settings.minIncrease && increase <= state.settings.maxIncrease) {
        rows.push({ symbol, increase, latest, previous, price: coin.lastPrice });
      }
    }
    rows.sort((a, b) => b.increase - a.increase);
    return rows;
  }

  function renderRows(rows) {
    const body = $('candidateBody');
    if (!body) return;
    state.lastRows = rows;
    if (!rows.length) {
      setGridPlaceholder(`Volume Scan: koşulu sağlayan coin yok. ${state.symbols.size} USDT perpetual coin izleniyor. ` +
        `Kriter: son ${state.settings.windowSec}s hacim artışı %${fmt(state.settings.minIncrease)}–%${fmt(state.settings.maxIncrease)}.`);
      return;
    }
    if ($('candidateResponseTitle')) {
      $('candidateResponseTitle').textContent = `Volume Increase Scan — ${rows.length} SELECT`;
    }
    body.innerHTML = rows.map((r, i) => {
      const increase = `+${fmt(r.increase)}%`;
      const reason = `Quote volume: ${money(r.previous)} → ${money(r.latest)} USDT ` +
        `(önceki ${state.settings.windowSec}s → son ${state.settings.windowSec}s)`;
      // Exactly 16 td cells, corresponding to the site's original Candidate Response.
      return `<tr data-symbol="${escapeHtml(r.symbol)}" data-scan-source="VolumeIncreaseScan">` +
        `<td>${i + 1}</td>` +
        `<td class="symbol">${escapeHtml(r.symbol)}</td>` +
        `<td>—</td><td>—</td>` +
        `<td><span class="pill select">SELECT</span></td>` +
        `<td>—</td><td>—</td><td>—</td><td>—</td>` +
        `<td class="num">${escapeHtml(fmt(r.price, 8))}</td>` +
        `<td>—</td><td>—</td>` +
        `<td class="monitorReason">${escapeHtml(reason)}</td>` +
        `<td class="num good">${escapeHtml(increase)}</td>` +
        `<td>VOLUME +${escapeHtml(fmt(r.increase))}%</td>` +
        `<td>Volume Increase</td></tr>`;
    }).join('');
  }

  function publishSnapshot() {
    const rows = computeRows();
    renderRows(rows);
    state.lastSnapshotAt = Date.now();
    if ($('sumSelect')) $('sumSelect').textContent = String(rows.length);
    show(`Volume Scan: ${state.symbols.size} coin • ${rows.length} SELECT • ` +
      `${state.receivedTrades.toLocaleString('en-US')} trade • ` +
      `Son ${state.settings.windowSec}s / önceki ${state.settings.windowSec}s USDT hacim artışı: ` +
      `%${fmt(state.settings.minIncrease)}–%${fmt(state.settings.maxIncrease)}.`,
      rows.length ? 'good' : 'info', 'Volume Snapshot', 100);
  }

  function finishScan(message = 'Volume Scan tamamlandı. Sonuçlar sabitlendi.') {
    stop(message, false, true);
  }

  function tick() {
    if (!state.running || !state.settings) return;
    const x = state.settings.windowSec;
    if (!state.readySince) {
      show(`Volume Scan: WS bağlantısı kuruluyor (${state.openSockets}/${state.expectedSockets}) • ` +
        `Gelen işlem: ${state.receivedTrades.toLocaleString('en-US')}`,
        'info', 'Connecting', 0);
      return;
    }
    // Wait for two complete X-second windows. The background WebSocket stream
    // collects trades, but must NOT refresh Candidate Response every second.
    const elapsed = (Date.now() - state.readySince) / 1000;
    const required = x * 2 + 2;
    if (elapsed < required) {
      const remaining = Math.ceil(required - elapsed);
      show(`Volume Scan: ${state.symbols.size} coin izleniyor • ${state.openSockets} WS • ` +
        `${state.receivedTrades.toLocaleString('en-US')} trade • ` +
        `İlk sonuç için ${remaining}s veri birikmesi gerekiyor (2 × ${x}s).`,
        'info', 'Collecting Volume', Math.min(99, elapsed / required * 100));
      if ($('candidateBody') && !$('candidateBody').querySelector('tr[data-scan-source="VolumeIncreaseScan"]')) {
        setGridPlaceholder(`Volume Scan: ${remaining}s veri biriktiriliyor. ` +
          `Son ${x}s / önceki ${x}s karşılaştırması için iki tam dönem gerekli.`);
      }
      return;
    }

    // First snapshot: exactly one grid write after warmup.
    if (!state.lastSnapshotAt) {
      publishSnapshot();
      if (!autoEnabled()) {
        finishScan(); // Also closes sockets; the result remains unchanged.
      } else {
        state.nextSnapshotAt = Date.now() + AUTO_REFRESH_MS;
        show(`Volume Scan: ilk sonuç sabitlendi; Auto açık, sonraki güncelleme 15s sonra. ` +
          `Eşleşme: ${state.lastRows.length}.`, 'good', 'Auto Volume 15s', 100);
      }
      return;
    }

    if (!autoEnabled()) {
      finishScan('Volume Scan: Auto kapatıldı. Son sonuçlar sabitlendi.');
      return;
    }
    if (Date.now() >= state.nextSnapshotAt) {
      publishSnapshot();
      state.nextSnapshotAt = Date.now() + AUTO_REFRESH_MS;
    }
    const remaining = Math.max(0, Math.ceil((state.nextSnapshotAt - Date.now()) / 1000));
    show(`Volume Scan: Auto açık • ${state.lastRows.length} SELECT • ` +
      `sonraki hacim taraması ${remaining}s sonra.`, 'info', 'Auto Volume 15s', 100);
  }

  async function start() {
    if (state.running) return;
    try {
      state.settings = readSettings();
    } catch (error) {
      show(error.message, 'bad', 'Volume Scan', 0);
      return;
    }
    state.running = true;
    state.token++;
    const token = state.token;
    state.wsBaseIndex = 0;
    state.startedAt = Date.now();
    state.readySince = 0;
    state.lastRows = [];
    state.lastError = '';
    state.lastSnapshotAt = 0;
    state.nextSnapshotAt = 0;
    state.symbols.clear();
    state.volumes.clear();
    state.receivedTrades = 0;
    setControls(true);
    setGridPlaceholder('Volume Scan: Binance coin listesi yükleniyor…');
    show('Volume Scan: Binance USDT perpetual coin listesi alınıyor…', 'info', 'Loading', 0);
    state.timer = setInterval(tick, 1000);
    try {
      const symbols = await loadSymbols();
      if (!state.running || state.token !== token) return;
      state.symbols = symbols;
      openStreams();
    } catch (error) {
      if (!state.running || state.token !== token) return;
      stop(`Volume Scan hatası: ${error.message || error}`, true);
    }
  }

  function stop(reason = 'Volume Scan durduruldu.', isError = false, completed = false) {
    if (!state.running && !isError) return;
    state.running = false;
    state.token++;
    state.streamGeneration++;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    closeSockets();
    setControls(false);
    show(reason, isError ? 'bad' : completed ? 'good' : 'warn',
      isError ? 'Volume Error' : completed ? 'Volume Complete' : 'Volume Stopped',
      completed ? 100 : null);
  }

  function bind() {
    const button = $('volumeIncreaseScanBtn');
    if (!button || button.dataset.volumeScanBound === '1') return;
    button.dataset.volumeScanBound = '1';
    button.addEventListener('click', event => {
      event.preventDefault();
      if (state.running) stop();
      else start();
    });
    $('autoScan')?.addEventListener('change', () => {
      // The existing Auto 2m checkbox controls only this module's 15s refresh
      // while Volume Scan is active; all other scanners retain their behavior.
      if (!state.running || !state.lastSnapshotAt) return;
      if (!autoEnabled()) finishScan('Volume Scan: Auto kapatıldı. Son sonuçlar sabitlendi.');
      else state.nextSnapshotAt = Date.now() + AUTO_REFRESH_MS;
    });
    $('cancelBtn')?.addEventListener('click', event => {
      if (state.running) {
        event.preventDefault();
        event.stopImmediatePropagation();
        stop();
      }
    }, true);
    // If another scan is selected, relinquish the shared Candidate Response grid.
    document.querySelectorAll('.toolbar button[id]').forEach(other => {
      if (other.id === 'volumeIncreaseScanBtn' || other.id === 'cancelBtn' ||
          other.id === 'reportBtn' || other.id === 'followReportBtn') return;
      other.addEventListener('click', () => {
        if (state.running) stop('Volume Scan durduruldu; başka tarama seçildi.');
      }, true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  window.VolumeIncreaseScan = {
    start, stop, get running() { return state.running; },
    get results() { return state.lastRows.slice(); },
    // Pure diagnostic endpoint for tests; does not mutate the running scanner.
    _computeRows: computeRows
  };
})();
