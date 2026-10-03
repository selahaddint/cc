/*
 * Ema200SqueezeLongScan.js
 *
 * Video strategy LONG scanner:
 *   1) Price above EMA200
 *   2) Bullish swing/trend state
 *   3) Squeeze Momentum pullback reaches below +2.00 and turns up
 *   4) MACD(12,26,9) histogram is negative but weakens for 3 completed bars
 *   5) Optional strength confirmations: MACD bullish cross + Heikin-Ashi doji
 *
 * IMPORTANT:
 * - Only COMPLETED candles generate signals. The still-open candle is excluded.
 * - The AlgoAlpha oscillator reconstruction below follows the indicator's
 *   published description (EMA high/low swing context + short-term z-score
 *   momentum + Squeeze/Release calculation). It is deliberately isolated in
 *   buildAlgoAlphaCompatibleOscillator() so it can later be replaced line-for-line
 *   if the TradingView Pine source is supplied.
 * - StartScan / Watch / Follow are not modified.
 *
 * Usage:
 *   const summary = await Ema200SqueezeLongScan.scan({
 *     timeframe: '5m',
 *     onProgress: p => console.log(p)
 *   });
 *
 * Optional:
 *   await Ema200SqueezeLongScan.scan({
 *     timeframe: '15m',
 *     symbols: ['BTCUSDT','ETHUSDT']
 *   });
 */

