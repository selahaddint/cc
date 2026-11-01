/*
 * RangeBreakoutScan.js — 5 kapanmis 1m mumun fiyat ve hacim taramasi.
 *
 * SELECT icin ZORUNLU IKI kosul (20 mum hesabi ve eski range filtresi kaldirildi):
 *  1) Son (5.) kapanmis 1m mumun kapanis fiyati >= onceki 4 mumun
 *     ortalama govde fiyatinin 1.03 kati.
 *     Ortalama govde fiyati = (open + close) / 2.
 *  2) Ayni (5.) mumun hacmi >= onceki 4 kapanmis mumun
 *     ortalama hacminin 2.5 kati (en az +%150 hacim artisi).
 *
 * Mum fitilleri, henuz kapanmamis mumlar ve anlik ticker fiyati SELECT
 * kosullarina katilmaz. Onceki 4 mumun range bilgisi sadece UI icindir;
 * ek bir range kirilimi sarti UYGULANMAZ.
 *
 * HTML entegrasyonu: window.RangeBreakoutScan.scan({symbols, config,
 * onProgress, signal}), stop(), getPeriods(), rangebreakout:results eventi.
 * UI uyumu icin mevcut '1H' period anahtari korunur; analiz daima 5x1m'dir.
 */
(function (global) {
  'use strict';

  const API_BASE = 'https://fapi.binance.com';
  const BAR_MS = 60000;
  const REFERENCE_BARS = 4;
  const REQUIRED_CLOSED_BARS = 5;
  const REQUIRED_PRICE_GAIN_PCT = 3;
  const REQUIRED_VOLUME_RATIO = 2.5;
  const REQUIRED_VOLUME_INCREASE_PCT = 150;

  const PERIODS = Object.freeze({
    '1H': Object.freeze({
      label: '5 Minutes (5 closed 1m candles)',
      lookbackMs: REQUIRED_CLOSED_BARS * BAR_MS,
      interval: '1m',
      limit: 9,               // 5 kapanmis + 1 acik + kucuk tampon
      signalBars: 1,
      minRangeBars: REFERENCE_BARS
    })
  });

  const DEFAULT_CONFIG = Object.freeze({
    // SELECT icin sabittir, disaridan gelen config dusuremez veya degistiremez.
    priceAverageBars: REFERENCE_BARS,
    requiredPriceGainPct: REQUIRED_PRICE_GAIN_PCT,
    volumeLookbackBars: REFERENCE_BARS,
    minVolumeIncreasePct: REQUIRED_VOLUME_INCREASE_PCT,
    volumeMetric: 'volume',       // Binance kline[5], base asset hacmi
    prefilter24hHighRatio: 0,    // Fiyatin 24h zirveye yakin olmasi gerekli degil
    min24hQuoteVolume: 0,
    concurrency: 5,
    requestPauseMs: 120,
    maxSymbols: null,
    maxSignalAgeMs: 90000
  });

  let activeController = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function pctChange(from, to) {
    return from > 0 && Number.isFinite(to) ? (to / from - 1) * 100 : NaN;
  }

  function parseKlines(raw) {
    if (!Array.isArray(raw)) throw new Error('Binance klines payload is not an array.');
    return raw.map(k => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
      quoteVolume: Number(k[7]),
      trades: Number(k[8]),
      takerBuyBase: Number(k[9]),
      takerBuyQuote: Number(k[10])
    }));
  }

  async function fetchJson(url, signal) {
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const err = new Error(`HTTP ${response.status}: ${body || response.statusText}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  async function getUniverse(signal) {
    // Toplu istekler; her coin icin ayri 24 saatlik ticker istegi yapilmaz.
    const [exchangeInfo, tickers] = await Promise.all([
      fetchJson(`${API_BASE}/fapi/v1/exchangeInfo`, signal),
      fetchJson(`${API_BASE}/fapi/v1/ticker/24hr`, signal)
    ]);
    const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
    return exchangeInfo.symbols
      .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
      .map(s => {
        const t = tickerMap.get(s.symbol);
        if (!t) return null;
        return {
          symbol: s.symbol,
          lastPrice: Number(t.lastPrice),
          high24h: Number(t.highPrice),
          low24h: Number(t.lowPrice),
          quoteVolume24h: Number(t.quoteVolume),
          priceChangePct24h: Number(t.priceChangePercent)
        };
      })
      .filter(Boolean);
  }

  function prefilterUniverse(universe, cfg) {
    const highRatio = Number(cfg.prefilter24hHighRatio) || 0;
    const minQuoteVolume = Number(cfg.min24hQuoteVolume) || 0;
    const rows = universe.filter(x => {
      if (!(x.lastPrice > 0)) return false;
      if (!(Number.isFinite(x.quoteVolume24h) && x.quoteVolume24h >= minQuoteVolume)) return false;
      if (highRatio > 0 && !(x.high24h > 0 && x.lastPrice >= x.high24h * highRatio)) return false;
      return true;
    });
    rows.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
    return Number.isInteger(cfg.maxSymbols) && cfg.maxSymbols > 0
      ? rows.slice(0, cfg.maxSymbols) : rows;
  }

  function validateCandleSeries(candles) {
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!Number.isFinite(c.openTime) ||
          c.closeTime !== c.openTime + BAR_MS - 1 ||
          ![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) ||
          !Number.isFinite(c.volume) || c.volume < 0 ||
          !Number.isFinite(c.quoteVolume) || c.quoteVolume < 0) return false;
      if (i && c.openTime - candles[i - 1].openTime !== BAR_MS) return false;
    }
    return true;
  }

  function evaluateBreakout(symbolInfo, allCandles, now = Date.now()) {
    // '1H' sadece mevcut HTML'in bekledigi period anahtari, gercek pencere 5m.
    const basic = { symbol: symbolInfo.symbol, period: '1H', interval: '1m' };
    const closed = allCandles.filter(c => c.closeTime < now);
    if (closed.length < REQUIRED_CLOSED_BARS) {
      return { ...basic, result: 'NOT_READY', reason: 'Son 5 kapanmis 1m mum bulunamadi.' };
    }
    const candles = closed.slice(-REQUIRED_CLOSED_BARS);
    const signalCandle = candles[4];
    if (now - signalCandle.closeTime > DEFAULT_CONFIG.maxSignalAgeMs) {
      return { ...basic, result: 'STALE_CANDLE', signalCloseTime: signalCandle.closeTime,
        reason: 'En son kapanmis 1m mum guncel degil.' };
    }
    if (!validateCandleSeries(candles)) {
      return { ...basic, result: 'DATA_GAP', reason: 'Son 5 kapanmis 1m mumda eksik/bozuk veri var.' };
    }

    const previous4 = candles.slice(0, REFERENCE_BARS);
    const average4BodyPrice = previous4.reduce((sum, c) => sum + (c.open + c.close) / 2, 0) / REFERENCE_BARS;
    const average4Volume = previous4.reduce((sum, c) => sum + c.volume, 0) / REFERENCE_BARS;
    const average4QuoteVolume = previous4.reduce((sum, c) => sum + c.quoteVolume, 0) / REFERENCE_BARS;
    const lastClosedVolume = signalCandle.volume;
    const volumeRatio = average4Volume > 0 ? lastClosedVolume / average4Volume : NaN;
    const volumeIncreasePct = Number.isFinite(volumeRatio) ? (volumeRatio - 1) * 100 : NaN;
    const priceIncreasePct = pctChange(average4BodyPrice, signalCandle.close);
    const pricePassed = Number.isFinite(priceIncreasePct) && priceIncreasePct >= REQUIRED_PRICE_GAIN_PCT - 1e-9;
    const volumePassed = Number.isFinite(volumeRatio) && volumeRatio >= REQUIRED_VOLUME_RATIO - 1e-9;

    // Range ayrintilari sadece eski HTML'in goruntulemesi icin tutulur;
    // SELECT karari range kirilimina, yataylik veya wick'e BAGLI DEGIL.
    const rangeHigh = Math.max(...previous4.map(c => Math.max(c.open, c.close)));
    const rangeLow = Math.min(...previous4.map(c => Math.min(c.open, c.close)));
    const rangeWidthPct = pctChange(rangeLow, rangeHigh);
    const crossedUp = signalCandle.open <= rangeHigh && signalCandle.close > rangeHigh;
    const priceAboveRange = signalCandle.close > rangeHigh;
    const breakoutPctAboveRangeHigh = pctChange(rangeHigh, signalCandle.close);

    let result = 'SELECT';
    let reason = '5. mumun kapanisi onceki 4 mumun ortalama fiyatindan en az %3 yuksek; hacmi de ortalama hacmin en az 2.5 kati.';
    if (!pricePassed && !volumePassed) {
      result = 'WAIT';
      reason = 'Fiyat +%3 ve hacim 2.5x kosullarinin ikisi de saglanmadi.';
    } else if (!pricePassed) {
      result = 'PRICE_GAP_LOW';
      reason = 'Son kapanis onceki 4 mumun ortalama govde fiyatindan en az %3 yuksek degil.';
    } else if (!volumePassed) {
      result = 'VOLUME_LOW';
      reason = 'Son mumun hacmi onceki 4 mumun ortalama hacminin en az 2.5 kati degil.';
    }

    return {
      ...basic,
      result,
      reason,
      currentPrice: signalCandle.close,
      lastPrice: symbolInfo.lastPrice,
      signalOpen: signalCandle.open,
      signalClose: signalCandle.close,
      signalOpenTime: signalCandle.openTime,
      signalCloseTime: signalCandle.closeTime,
      average4BodyPrice,
      averagePrice: average4BodyPrice,
      priceIncreasePct,
      requiredPriceGainPct: REQUIRED_PRICE_GAIN_PCT,
      pricePassed,
      priceGapPassed: pricePassed, // Eski alan adi icin uyumluluk
      average4Volume,
      averageVolume: average4Volume,
      lastClosedVolume,
      lastClosedBaseVolume: lastClosedVolume,
      average4BaseVolume: average4Volume,
      lastClosedQuoteVolume: signalCandle.quoteVolume,
      average4QuoteVolume,
      volumeAverageBars: REFERENCE_BARS,
      priceAverageBars: REFERENCE_BARS,
      volumeMetric: 'volume',
      volumeRatio,
      volumeIncreasePct,
      requiredVolumeRatio: REQUIRED_VOLUME_RATIO,
      requiredVolumeIncreasePct: REQUIRED_VOLUME_INCREASE_PCT,
      volumePassed,
      // Eski HTML icin onceki ozelliklerin degerleri 4 mum ortalamasidir.
      average19Volume: average4Volume,
      average20Volume: average4Volume,
      average60Volume: average4Volume,
      average19BaseVolume: average4Volume,
      average20BaseVolume: average4Volume,
      average60BaseVolume: average4Volume,
      average19QuoteVolume: average4QuoteVolume,
      average20QuoteVolume: average4QuoteVolume,
      average60QuoteVolume: average4QuoteVolume,
      average19BodyPrice: average4BodyPrice,
      averagePriceBelowLastClosePct: Number.isFinite(priceIncreasePct)
        ? (1 - average4BodyPrice / signalCandle.close) * 100 : NaN,
      requiredPriceGapPct: REQUIRED_PRICE_GAIN_PCT,
      rangeHigh,
      rangeLow,
      rangeWidthPct,
      rangeSlopePct: null,
      rangeScore: null,
      rangeBars: REFERENCE_BARS,
      rangeStartTime: previous4[0].openTime,
      rangeEndTime: previous4[REFERENCE_BARS - 1].closeTime,
      highTouches: null,
      lowTouches: null,
      breakoutLevel: rangeHigh,
      breakoutBuffer: 0,
      maxSelectPrice: null,
      breakoutPctAboveRangeHigh,
      breakoutTime: crossedUp ? signalCandle.closeTime : null,
      priceAboveRange,
      crossedUp,
      quoteVolume24h: symbolInfo.quoteVolume24h,
      priceChangePct24h: symbolInfo.priceChangePct24h
    };
  }

  async function getKlines(symbol, signal) {
    const params = new URLSearchParams({symbol, interval: '1m', limit: String(PERIODS['1H'].limit)});
    return parseKlines(await fetchJson(`${API_BASE}/fapi/v1/klines?${params}`, signal));
  }

  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      function cancel() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  async function mapWithConcurrency(items, count, worker, signal, pauseMs) {
    const results = new Array(items.length);
    let cursor = 0;
    async function runner() {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index], index);
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          results[index] = { error: err, item: items[index] };
        }
        await sleep(pauseMs, signal);
      }
    }
    const workers = Array.from({length: Math.min(items.length, clamp(Math.trunc(count) || 5, 1, 12))}, runner);
    await Promise.all(workers);
    return results;
  }

  async function scan(options = {}) {
    // options.period ve options.rangePeriod KULLANILMAZ: 5x1m sabittir.
    const periodKey = '1H'; // UI uyumluluk anahtari, analiz 5m.
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const signal = controller.signal;
    const externalSignal = options.signal;
    const forwardAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', forwardAbort, {once: true});
    }

    const cfg = {...DEFAULT_CONFIG, ...(options.config || {})};
    // Eski UI'den gelen config esikleri 5/4 mum, fiyat +%3, hacim 2.5x'i DEGISTIREMEZ.
    cfg.priceAverageBars = REFERENCE_BARS;
    cfg.volumeLookbackBars = REFERENCE_BARS;
    cfg.requiredPriceGainPct = REQUIRED_PRICE_GAIN_PCT;
    cfg.minVolumeIncreasePct = REQUIRED_VOLUME_INCREASE_PCT;
    cfg.volumeMetric = 'volume';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const startedAt = Date.now();

    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress({phase: 'universe', done: 0, total: 0, period: periodKey});
      let universe = await getUniverse(signal);
      if (Array.isArray(options.symbols) && options.symbols.length) {
        const allowed = new Set(options.symbols.map(s => String(s).trim().toUpperCase()));
        universe = universe.filter(x => allowed.has(x.symbol));
      }
      const candidates = prefilterUniverse(universe, cfg);
      onProgress({phase: 'scan', done: 0, total: candidates.length, period: periodKey});
      let done = 0;
      const rawResults = await mapWithConcurrency(
        candidates,
        cfg.concurrency,
        async symbolInfo => {
          try {
            return evaluateBreakout(symbolInfo, await getKlines(symbolInfo.symbol, signal));
          } finally {
            done++;
            if (!signal.aborted) {
              onProgress({phase: 'scan', done, total: candidates.length,
                period: periodKey, symbol: symbolInfo.symbol});
            }
          }
        },
        signal,
        Math.max(0, Number(cfg.requestPauseMs) || 0)
      );
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const errors = [];
      const evaluated = [];
      for (const row of rawResults) {
        if (!row) continue;
        if (row.error) errors.push({symbol: row.item?.symbol, message: row.error?.message || String(row.error)});
        else evaluated.push(row);
      }

      // Onceki surumdeki siralama: az hacim artisi ONDE (2.5x, 2.6x, 3x ...).
      const selects = evaluated.filter(x => x.result === 'SELECT')
        .sort((a, b) => a.volumeRatio - b.volumeRatio || a.symbol.localeCompare(b.symbol));
      const near = evaluated.filter(x => x.result === 'VOLUME_LOW' || x.result === 'PRICE_GAP_LOW')
        .sort((a, b) => b.priceIncreasePct - a.priceIncreasePct);
      const summary = {
        period: periodKey,
        periodLabel: PERIODS['1H'].label,
        interval: '1m',
        scanned: candidates.length,
        selectCount: selects.length,
        nearCount: near.length,
        errorCount: errors.length,
        elapsedMs: Date.now() - startedAt,
        selects, near, all: evaluated, errors,
        config: cfg
      };
      onProgress({phase: 'done', done: candidates.length, total: candidates.length,
        period: periodKey, selectCount: selects.length});
      try {
        global.dispatchEvent(new CustomEvent('rangebreakout:results', {detail: summary}));
      } catch (_) {
        // CustomEvent yoksa scan() sonucu kullanilir.
      }
      return summary;
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort);
      if (activeController === controller) activeController = null;
    }
  }

  function stop() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  function getPeriods() {
    return JSON.parse(JSON.stringify(PERIODS));
  }

  global.RangeBreakoutScan = Object.freeze({scan, stop, getPeriods, PERIODS, DEFAULT_CONFIG});
})(window);
