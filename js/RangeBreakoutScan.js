/*
 * RangeBreakoutScan.js
 *
 * Amaç:
 * - Seçilen zaman penceresinde fiyatın uzun süre dar/yatay bir bölgede
 *   gezinmesini (range/base) tespit etmek.
 * - Fiyat bu bölgenin üst sınırını yeni kırmışsa ve henüz fazla uzaklaşmamışsa
 *   SELECT üretmek.
 *
 * Bu dosya tamamen bağımsızdır. StartScan / Watch / Follow kodlarına dokunmaz.
 * index.html entegrasyonunda yalnızca window.RangeBreakoutScan.scan(...) çağrılması yeterlidir.
 */

(function (global) {
  'use strict';

  const API_BASE = 'https://fapi.binance.com';

  const PERIODS = Object.freeze({
    '2M':  { label: '2 Months', lookbackMs: 60 * 24 * 60 * 60 * 1000, interval: '4h', limit: 360, signalBars: 3, minRangeBars: 36 },
    '1M':  { label: '1 Month',  lookbackMs: 30 * 24 * 60 * 60 * 1000, interval: '1h', limit: 720, signalBars: 6, minRangeBars: 72 },
    '1W':  { label: '1 Week',   lookbackMs:  7 * 24 * 60 * 60 * 1000, interval: '15m', limit: 672, signalBars: 8, minRangeBars: 64 },
    '3D':  { label: '3 Days',   lookbackMs:  3 * 24 * 60 * 60 * 1000, interval: '15m', limit: 288, signalBars: 6, minRangeBars: 40 },
    '1D':  { label: '1 Day',    lookbackMs:      24 * 60 * 60 * 1000, interval: '5m', limit: 288, signalBars: 6, minRangeBars: 36 },
    '4H':  { label: '4 Hours',  lookbackMs:       4 * 60 * 60 * 1000, interval: '5m', limit: 48, signalBars: 4, minRangeBars: 18 },
    '1H':  { label: '1 Hour',    lookbackMs:           60 * 60 * 1000, interval: '1m', limit: 60, signalBars: 5, minRangeBars: 20 },
    '15M': { label: '15 Minutes', lookbackMs:        15 * 60 * 1000, interval: '1m', limit: 15, signalBars: 3, minRangeBars: 7 },
    '5M':  { label: '5 Minutes',  lookbackMs:         5 * 60 * 1000, interval: '1m', limit: 5, signalBars: 2, minRangeBars: 3 }
  });

  const DEFAULT_CONFIG = Object.freeze({
    // Range toplam genişliği en fazla %15.
    maxRangeWidthPct: 15,

    // Aşırı dar ve anlamsız mikro-range'leri ayıklar.
    minRangeWidthPct: 0.20,

    // Range içindeki yönlü eğilim çok kuvvetliyse bunu yatay gezinme sayma.
    maxAbsoluteSlopePct: 4.0,
    maxSlopeToRangeRatio: 0.35,

    // Range üst / alt bölgesine tekrarlı temas şartı.
    boundaryZoneRatio: 0.18,
    minBoundaryTouches: 2,

    // Breakout buffer sabit %15 değildir; ATR + küçük yüzde ile dinamiktir.
    minBreakoutBufferPct: 0.35,
    atrBreakoutMultiplier: 0.25,

    // Breakout'tan sonra çok uzaklaşan coin SELECT olmasın.
    maxChasePct: 5.0,
    maxChaseAtr: 2.0,
    maxChaseRangeRatio: 0.35,

    // İlk tarama ön filtresi. 24h high'dan çok uzaktaki coinlerde ağır kline isteği yapılmaz.
    // 0.90 => current >= 24hHigh * 0.90
    prefilter24hHighRatio: 0.90,

    // Çok düşük likiditeyi zorunlu filtre yapmak istemiyorsak 0 bırakılır.
    min24hQuoteVolume: 0,

    // Aynı anda çok fazla istek gönderip rate-limit'e çarpmamak için.
    concurrency: 5,
    requestPauseMs: 120,

    // Null => ön filtreden geçen tüm USDT-M kontratları taranır.
    // Test veya performans için sayı verilebilir.
    maxSymbols: null,

    // Range ararken farklı pencere uzunlukları denenir.
    candidateWindowFractions: [1.0, 0.85, 0.70, 0.55, 0.40],

    // Volume sadece bilgi/kalite metriğidir; SELECT için hard-filter değildir.
    volumeLookbackBars: 20
  });

  let activeController = null;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function pctChange(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return NaN;
    return ((b - a) / a) * 100;
  }

  function median(values) {
    const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!arr.length) return NaN;
    const m = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  function quantile(values, q) {
    const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!arr.length) return NaN;
    if (arr.length === 1) return arr[0];
    const pos = (arr.length - 1) * clamp(q, 0, 1);
    const base = Math.floor(pos);
    const rest = pos - base;
    return arr[base + 1] !== undefined
      ? arr[base] + rest * (arr[base + 1] - arr[base])
      : arr[base];
  }

  function linearRegressionSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const xMean = (n - 1) / 2;
    let ySum = 0;
    for (const v of values) ySum += v;
    const yMean = ySum / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - xMean;
      num += dx * (values[i] - yMean);
      den += dx * dx;
    }
    return den === 0 ? 0 : num / den;
  }

  function calcAtr(candles, period = 14) {
    if (!candles || candles.length < 2) return NaN;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      trs.push(tr);
    }
    const use = trs.slice(-Math.min(period, trs.length));
    return use.reduce((a, b) => a + b, 0) / use.length;
  }

  function parseKlines(raw) {
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
    const r = await fetch(url, { signal, cache: 'no-store' });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const err = new Error(`HTTP ${r.status}: ${text || r.statusText}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function getUniverse(signal) {
    const [exchangeInfo, tickers] = await Promise.all([
      fetchJson(`${API_BASE}/fapi/v1/exchangeInfo`, signal),
      fetchJson(`${API_BASE}/fapi/v1/ticker/24hr`, signal)
    ]);

    const tickerMap = new Map(tickers.map(t => [t.symbol, t]));

    return exchangeInfo.symbols
      .filter(s =>
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT' &&
        s.contractType === 'PERPETUAL'
      )
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
    let rows = universe.filter(x => {
      if (!Number.isFinite(x.lastPrice) || !Number.isFinite(x.high24h) || x.high24h <= 0) return false;
      if (x.quoteVolume24h < cfg.min24hQuoteVolume) return false;
      return x.lastPrice >= x.high24h * cfg.prefilter24hHighRatio;
    });

    // Likiditesi daha yüksek olanları önce taramak performansı ve ilk sonuç süresini iyileştirir.
    rows.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);

    if (Number.isInteger(cfg.maxSymbols) && cfg.maxSymbols > 0) {
      rows = rows.slice(0, cfg.maxSymbols);
    }
    return rows;
  }

  function scoreRange(windowCandles, cfg) {
    if (!windowCandles || windowCandles.length < 3) return null;

    const highs = windowCandles.map(c => c.high);
    const lows = windowCandles.map(c => c.low);
    const closes = windowCandles.map(c => c.close);

    // Tek seferlik wick'leri range sınırı sanmamak için robust quantile kullanıyoruz.
    const rangeHigh = quantile(highs, 0.90);
    const rangeLow = quantile(lows, 0.10);
    if (!(rangeHigh > rangeLow) || rangeLow <= 0) return null;

    const rangeWidthPct = pctChange(rangeLow, rangeHigh);
    if (!Number.isFinite(rangeWidthPct)) return null;
    if (rangeWidthPct < cfg.minRangeWidthPct || rangeWidthPct > cfg.maxRangeWidthPct) return null;

    const meanClose = closes.reduce((a, b) => a + b, 0) / closes.length;
    const slopePerBar = linearRegressionSlope(closes);
    const fittedMove = slopePerBar * Math.max(1, closes.length - 1);
    const slopePct = meanClose > 0 ? (fittedMove / meanClose) * 100 : 0;
    const allowedSlopePct = Math.min(
      cfg.maxAbsoluteSlopePct,
      Math.max(0.30, rangeWidthPct * cfg.maxSlopeToRangeRatio)
    );
    if (Math.abs(slopePct) > allowedSlopePct) return null;

    const zone = (rangeHigh - rangeLow) * cfg.boundaryZoneRatio;
    const highTouchLevel = rangeHigh - zone;
    const lowTouchLevel = rangeLow + zone;
    const highTouches = highs.filter(v => v >= highTouchLevel).length;
    const lowTouches = lows.filter(v => v <= lowTouchLevel).length;
    if (highTouches < cfg.minBoundaryTouches || lowTouches < cfg.minBoundaryTouches) return null;

    const trPcts = [];
    for (let i = 1; i < windowCandles.length; i++) {
      const c = windowCandles[i];
      const p = windowCandles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      if (p.close > 0) trPcts.push((tr / p.close) * 100);
    }
    const medianTrPct = median(trPcts);

    const widthScore = clamp(1 - (rangeWidthPct / cfg.maxRangeWidthPct), 0, 1);
    const slopeScore = clamp(1 - (Math.abs(slopePct) / Math.max(allowedSlopePct, 0.0001)), 0, 1);
    const touchScore = clamp(
      Math.min(highTouches, lowTouches) / Math.max(cfg.minBoundaryTouches * 2, 1),
      0,
      1
    );
    const durationScore = clamp(windowCandles.length / 100, 0, 1);

    // Score yalnızca en iyi range penceresini seçmek için kullanılır; SELECT doğrudan score'a bağlı değildir.
    const score = 0.35 * widthScore + 0.30 * slopeScore + 0.20 * touchScore + 0.15 * durationScore;

    return {
      rangeHigh,
      rangeLow,
      rangeWidthPct,
      slopePct,
      highTouches,
      lowTouches,
      medianTrPct,
      score,
      bars: windowCandles.length,
      startTime: windowCandles[0].openTime,
      endTime: windowCandles[windowCandles.length - 1].closeTime
    };
  }

  function findBestRange(candles, periodCfg, cfg) {
    if (!candles || candles.length < periodCfg.minRangeBars + periodCfg.signalBars) return null;

    const baseEndExclusive = candles.length - periodCfg.signalBars;
    const maxBaseBars = baseEndExclusive;
    const candidates = [];

    for (const frac of cfg.candidateWindowFractions) {
      const bars = Math.floor(maxBaseBars * frac);
      if (bars < periodCfg.minRangeBars) continue;
      const start = Math.max(0, baseEndExclusive - bars);
      const windowCandles = candles.slice(start, baseEndExclusive);
      const scored = scoreRange(windowCandles, cfg);
      if (scored) {
        candidates.push({ ...scored, startIndex: start, endIndexExclusive: baseEndExclusive });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score || b.bars - a.bars);
    return candidates[0];
  }

  function calcVolumeRatio(candles, signalBars, lookbackBars) {
    if (!candles || candles.length < 3) return NaN;
    const signal = candles.slice(-Math.min(signalBars, candles.length));
    const priorEnd = candles.length - signal.length;
    const priorStart = Math.max(0, priorEnd - lookbackBars);
    const prior = candles.slice(priorStart, priorEnd);
    if (!prior.length || !signal.length) return NaN;

    const signalAvg = signal.reduce((s, c) => s + c.quoteVolume, 0) / signal.length;
    const priorAvg = prior.reduce((s, c) => s + c.quoteVolume, 0) / prior.length;
    return priorAvg > 0 ? signalAvg / priorAvg : NaN;
  }

  function evaluateBreakout(symbolInfo, candles, periodKey, periodCfg, cfg) {
    const bestRange = findBestRange(candles, periodCfg, cfg);
    if (!bestRange) {
      return { symbol: symbolInfo.symbol, result: 'NO_RANGE', period: periodKey };
    }

    const currentPrice = symbolInfo.lastPrice;
    const atr = calcAtr(candles, 14);
    const minPctBuffer = bestRange.rangeHigh * (cfg.minBreakoutBufferPct / 100);
    const atrBuffer = Number.isFinite(atr) ? atr * cfg.atrBreakoutMultiplier : 0;
    const breakoutBuffer = Math.max(minPctBuffer, atrBuffer);
    const breakoutLevel = bestRange.rangeHigh + breakoutBuffer;

    const rangeWidthAbs = bestRange.rangeHigh - bestRange.rangeLow;
    const chaseAbs = Math.min(
      bestRange.rangeHigh * (cfg.maxChasePct / 100),
      Number.isFinite(atr) ? atr * cfg.maxChaseAtr : Infinity,
      rangeWidthAbs * cfg.maxChaseRangeRatio
    );
    const maxSelectPrice = bestRange.rangeHigh + chaseAbs;

    const signalCandles = candles.slice(-periodCfg.signalBars);
    const closedBreakoutCandle = signalCandles.find(c => c.close >= breakoutLevel);
    const wickBreakoutCandle = signalCandles.find(c => c.high >= breakoutLevel);

    const breakoutNow = currentPrice >= breakoutLevel;
    const tooLate = currentPrice > maxSelectPrice;
    const hasRecentBreakoutEvidence = Boolean(closedBreakoutCandle || wickBreakoutCandle || breakoutNow);

    let result = 'WAIT';
    let reason = 'Price has not confirmed the upper range break yet.';

    if (breakoutNow && hasRecentBreakoutEvidence && !tooLate) {
      result = 'SELECT';
      reason = 'Fresh upper-range breakout; price is still inside the no-chase zone.';
    } else if (tooLate) {
      result = 'LATE';
      reason = 'Breakout exists but price is already too far above the range.';
    } else if (currentPrice >= bestRange.rangeHigh) {
      result = 'BREAKOUT_ATTEMPT';
      reason = 'Price is above RangeHigh but dynamic breakout buffer is not fully cleared.';
    } else {
      const distancePct = pctChange(currentPrice, bestRange.rangeHigh);
      if (Number.isFinite(distancePct) && distancePct <= 2.0) {
        result = 'NEAR_BREAKOUT';
        reason = 'Price is close to RangeHigh and can be watched for a fresh break.';
      }
    }

    const volumeRatio = calcVolumeRatio(candles, periodCfg.signalBars, cfg.volumeLookbackBars);
    const breakoutPctAboveRangeHigh = pctChange(bestRange.rangeHigh, currentPrice);

    return {
      symbol: symbolInfo.symbol,
      result,
      period: periodKey,
      interval: periodCfg.interval,
      currentPrice,
      rangeLow: bestRange.rangeLow,
      rangeHigh: bestRange.rangeHigh,
      rangeWidthPct: bestRange.rangeWidthPct,
      rangeSlopePct: bestRange.slopePct,
      rangeBars: bestRange.bars,
      rangeStartTime: bestRange.startTime,
      rangeEndTime: bestRange.endTime,
      rangeScore: bestRange.score,
      highTouches: bestRange.highTouches,
      lowTouches: bestRange.lowTouches,
      atr,
      breakoutBuffer,
      breakoutLevel,
      maxSelectPrice,
      breakoutPctAboveRangeHigh,
      breakoutTime: closedBreakoutCandle?.closeTime || wickBreakoutCandle?.closeTime || null,
      volumeRatio,
      quoteVolume24h: symbolInfo.quoteVolume24h,
      priceChangePct24h: symbolInfo.priceChangePct24h,
      reason
    };
  }

  async function getKlines(symbol, periodCfg, signal) {
    const params = new URLSearchParams({
      symbol,
      interval: periodCfg.interval,
      limit: String(periodCfg.limit)
    });
    const raw = await fetchJson(`${API_BASE}/fapi/v1/klines?${params.toString()}`, signal);
    return parseKlines(raw);
  }

  async function mapWithConcurrency(items, concurrency, worker, signal, pauseMs) {
    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          results[i] = { error: err, item: items[i] };
        }
        if (pauseMs > 0) await sleep(pauseMs);
      }
    }

    const workers = Array.from({ length: Math.max(1, concurrency) }, () => runner());
    await Promise.all(workers);
    return results;
  }

  function normalizePeriod(period) {
    const p = String(period || '').trim().toUpperCase();
    if (PERIODS[p]) return p;

    const aliases = {
      '2MONTHS': '2M', '2MONTH': '2M', '60D': '2M',
      '1MONTH': '1M', '30D': '1M',
      '1WEEK': '1W', '7D': '1W',
      '3DAYS': '3D',
      '1DAY': '1D', '24H': '1D',
      '4HOURS': '4H',
      '1HOUR': '1H', '1HOURS': '1H', '60MIN': '1H', '60MINUTES': '1H',
      '15MIN': '15M', '15MINUTES': '15M',
      '5MIN': '5M', '5MINUTES': '5M'
    };
    return aliases[p] || null;
  }

  async function scan(options = {}) {
    const periodKey = normalizePeriod(options.period || options.rangePeriod || '1M');
    if (!periodKey) {
      throw new Error(`Invalid period. Use one of: ${Object.keys(PERIODS).join(', ')}`);
    }

    if (activeController) activeController.abort();
    activeController = new AbortController();

    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) activeController.abort();
      else externalSignal.addEventListener('abort', () => activeController.abort(), { once: true });
    }

    const signal = activeController.signal;
    const periodCfg = PERIODS[periodKey];
    const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    const startedAt = Date.now();
    onProgress({ phase: 'universe', done: 0, total: 0, period: periodKey });

    let universe = await getUniverse(signal);

    if (Array.isArray(options.symbols) && options.symbols.length) {
      const allow = new Set(options.symbols.map(s => String(s).trim().toUpperCase()));
      universe = universe.filter(x => allow.has(x.symbol));
    }

    const candidates = prefilterUniverse(universe, cfg);
    onProgress({ phase: 'scan', done: 0, total: candidates.length, period: periodKey });

    let done = 0;
    const rawResults = await mapWithConcurrency(
      candidates,
      cfg.concurrency,
      async (symbolInfo) => {
        const candles = await getKlines(symbolInfo.symbol, periodCfg, signal);
        const evaluated = evaluateBreakout(symbolInfo, candles, periodKey, periodCfg, cfg);
        done++;
        onProgress({
          phase: 'scan',
          done,
          total: candidates.length,
          period: periodKey,
          symbol: symbolInfo.symbol,
          lastResult: evaluated.result
        });
        return evaluated;
      },
      signal,
      cfg.requestPauseMs
    );

    const errors = [];
    const evaluated = [];
    for (const r of rawResults) {
      if (!r) continue;
      if (r.error) {
        errors.push({ symbol: r.item?.symbol, message: r.error?.message || String(r.error) });
      } else {
        evaluated.push(r);
      }
    }

    const selects = evaluated
      .filter(x => x.result === 'SELECT')
      .sort((a, b) => {
        // En yeni / en erken breakout öne: RangeHigh üzerinde daha az uzaklaşmış olan önce.
        const ad = Math.abs(a.breakoutPctAboveRangeHigh ?? Infinity);
        const bd = Math.abs(b.breakoutPctAboveRangeHigh ?? Infinity);
        if (ad !== bd) return ad - bd;
        return (b.rangeScore || 0) - (a.rangeScore || 0);
      });

    const near = evaluated
      .filter(x => x.result === 'NEAR_BREAKOUT' || x.result === 'BREAKOUT_ATTEMPT')
      .sort((a, b) => (b.rangeScore || 0) - (a.rangeScore || 0));

    const summary = {
      period: periodKey,
      periodLabel: periodCfg.label,
      interval: periodCfg.interval,
      scanned: candidates.length,
      selectCount: selects.length,
      nearCount: near.length,
      errorCount: errors.length,
      elapsedMs: Date.now() - startedAt,
      selects,
      near,
      all: evaluated,
      errors,
      config: cfg
    };

    onProgress({
      phase: 'done',
      done: candidates.length,
      total: candidates.length,
      period: periodKey,
      selectCount: selects.length
    });

    // index.html isterse event ile de dinleyebilir.
    try {
      global.dispatchEvent(new CustomEvent('rangebreakout:results', { detail: summary }));
    } catch (_) {
      // CustomEvent desteklenmiyorsa scan() return değeri yeterlidir.
    }

    return summary;
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

  global.RangeBreakoutScan = Object.freeze({
    scan,
    stop,
    getPeriods,
    PERIODS,
    DEFAULT_CONFIG
  });

})(window);
