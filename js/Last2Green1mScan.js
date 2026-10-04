(() => {
  'use strict';

  // ================================================================
  // Last2Green1mScan.js
  //
  // TEK SELECT KURALI:
  //   Kapanmış son iki 1m mumun ikisi de yeşil:
  //   candle[-2].close > candle[-2].open
  //   candle[-1].close > candle[-1].open
  //
  // Başka seçim şartı YOKTUR.
  // - EMA yok
  // - MACD yok
  // - RSI yok
  // - Volume filtresi yok
  // - BTC filtresi yok
  // - Trend filtresi yok
  // - Min/Max yüzde filtresi yok
  // - AllowedCoins filtresi yok
  // - CAUTION / WAIT yok
  //
  // Universe: aktif USDT-M PERPETUAL kontratlar.
  // Açık/oluşmakta olan 1m mum seçim hesabına ASLA girmez.
  // ================================================================

  const BASE = 'https://fapi.binance.com';
  const SCAN_SOURCE = '1m Last 2 Green';
  const BUTTON_ID = 'last2Green1mScanBtn';

  // Binance ban/rate-limit riskini gereksiz artırmamak için agresif paralellik yok.
  const CONCURRENCY = 4;
  const WORKER_PAUSE_MS = 80;

  const state = {
    running: false,
    controller: null,
    startedAt: 0,
    completedAt: 0,
    requestCount: 0,
    errorCount: 0,
    scannedCount: 0,
    symbols: [],
    results: []
  };

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const finite = value => Number.isFinite(Number(value));

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function price(value) {
    if (!finite(value)) return '—';
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 10 });
  }

  function pct(value, digits = 3) {
    if (!finite(value)) return '—';
    const n = Number(value);
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
  }

  function setStatus(text, cls = 'info') {
    const el = $('mainStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('good', 'warn', 'bad', 'info');
    if (cls) el.classList.add(cls);
  }

  function setProgress(percent, stageText, statusText, cls = 'info') {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));

    const bar = $('progressBar');
    const progressText = $('progressText');
    const stage = $('stageText');

    if (bar) bar.style.width = `${p}%`;
    if (progressText) progressText.textContent = `${Math.round(p)}%`;
    if (stage) stage.textContent = stageText || SCAN_SOURCE;
    if (statusText) setStatus(statusText, cls);
  }

  function log(message) {
    const box = $('logBox');
    if (!box) return;
    const t = new Date().toLocaleTimeString('tr-TR');
    box.textContent += `\n[${t}] ${message}`;
    box.scrollTop = box.scrollHeight;
  }

  async function getJson(path, signal) {
    state.requestCount += 1;

    const response = await fetch(`${BASE}${path}`, {
      method: 'GET',
      cache: 'no-store',
      signal
    });

    // 429 sonrası tekrar tekrar istek atıp 418 ban riskini büyütme.
    if (response.status === 429 || response.status === 418) {
      const err = new Error(
        response.status === 429
          ? 'Binance rate limit (429). Scan durduruldu.'
          : 'Binance geçici IP banı (418). Scan durduruldu.'
      );
      err.fatalRateLimit = true;
      throw err;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  async function loadUniverse(signal) {
    const localStartedAt = Date.now();

    // IMPORTANT:
    // exchangeInfo.serverTime bazı durumlarda cache/stale kalabiliyor.
    // Mum kapanışını onunla kontrol edersek bütün güncel 1m mumlar
    // yanlışlıkla "henüz kapanmadı" sayılabilir ve SELECT 0 çıkar.
    // Bu yüzden saat için Futures time endpoint'i ayrı alınır.
    const [info, timeInfo] = await Promise.all([
      getJson('/fapi/v1/exchangeInfo', signal),
      getJson('/fapi/v1/time', signal).catch(() => null)
    ]);

    const symbols = (info?.symbols || [])
      .filter(s =>
        s &&
        s.status === 'TRADING' &&
        s.contractType === 'PERPETUAL' &&
        s.quoteAsset === 'USDT'
      )
      .map(s => s.symbol);

    const rawServerTime = Number(timeInfo?.serverTime);
    const serverTime = Number.isFinite(rawServerTime) && rawServerTime > 1_000_000_000_000
      ? rawServerTime
      : Date.now();

    return {
      symbols,
      serverClock: () => serverTime + (Date.now() - localStartedAt)
    };
  }

  function parseKline(k) {
    return {
      openTime: Number(k?.[0]),
      open: Number(k?.[1]),
      high: Number(k?.[2]),
      low: Number(k?.[3]),
      close: Number(k?.[4]),
      volume: Number(k?.[5]),
      closeTime: Number(k?.[6])
    };
  }

  async function analyzeSymbol(symbol, serverNow, signal) {
    // 4 istememizin sebebi: açık olan son 1m mumu dışarı attıktan sonra
    // kapanmış son iki muma kesin erişebilmek.
    const raw = await getJson(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=4`,
      signal
    );

    if (!Array.isArray(raw) || raw.length < 3) return null;

    const candles = raw.map(parseKline);

    // Sadece gerçekten kapanmış mumlar.
    const now = serverNow();
    const closed = candles.filter(c =>
      finite(c.closeTime) &&
      c.closeTime < now &&
      finite(c.open) &&
      finite(c.close)
    );

    if (closed.length < 2) return null;

    const c1 = closed[closed.length - 2];
    const c2 = closed[closed.length - 1];

    // ==============================================================
    // TEK KURAL
    // ==============================================================
    if (!(c1.close > c1.open && c2.close > c2.open)) {
      return null;
    }

    // Current price sadece UI içindir, SELECT şartı değildir.
    // Son dönen kline açık mumsa onun güncel close değeri kullanılır.
    const lastRawCandle = candles[candles.length - 1];
    const currentPrice =
      finite(lastRawCandle?.close) && lastRawCandle.close > 0
        ? lastRawCandle.close
        : c2.close;

    const candle1Pct = c1.open > 0 ? ((c1.close / c1.open) - 1) * 100 : NaN;
    const candle2Pct = c2.open > 0 ? ((c2.close / c2.open) - 1) * 100 : NaN;

    return {
      symbol,
      result: 'SELECT',
      scanSource: SCAN_SOURCE,
      currentPrice,
      decisionPrice: currentPrice,
      candle1: c1,
      candle2: c2,
      candle1Pct,
      candle2Pct
    };
  }

  function renderRows(rows) {
    const body = $('candidateBody');
    if (!body) return;

    if (!rows.length) {
      body.innerHTML =
        '<tr><td colspan="21" class="empty">1m Last 2 Green: kapanmış son iki 1m mumu da yeşil olan coin bulunamadı.</td></tr>';
      notifyCandidatesRendered();
      return;
    }

    body.innerHTML = rows.map((row, i) => {
      const entry = row.currentPrice > 0
        ? Number(Number(row.currentPrice).toPrecision(12)).toString()
        : '';

      // Bu sadece mevcut Follow UI varsayılanıdır; seçim kriteri değildir.
      const stop = row.currentPrice > 0
        ? Number((Number(row.currentPrice) * 0.98).toPrecision(12)).toString()
        : '';

      const reason =
        `Kapanmış son 2×1m yeşil • ` +
        `Önceki ${pct(row.candle1Pct)} • Son ${pct(row.candle2Pct)}`;

      return `<tr data-symbol="${esc(row.symbol)}" data-scan-source="${esc(SCAN_SOURCE)}">
        <td>${i + 1}</td>
        <td class="symbol">${esc(row.symbol)}</td>
        <td data-role="ys"><span class="ysMark unknown">—</span></td>
        <td><span class="pill select">SELECT</span></td>
        <td class="decisionCell na" data-role="price-level">—</td>
        <td class="decisionCell na" data-role="risk-level">—</td>
        <td class="num"><input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" value="${esc(entry)}" aria-label="${esc(row.symbol)} Entry Price"></td>
        <td class="num"><input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" value="${esc(stop)}" aria-label="${esc(row.symbol)} Stop Price"></td>
        <td class="num" data-role="current-price">${esc(price(row.currentPrice))}</td>
        <td><button class="followBtn" type="button" data-action="follow" data-symbol="${esc(row.symbol)}">Follow</button></td>
        <td class="monitorCell"><span class="monitorDot off" title="OFF" aria-label="OFF"></span></td>
        <td class="monitorReason"><span class="reasonText" title="${esc(reason)}">${esc(reason)}</span><div class="monitorTime"></div></td>
        <td class="liveChangeCell" data-role="live-change">—</td>
        <td class="liveResultCell" data-role="live-result">SELECT • 2×1m GREEN</td>
        <td class="num" data-role="meta-volume">—</td>
        <td class="num" data-role="meta-total-supply">—</td>
        <td class="num" data-role="meta-circ-supply">—</td>
        <td class="metaAge" data-role="meta-age">—</td>
        <td class="num" data-role="meta-max">—</td>
        <td class="num" data-role="meta-min">—</td>
        <td data-role="meta-hour">${esc(new Date().toLocaleTimeString('tr-TR'))}</td>
      </tr>`;
    }).join('');

    notifyCandidatesRendered();
  }

  function notifyCandidatesRendered() {
    document.dispatchEvent(new CustomEvent('cryptooffer:candidates-rendered'));
  }

  function updateResponseTitle() {
    const el = $('candidateResponseTitle');
    if (!el) return;

    const hm = new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date());

    el.textContent = `${SCAN_SOURCE} - ${hm}`;
  }

  function setButtonRunning(running) {
    const button = $(BUTTON_ID);
    if (!button) return;
    button.disabled = running;
    button.textContent = running ? '2×1m Green…' : '2×1m Green';
  }

  function resetState() {
    state.startedAt = Date.now();
    state.completedAt = 0;
    state.requestCount = 0;
    state.errorCount = 0;
    state.scannedCount = 0;
    state.symbols = [];
    state.results = [];
  }

  async function worker(queue, total, serverNow, signal) {
    while (queue.length) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const symbol = queue.shift();
      if (!symbol) break;

      try {
        const row = await analyzeSymbol(symbol, serverNow, signal);
        if (row) state.results.push(row);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error?.fatalRateLimit) throw error;

        state.errorCount += 1;
        log(`${symbol}: ${error?.message || error}`);
      }

      state.scannedCount += 1;

      const p = total > 0
        ? 5 + (state.scannedCount / total) * 92
        : 5;

      setProgress(
        p,
        '1m Candle Scan',
        `1m Last 2 Green: ${state.scannedCount}/${total} tarandı • SELECT ${state.results.length}`,
        'info'
      );

      if (WORKER_PAUSE_MS > 0) {
        await sleep(WORKER_PAUSE_MS);
      }
    }
  }

  async function scan() {
    if (state.running) return state.results.slice();

    resetState();
    state.running = true;
    state.controller = new AbortController();

    const signal = state.controller.signal;

    setButtonRunning(true);
    setProgress(1, 'Universe', '1m Last 2 Green: USDT-M perpetual coinler hazırlanıyor...', 'info');

    document.dispatchEvent(new CustomEvent('cryptooffer:scan-start', {
      detail: { source: SCAN_SOURCE }
    }));

    try {
      const { symbols, serverClock } = await loadUniverse(signal);
      state.symbols = symbols.slice();

      setProgress(
        5,
        '1m Candle Scan',
        `1m Last 2 Green: ${symbols.length} coin taranıyor...`,
        'info'
      );

      const queue = symbols.slice();
      const workers = [];

      for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i += 1) {
        workers.push(worker(queue, symbols.length, serverClock, signal));
      }

      await Promise.all(workers);

      state.completedAt = Date.now();

      // Bilerek rank/sort yok. Universe sırasını korumaya çalışmak için
      // exchangeInfo içindeki sembol sırasına göre geri diziyoruz.
      const order = new Map(symbols.map((s, i) => [s, i]));
      state.results.sort((a, b) =>
        (order.get(a.symbol) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.symbol) ?? Number.MAX_SAFE_INTEGER)
      );

      window.CryptoOfferData = window.CryptoOfferData || {};
      window.CryptoOfferData.last2Green1mState = state;

      updateResponseTitle();
      renderRows(state.results);

      const cls = state.results.length ? 'good' : 'warn';
      setProgress(
        100,
        'Completed',
        `1m Last 2 Green tamamlandı • SELECT ${state.results.length} • Hata ${state.errorCount} • Request ${state.requestCount}`,
        cls
      );

      document.dispatchEvent(new CustomEvent('last2green1m:complete', {
        detail: {
          source: SCAN_SOURCE,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          scannedCount: state.scannedCount,
          requestCount: state.requestCount,
          errorCount: state.errorCount,
          select: state.results.slice(),
          all: state.results.slice()
        }
      }));

      return state.results.slice();
    } catch (error) {
      if (error?.name === 'AbortError') {
        setProgress(
          0,
          'Cancelled',
          `1m Last 2 Green iptal edildi • ${state.scannedCount}/${state.symbols.length || 0} tarandı.`,
          'warn'
        );

        document.dispatchEvent(new CustomEvent('last2green1m:cancelled'));
        return state.results.slice();
      }

      console.error('Last2Green1mScan error:', error);

      setProgress(
        0,
        'Error',
        `1m Last 2 Green hata: ${error?.message || error}`,
        'bad'
      );

      document.dispatchEvent(new CustomEvent('last2green1m:error', {
        detail: { message: error?.message || String(error) }
      }));

      throw error;
    } finally {
      state.running = false;
      state.controller = null;
      setButtonRunning(false);
    }
  }

  function cancel() {
    if (state.controller) {
      state.controller.abort();
    }
  }

  // Public API
  window.Last2Green1mScan = {
    scan,
    cancel,
    state,
    source: SCAN_SOURCE
  };

  // Optional button binding.
  // index.html içine id="last2Green1mScanBtn" eklenirse otomatik çalışır.
  const button = $(BUTTON_ID);
  if (button) {
    button.addEventListener('click', () => {
      if (!state.running) void scan();
    });
  }

  // Ortak Cancel butonu bu scanner'ı da durdursun.
  const cancelButton = $('cancelBtn');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      if (state.running) cancel();
    });
  }
})();