(function (global) {
  'use strict';

  const API_BASE = 'https://fapi.binance.com';

  const TIMEFRAMES = Object.freeze({
    '1m':  { label: '1 Minute',  targetPct: 0.25, limit: 360 },
    '3m':  { label: '3 Minutes', targetPct: null, limit: 360 },
    '5m':  { label: '5 Minutes', targetPct: 0.50, limit: 360 },
    '15m': { label: '15 Minutes', targetPct: 0.50, limit: 360 },
    '30m': { label: '30 Minutes', targetPct: null, limit: 360 },
    '1h':  { label: '1 Hour', targetPct: null, limit: 360 },
    '2h':  { label: '2 Hours', targetPct: null, limit: 360 },
    '4h':  { label: '4 Hours', targetPct: null, limit: 360 }
  });

  const DEFAULT_CONFIG = Object.freeze({
    emaTrendLength: 200,

    // Squeeze Momentum Oscillator [AlgoAlpha] values shown in the video.
    underlyingMomentumLength: 10,
    swingMomentumLength: 200,
    squeezeCalculationPeriod: 14,
    squeezeSmoothingLength: 7,
    squeezeDetectionLength: 14,
    hyperSqueezeDetectionLength: 5,

    // Video threshold: the thin momentum line must pull below +2.00.
    momentumPullbackLevel: 2.0,

    // A recent pullback below +2.00 must exist, then the line must turn upward.
    momentumLookbackBars: 8,
    momentumRiseBars: 2,

    // MACD original/default settings from the video.
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,

    // Video explicitly waits for three orderly shrinking negative histogram bars.
    macdWeakeningBars: 3,

    // Extra confirmations from the video are NOT mandatory for SELECT.
    macdCrossLookbackBars: 3,
    heikinAshiDojiLookbackBars: 3,
    heikinAshiDojiBodyRatio: 0.30,

    // Video says stop "a little below EMA200" but gives no exact buffer.
    // Kept configurable so the strategy rule itself is not silently changed.
    stopBufferPct: 0.25,

    // Universe / REST protection.
    min24hQuoteVolume: 0,
    concurrency: 4,
    requestPauseMs: 150,
    maxSymbols: null,

    // Results: all SELECTs are returned; near setups are useful for WATCH.
    nearMomentumDistance: 0.75
  });

  let activeController = null;

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function finite(v) {
    return Number.isFinite(Number(v));
  }

  function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function mean(values) {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
  }

  function stdev(values) {
    const a = values.filter(Number.isFinite);
    if (a.length < 2) return NaN;
    const m = mean(a);
    const variance = a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
    return Math.sqrt(variance);
  }

  function emaSeries(values, period) {
    const out = new Array(values.length).fill(NaN);
    if (!Array.isArray(values) || values.length < period || period < 1) return out;

    let seed = 0;
    for (let i = 0; i < period; i++) {
      if (!Number.isFinite(values[i])) return out;
      seed += values[i];
    }
    seed /= period;
    out[period - 1] = seed;

    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      const v = values[i];
      out[i] = Number.isFinite(v)
        ? alpha * v + (1 - alpha) * out[i - 1]
        : out[i - 1];
    }
    return out;
  }

  // Wilder ATR series is not required by the entry rule, but TR is used
  // by the published Squeeze/Release calculation.
  function trueRangeSeries(candles) {
    const out = new Array(candles.length).fill(NaN);
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) {
        out[i] = c.high - c.low;
      } else {
        const pc = candles[i - 1].close;
        out[i] = Math.max(
          c.high - c.low,
          Math.abs(c.high - pc),
          Math.abs(c.low - pc)
        );
      }
    }
    return out;
  }

  function rollingZScore(values, length) {
    const out = new Array(values.length).fill(NaN);
    for (let i = length - 1; i < values.length; i++) {
      const w = values.slice(i - length + 1, i + 1).filter(Number.isFinite);
      if (w.length !== length) continue;
      const m = mean(w);
      const sd = stdev(w);
      if (!(sd > 0)) {
        out[i] = 0;
      } else {
        out[i] = (values[i] - m) / sd;
      }
    }
    return out;
  }

  function parseKlines(raw) {
    return (Array.isArray(raw) ? raw : []).map(k => ({
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

  async function getServerTime(signal) {
    try {
      const x = await fetchJson(`${API_BASE}/fapi/v1/time`, signal);
      return finite(x?.serverTime) ? Number(x.serverTime) : Date.now();
    } catch (_) {
      return Date.now();
    }
  }

  async function getUniverse(signal) {
    const [exchangeInfo, tickers] = await Promise.all([
      fetchJson(`${API_BASE}/fapi/v1/exchangeInfo`, signal),
      fetchJson(`${API_BASE}/fapi/v1/ticker/24hr`, signal)
    ]);

    const tickerMap = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.symbol, t]));

    return (exchangeInfo?.symbols || [])
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
          currentPrice: Number(t.lastPrice),
          quoteVolume24h: Number(t.quoteVolume),
          priceChangePct24h: Number(t.priceChangePercent)
        };
      })
      .filter(Boolean);
  }

  function prefilterUniverse(universe, cfg) {
    let rows = universe
      .filter(x =>
        finite(x.currentPrice) &&
        x.currentPrice > 0 &&
        finite(x.quoteVolume24h) &&
        x.quoteVolume24h >= cfg.min24hQuoteVolume
      )
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);

    if (Number.isInteger(cfg.maxSymbols) && cfg.maxSymbols > 0) {
      rows = rows.slice(0, cfg.maxSymbols);
    }
    return rows;
  }

  /*
   * AlgoAlpha-compatible reconstruction.
   *
   * Published indicator description says:
   * - swing momentum evaluates price relative to EMA-derived significant highs/lows,
   * - short-term momentum is z-score normalized,
   * - squeeze value compares EMA(ATR) behavior with EMA(high-low).
   *
   * We use:
   * - EMA(high, swingLen) / EMA(low, swingLen) as the persistent swing channel,
   * - a persistent bullish/bearish state when close exits that channel,
   * - displacement from channel midpoint, z-scored over underlyingLen,
   * - Squeeze/Release calculation from ATR-vs-high/low EMA.
   *
   * This function is intentionally isolated for easy exact Pine-port replacement.
   */
  function buildAlgoAlphaCompatibleOscillator(candles, cfg) {
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const highLow = candles.map(c => c.high - c.low);

    const emaHigh = emaSeries(highs, cfg.swingMomentumLength);
    const emaLow = emaSeries(lows, cfg.swingMomentumLength);

    const midpoint = closes.map((_, i) =>
      finite(emaHigh[i]) && finite(emaLow[i]) ? (emaHigh[i] + emaLow[i]) / 2 : NaN
    );

    const channelWidth = closes.map((_, i) =>
      finite(emaHigh[i]) && finite(emaLow[i]) ? Math.max(emaHigh[i] - emaLow[i], 1e-12) : NaN
    );

    // Dimensionless displacement avoids price-scale dependence before z-score.
    const displacement = closes.map((c, i) =>
      finite(midpoint[i]) && finite(channelWidth[i])
        ? (c - midpoint[i]) / channelWidth[i]
        : NaN
    );

    const momentumZ = rollingZScore(displacement, cfg.underlyingMomentumLength);

    const swingState = new Array(candles.length).fill(0);
    let state = 0;
    for (let i = 0; i < candles.length; i++) {
      if (!finite(emaHigh[i]) || !finite(emaLow[i])) {
        swingState[i] = state;
        continue;
      }
      if (closes[i] > emaHigh[i]) state = 1;
      else if (closes[i] < emaLow[i]) state = -1;
      swingState[i] = state;
    }

    // Squeeze & Release core from the indicator's public description:
    // EMA(ATR, 2*period) - EMA(ATR, period), normalized by EMA(high-low, 2*period).
    const tr = trueRangeSeries(candles);
    const atrFast = emaSeries(tr, cfg.squeezeCalculationPeriod);
    const atrSlow = emaSeries(atrFast, cfg.squeezeCalculationPeriod * 2);
    const hlEma = emaSeries(highLow, cfg.squeezeCalculationPeriod * 2);

    const squeezeRaw = closes.map((_, i) => {
      if (!finite(atrFast[i]) || !finite(atrSlow[i]) || !finite(hlEma[i]) || hlEma[i] === 0) return NaN;
      return ((atrSlow[i] - atrFast[i]) / hlEma[i]) * 100;
    });
    const squeezeValue = emaSeries(squeezeRaw, cfg.squeezeSmoothingLength);
    const squeezeSignal = emaSeries(squeezeValue, cfg.squeezeDetectionLength);

    return {
      emaHigh,
      emaLow,
      midpoint,
      momentumZ,
      swingState,
      squeezeValue,
      squeezeSignal
    };
  }

  function buildMacd(closes, fast, slow, signal) {
    const fastEma = emaSeries(closes, fast);
    const slowEma = emaSeries(closes, slow);
    const line = closes.map((_, i) =>
      finite(fastEma[i]) && finite(slowEma[i]) ? fastEma[i] - slowEma[i] : NaN
    );

    // EMA cannot seed across leading NaNs, so build a compact signal then align it.
    const first = line.findIndex(Number.isFinite);
    const signalLine = new Array(line.length).fill(NaN);
    if (first >= 0) {
      const compact = line.slice(first);
      const compactSignal = emaSeries(compact, signal);
      for (let i = 0; i < compactSignal.length; i++) {
        signalLine[first + i] = compactSignal[i];
      }
    }

    const hist = line.map((v, i) =>
      finite(v) && finite(signalLine[i]) ? v - signalLine[i] : NaN
    );

    return { fastEma, slowEma, line, signal: signalLine, hist };
  }

  function heikinAshiSeries(candles) {
    const out = new Array(candles.length);
    let prevOpen = NaN;
    let prevClose = NaN;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const haClose = (c.open + c.high + c.low + c.close) / 4;
      const haOpen = i === 0
        ? (c.open + c.close) / 2
        : (prevOpen + prevClose) / 2;
      const haHigh = Math.max(c.high, haOpen, haClose);
      const haLow = Math.min(c.low, haOpen, haClose);
      out[i] = { open: haOpen, high: haHigh, low: haLow, close: haClose };
      prevOpen = haOpen;
      prevClose = haClose;
    }
    return out;
  }

  function isDojiLike(candle, bodyRatio) {
    if (!candle) return false;
    const range = candle.high - candle.low;
    if (!(range > 0)) return false;
    const body = Math.abs(candle.close - candle.open);
    const upper = candle.high - Math.max(candle.open, candle.close);
    const lower = Math.min(candle.open, candle.close) - candle.low;
    return body / range <= bodyRatio && upper > 0 && lower > 0;
  }

  function recentAny(arr, endIndex, lookback, predicate) {
    const start = Math.max(0, endIndex - lookback + 1);
    for (let i = endIndex; i >= start; i--) {
      if (predicate(arr[i], i)) return true;
    }
    return false;
  }

  function orderlyNegativeHistogramWeakening(hist, t, bars) {
    if (bars < 2 || t - bars + 1 < 0) return false;
    const seq = hist.slice(t - bars + 1, t + 1);
    if (seq.length !== bars || !seq.every(Number.isFinite)) return false;
    if (!seq.every(v => v < 0)) return false;

    // Example: -0.009, -0.006, -0.003 => selling momentum is weakening.
    for (let i = 1; i < seq.length; i++) {
      if (!(seq[i] > seq[i - 1])) return false;
      if (!(Math.abs(seq[i]) < Math.abs(seq[i - 1]))) return false;
    }
    return true;
  }

  function bullishMacdCrossRecently(macd, t, lookback) {
    const start = Math.max(1, t - lookback + 1);
    for (let i = start; i <= t; i++) {
      if (
        finite(macd.line[i]) && finite(macd.signal[i]) &&
        finite(macd.line[i - 1]) && finite(macd.signal[i - 1]) &&
        macd.line[i] > macd.signal[i] &&
        macd.line[i - 1] <= macd.signal[i - 1]
      ) return true;
    }
    return false;
  }

  function momentumPullbackAndTurn(momentumZ, t, cfg) {
    if (!finite(momentumZ[t])) return { ok: false };

    const start = Math.max(0, t - cfg.momentumLookbackBars + 1);
    const recent = momentumZ.slice(start, t + 1).filter(Number.isFinite);
    if (!recent.length) return { ok: false };

    const minValue = Math.min(...recent);
    const wentBelowLevel = minValue < cfg.momentumPullbackLevel;

    let rising = true;
    const riseBars = Math.max(1, cfg.momentumRiseBars);
    if (t - riseBars < 0) rising = false;
    else {
      for (let i = t - riseBars + 1; i <= t; i++) {
        if (!finite(momentumZ[i]) || !finite(momentumZ[i - 1]) || !(momentumZ[i] > momentumZ[i - 1])) {
          rising = false;
          break;
        }
      }
    }

    const distanceToLevel = cfg.momentumPullbackLevel - momentumZ[t];

    return {
      ok: wentBelowLevel && rising,
      wentBelowLevel,
      rising,
      minValue,
      current: momentumZ[t],
      distanceToLevel
    };
  }

  function analyzeSymbol(symbolInfo, candles, timeframe, cfg) {
    if (!Array.isArray(candles) || candles.length < cfg.swingMomentumLength + cfg.underlyingMomentumLength + 20) {
      return {
        strategyId: 'EMA200_SQUEEZE_LONG',
        strategyLabel: 'EMA200 + Squeeze Momentum + MACD LONG',
        symbol: symbolInfo.symbol,
        result: 'INSUFFICIENT',
        reason: 'Not enough completed candles for EMA200 / momentum / MACD.'
      };
    }

    const closes = candles.map(c => c.close);
    const ema200 = emaSeries(closes, cfg.emaTrendLength);
    const osc = buildAlgoAlphaCompatibleOscillator(candles, cfg);
    const macd = buildMacd(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const ha = heikinAshiSeries(candles);

    const t = candles.length - 1;
    const close = closes[t];
    const trendEma = ema200[t];
    const swingGreen = osc.swingState[t] > 0;
    const priceAboveEma = finite(trendEma) && close > trendEma;

    const momentum = momentumPullbackAndTurn(osc.momentumZ, t, cfg);
    const histWeakening = orderlyNegativeHistogramWeakening(macd.hist, t, cfg.macdWeakeningBars);

    const macdCross = bullishMacdCrossRecently(macd, t, cfg.macdCrossLookbackBars);
    const haDoji = recentAny(
      ha,
      t,
      cfg.heikinAshiDojiLookbackBars,
      c => isDojiLike(c, cfg.heikinAshiDojiBodyRatio)
    );

    const coreLong = priceAboveEma && swingGreen && momentum.ok && histWeakening;
    const strong = coreLong && macdCross && haDoji;

    const latestHist = macd.hist[t];
    const histSeq = macd.hist.slice(Math.max(0, t - cfg.macdWeakeningBars + 1), t + 1);

    // Near setup: trend is valid and pullback happened, but turn/3-bar MACD is not yet complete.
    const near =
      !coreLong &&
      priceAboveEma &&
      swingGreen &&
      momentum.wentBelowLevel &&
      (
        momentum.rising ||
        (finite(momentum.current) && Math.abs(momentum.current - cfg.momentumPullbackLevel) <= cfg.nearMomentumDistance)
      );

    let result = coreLong ? 'SELECT' : near ? 'WAIT' : 'REJECT';

    const reasonParts = [
      `Close ${priceAboveEma ? '>' : '<='} EMA200`,
      `Swing ${swingGreen ? 'GREEN' : 'NOT GREEN'}`,
      `Momentum min=${finite(momentum.minValue) ? momentum.minValue.toFixed(2) : '—'} / now=${finite(momentum.current) ? momentum.current.toFixed(2) : '—'} / ${momentum.rising ? 'TURNING UP' : 'NOT TURNING UP'}`,
      `MACD-H ${histWeakening ? '3-BAR WEAKENING' : 'NOT READY'}`
    ];

    if (coreLong) {
      reasonParts.push(strong ? 'STRONG: MACD cross + HA doji confirmed' : 'Core video LONG conditions confirmed');
    }

    const stopPrice = finite(trendEma)
      ? trendEma * (1 - cfg.stopBufferPct / 100)
      : NaN;

    const targetPct = TIMEFRAMES[timeframe]?.targetPct ?? null;
    const targetPrice = targetPct != null && finite(symbolInfo.currentPrice)
      ? symbolInfo.currentPrice * (1 + targetPct / 100)
      : NaN;

    return {
      strategyId: 'EMA200_SQUEEZE_LONG',
      strategyLabel: 'EMA200 + Squeeze Momentum + MACD LONG',
      symbol: symbolInfo.symbol,
      result,
      strength: strong ? 'STRONG' : coreLong ? 'NORMAL' : near ? 'WATCH' : 'NONE',
      timeframe,

      currentPrice: symbolInfo.currentPrice,
      signalClose: close,
      signalCloseTime: candles[t].closeTime,

      ema200: trendEma,
      stopPrice,
      stopBufferPct: cfg.stopBufferPct,

      targetPct,
      targetPrice,

      priceAboveEma200: priceAboveEma,
      swingGreen,

      momentumZ: momentum.current,
      momentumRecentMin: momentum.minValue,
      momentumBelow2Recently: momentum.wentBelowLevel,
      momentumTurningUp: momentum.rising,

      macdLine: macd.line[t],
      macdSignal: macd.signal[t],
      macdHistogram: latestHist,
      macdHistogramSequence: histSeq,
      macdHistogramWeakening3: histWeakening,
      macdBullishCross: macdCross,

      heikinAshiDoji: haDoji,

      squeezeValue: osc.squeezeValue[t],
      squeezeSignal: osc.squeezeSignal[t],

      quoteVolume24h: symbolInfo.quoteVolume24h,
      priceChangePct24h: symbolInfo.priceChangePct24h,

      reason: reasonParts.join(' • ')
    };
  }

  async function getKlines(symbol, timeframe, limit, serverTime, signal) {
    const params = new URLSearchParams({
      symbol,
      interval: timeframe,
      limit: String(limit)
    });

    const raw = await fetchJson(`${API_BASE}/fapi/v1/klines?${params.toString()}`, signal);
    return parseKlines(raw)
      .filter(c =>
        finite(c.open) && finite(c.high) && finite(c.low) && finite(c.close) &&
        finite(c.closeTime) &&
        c.closeTime < serverTime
      );
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

    const workers = Array.from(
      { length: Math.max(1, Number(concurrency) || 1) },
      () => runner()
    );

    await Promise.all(workers);
    return results;
  }

  function normalizeTimeframe(tf) {
    const x = String(tf || '5m').trim().toLowerCase();
    return TIMEFRAMES[x] ? x : null;
  }

  async function scan(options = {}) {
    const timeframe = normalizeTimeframe(options.timeframe || options.interval || '5m');
    if (!timeframe) {
      throw new Error(`Invalid timeframe. Use one of: ${Object.keys(TIMEFRAMES).join(', ')}`);
    }

    if (activeController) activeController.abort();
    activeController = new AbortController();

    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) activeController.abort();
      else externalSignal.addEventListener('abort', () => activeController.abort(), { once: true });
    }

    const signal = activeController.signal;
    const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    const startedAt = Date.now();

    onProgress({ phase: 'universe', done: 0, total: 0, timeframe });

    const [serverTime, rawUniverse] = await Promise.all([
      getServerTime(signal),
      getUniverse(signal)
    ]);

    let universe = rawUniverse;

    if (Array.isArray(options.symbols) && options.symbols.length) {
      const allow = new Set(options.symbols.map(s => String(s).trim().toUpperCase()));
      universe = universe.filter(x => allow.has(x.symbol));
    }

    const candidates = prefilterUniverse(universe, cfg);
    onProgress({ phase: 'scan', done: 0, total: candidates.length, timeframe });

    let done = 0;
    const limit = Math.max(
      TIMEFRAMES[timeframe].limit,
      cfg.swingMomentumLength + cfg.underlyingMomentumLength + 60
    );

    const rawResults = await mapWithConcurrency(
      candidates,
      cfg.concurrency,
      async symbolInfo => {
        const candles = await getKlines(symbolInfo.symbol, timeframe, limit, serverTime, signal);
        const evaluated = analyzeSymbol(symbolInfo, candles, timeframe, cfg);

        done++;
        onProgress({
          phase: 'scan',
          done,
          total: candidates.length,
          timeframe,
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
        errors.push({
          symbol: r.item?.symbol,
          message: r.error?.message || String(r.error)
        });
      } else {
        evaluated.push(r);
      }
    }

    const selects = evaluated
      .filter(x => x.result === 'SELECT')
      .sort((a, b) => {
        if (a.strength !== b.strength) return a.strength === 'STRONG' ? -1 : 1;

        // Prefer earlier reversal: momentum closer to the +2 pullback area.
        const ad = finite(a.momentumZ) ? Math.abs(a.momentumZ - cfg.momentumPullbackLevel) : Infinity;
        const bd = finite(b.momentumZ) ? Math.abs(b.momentumZ - cfg.momentumPullbackLevel) : Infinity;
        if (ad !== bd) return ad - bd;

        return (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0);
      });

    const waits = evaluated
      .filter(x => x.result === 'WAIT')
      .sort((a, b) => {
        const ad = finite(a.momentumZ) ? Math.abs(a.momentumZ - cfg.momentumPullbackLevel) : Infinity;
        const bd = finite(b.momentumZ) ? Math.abs(b.momentumZ - cfg.momentumPullbackLevel) : Infinity;
        return ad - bd;
      });

    const completedAt = Date.now();
    const summary = {
      strategyId: 'EMA200_SQUEEZE_LONG',
      strategy: 'EMA200 + Squeeze Momentum + MACD LONG',
      startedAt,
      completedAt,
      timeframe,
      timeframeLabel: TIMEFRAMES[timeframe].label,
      scanned: candidates.length,
      selectCount: selects.length,
      waitCount: waits.length,
      errorCount: errors.length,
      elapsedMs: Date.now() - startedAt,
      selects,
      waits,
      all: evaluated,
      errors,
      config: cfg,
      indicatorImplementation: 'AlgoAlpha-compatible public-description reconstruction'
    };

    onProgress({
      phase: 'done',
      done: candidates.length,
      total: candidates.length,
      timeframe,
      selectCount: selects.length,
      waitCount: waits.length
    });

    try {
      global.dispatchEvent(new CustomEvent('ema200squeeze:results', { detail: summary }));
    } catch (_) {
      // scan() return value is sufficient.
    }

    return summary;
  }

  function stop() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  function getTimeframes() {
    return JSON.parse(JSON.stringify(TIMEFRAMES));
  }

  // Exposed for unit/backtest work without re-downloading market data.
  function analyzeCandles(symbol, rawCandles, options = {}) {
    const timeframe = normalizeTimeframe(options.timeframe || '5m');
    if (!timeframe) throw new Error('Invalid timeframe.');

    const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const candles = Array.isArray(rawCandles) && Array.isArray(rawCandles[0])
      ? parseKlines(rawCandles)
      : rawCandles;

    const last = candles?.[candles.length - 1];
    const symbolInfo = {
      symbol: String(symbol || '').toUpperCase(),
      currentPrice: options.currentPrice ?? last?.close,
      quoteVolume24h: options.quoteVolume24h ?? NaN,
      priceChangePct24h: options.priceChangePct24h ?? NaN
    };

    return analyzeSymbol(symbolInfo, candles, timeframe, cfg);
  }

  global.Ema200SqueezeLongScan = Object.freeze({
    scan,
    stop,
    analyzeCandles,
    getTimeframes,
    TIMEFRAMES,
    DEFAULT_CONFIG
  });

})(window);
