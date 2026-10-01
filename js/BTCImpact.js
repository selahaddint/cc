/*
 * BTCImpact.js — shared dynamic BTC impact model for LONG decisions
 * ------------------------------------------------------------------
 * - Historical relationship is recalculated dynamically from public futures klines.
 * - Horizons: 7d/1h, 24h/5m, 4h/1m.
 * - Uses direction-aware beta (BetaUp / BetaDown), correlation, expected move
 *   and 15m relative strength.
 * - Cached by interval so Watch and Follow can share the same model without
 *   repeatedly downloading the same history.
 * - Produces context only. Consumers decide whether it means WAIT/PROTECT/EXIT.
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    endpoint: 'https://fapi.binance.com/fapi/v1/klines',
    requestTimeoutMs: 12000,
    cooldownDefaultMs: 120000,
    resultTtlMs: 45000,
    horizons: Object.freeze([
      Object.freeze({ key: '7d', interval: '1h', limit: 170, weight: 0.20, minSamples: 72, ttlMs: 15 * 60 * 1000 }),
      Object.freeze({ key: '24h', interval: '5m', limit: 290, weight: 0.30, minSamples: 96, ttlMs: 4 * 60 * 1000 }),
      Object.freeze({ key: '4h', interval: '1m', limit: 242, weight: 0.50, minSamples: 120, ttlMs: 50 * 1000 })
    ]),
    minReliableCorrelation: 0.35,
    minReliableBeta: 0.25,
    negativeExpectedPct: -0.15,
    strongNegativeExpectedPct: -0.45,
    positiveExpectedPct: 0.15,
    fastBtcDropPct: -0.20,
    relativeStrengthRescuePct: 0.35
  });

  const rawCache = new Map();
  const resultCache = new Map();
  const rawInFlight = new Map();
  const resultInFlight = new Map();
  const signalIds = new WeakMap();
  let nextSignalId = 1;
  let cooldownUntil = 0;

  const now = () => Date.now();
  const finite = value => Number.isFinite(Number(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function parseBars(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(k => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      closeTime: Number(k[6])
    })).filter(b => [b.openTime, b.open, b.high, b.low, b.close, b.closeTime].every(Number.isFinite));
  }

  function closedBars(bars) {
    const t = now();
    return (bars || []).filter(b => b.closeTime < t);
  }

  function cacheKey(symbol, interval, limit) {
    return `${symbol}|${interval}|${limit}`;
  }

  function signalKey(signal) {
    if (!signal) return 'none';
    if (!signalIds.has(signal)) signalIds.set(signal, nextSignalId++);
    return String(signalIds.get(signal));
  }

  async function fetchBars(symbol, horizon, signal) {
    const key = cacheKey(symbol, horizon.interval, horizon.limit);
    const cached = rawCache.get(key);
    if (cached && now() - cached.at < horizon.ttlMs) return cached.bars;

    const inflightKey = `${key}|${signalKey(signal)}`;
    if (rawInFlight.has(inflightKey)) return rawInFlight.get(inflightKey);

    if (cooldownUntil > now()) {
      const error = new Error(`BTC impact data cooldown active (${Math.ceil((cooldownUntil - now()) / 1000)}s)`);
      error.code = 'COOLDOWN';
      throw error;
    }

    const requestPromise = (async () => {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

      try {
        const qs = new URLSearchParams({
          symbol,
          interval: horizon.interval,
          limit: String(horizon.limit)
        });
        const response = await fetch(`${CONFIG.endpoint}?${qs}`, {
          method: 'GET', cache: 'no-store', signal: controller.signal
        });

        if (response.status === 418 || response.status === 429) {
          const retryHeader = Number(response.headers.get('Retry-After'));
          const retryMs = Number.isFinite(retryHeader) && retryHeader > 0
            ? retryHeader * 1000
            : CONFIG.cooldownDefaultMs;
          cooldownUntil = now() + Math.max(CONFIG.cooldownDefaultMs, retryMs);
          const error = new Error('BTC impact public-data rate limit');
          error.code = 'RATE_LIMIT';
          throw error;
        }
        if (!response.ok) throw new Error(`BTC impact HTTP ${response.status}`);

        const bars = parseBars(await response.json());
        rawCache.set(key, { at: now(), bars });
        return bars;
      } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }
    })();

    rawInFlight.set(inflightKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      if (rawInFlight.get(inflightKey) === requestPromise) rawInFlight.delete(inflightKey);
    }
  }

  function mean(values) {
    const a = values.filter(Number.isFinite);
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  }

  function correlation(xs, ys) {
    if (!Array.isArray(xs) || xs.length !== ys.length || xs.length < 3) return NaN;
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      cov += dx * dy;
      vx += dx * dx;
      vy += dy * dy;
    }
    return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
  }

  function covarianceBeta(xs, ys) {
    if (!Array.isArray(xs) || xs.length !== ys.length || xs.length < 3) return NaN;
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vx = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - mx;
      cov += dx * (ys[i] - my);
      vx += dx * dx;
    }
    return vx > 0 ? cov / vx : NaN;
  }

  function directionalBeta(xs, ys, direction) {
    let xy = 0, xx = 0, count = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (direction === 'up' && !(x > 0)) continue;
      if (direction === 'down' && !(x < 0)) continue;
      xy += x * y;
      xx += x * x;
      count++;
    }
    return { beta: count >= 12 && xx > 0 ? xy / xx : NaN, count };
  }

  function pairedReturns(btcBars, coinBars) {
    const btc = new Map(closedBars(btcBars).map(b => [b.openTime, b.close]));
    const coin = new Map(closedBars(coinBars).map(b => [b.openTime, b.close]));
    const times = [...btc.keys()].filter(t => coin.has(t)).sort((a, b) => a - b);
    const btcReturns = [], coinReturns = [];
    for (let i = 1; i < times.length; i++) {
      const t0 = times[i - 1], t1 = times[i];
      const b0 = btc.get(t0), b1 = btc.get(t1), c0 = coin.get(t0), c1 = coin.get(t1);
      if (!(b0 > 0 && b1 > 0 && c0 > 0 && c1 > 0)) continue;
      const br = b1 / b0 - 1;
      const cr = c1 / c0 - 1;
      if (Number.isFinite(br) && Number.isFinite(cr)) {
        btcReturns.push(br);
        coinReturns.push(cr);
      }
    }
    return { btcReturns, coinReturns };
  }

  function horizonStats(btcBars, coinBars, horizon) {
    const { btcReturns, coinReturns } = pairedReturns(btcBars, coinBars);
    const count = btcReturns.length;
    const up = directionalBeta(btcReturns, coinReturns, 'up');
    const down = directionalBeta(btcReturns, coinReturns, 'down');
    return {
      key: horizon.key,
      count,
      ready: count >= horizon.minSamples,
      weight: horizon.weight,
      correlation: correlation(btcReturns, coinReturns),
      beta: covarianceBeta(btcReturns, coinReturns),
      betaUp: up.beta,
      betaDown: down.beta,
      upCount: up.count,
      downCount: down.count
    };
  }

  function currentChangePct(bars, minutes) {
    const c = closedBars(bars);
    if (c.length < 2) return NaN;
    const latest = c[c.length - 1];
    const targetTime = latest.closeTime - minutes * 60 * 1000;
    let reference = null;
    for (let i = c.length - 2; i >= 0; i--) {
      if (c[i].closeTime <= targetTime) { reference = c[i]; break; }
    }
    if (!reference || !(reference.close > 0) || !(latest.close > 0)) return NaN;
    return (latest.close / reference.close - 1) * 100;
  }

  function weightedMetric(stats, selector, useCorrelationWeight = true) {
    let total = 0, weightTotal = 0;
    for (const s of stats) {
      if (!s.ready) continue;
      const value = selector(s);
      if (!Number.isFinite(value)) continue;
      const corrFactor = useCorrelationWeight && Number.isFinite(s.correlation)
        ? clamp(Math.abs(s.correlation), 0.20, 1)
        : 1;
      const w = s.weight * corrFactor;
      total += value * w;
      weightTotal += w;
    }
    return weightTotal > 0 ? total / weightTotal : NaN;
  }

  function classify({ btc15mPct, btc5mPct, coin15mPct, dynamicBeta, weightedCorrelation }) {
    const expected15mPct = Number.isFinite(btc15mPct) && Number.isFinite(dynamicBeta)
      ? btc15mPct * dynamicBeta
      : NaN;
    const excess15mPct = Number.isFinite(coin15mPct) && Number.isFinite(expected15mPct)
      ? coin15mPct - expected15mPct
      : NaN;

    const reliable = Number.isFinite(weightedCorrelation)
      && weightedCorrelation >= CONFIG.minReliableCorrelation
      && Number.isFinite(dynamicBeta)
      && dynamicBeta >= CONFIG.minReliableBeta;

    let level = 'NEUTRAL';
    let reason = 'BTC relationship is not strong enough to veto the LONG signal.';

    if (reliable) {
      const strongNegative = Number.isFinite(expected15mPct)
        && expected15mPct <= CONFIG.strongNegativeExpectedPct
        && Number.isFinite(btc15mPct) && btc15mPct < 0;
      const fastNegative = Number.isFinite(expected15mPct)
        && expected15mPct < 0
        && Number.isFinite(btc5mPct) && btc5mPct <= CONFIG.fastBtcDropPct;
      const negative = Number.isFinite(expected15mPct)
        && expected15mPct <= CONFIG.negativeExpectedPct;
      const positive = Number.isFinite(expected15mPct)
        && expected15mPct >= CONFIG.positiveExpectedPct;

      if (strongNegative || (fastNegative && negative)) {
        level = 'STRONG_NEGATIVE';
        reason = 'BTC downside implies a materially negative expected move for this coin.';
      } else if (negative || fastNegative) {
        level = 'NEGATIVE';
        reason = 'BTC environment is negative for this coin according to its current beta.';
      } else if (positive) {
        level = 'POSITIVE';
        reason = 'BTC environment is supportive for this coin according to its current beta.';
      } else {
        reason = 'BTC expected effect is small / neutral at the moment.';
      }

      // A coin that is clearly outperforming BTC can reduce STRONG_NEGATIVE to NEGATIVE,
      // but never turns a negative BTC environment directly into a GREEN permission.
      if (level === 'STRONG_NEGATIVE'
          && Number.isFinite(coin15mPct) && coin15mPct > 0
          && Number.isFinite(excess15mPct) && excess15mPct >= CONFIG.relativeStrengthRescuePct) {
        level = 'NEGATIVE';
        reason = 'BTC is strongly negative, but the coin shows material relative strength; keep WAIT rather than hard veto.';
      }
    }

    return { level, reliable, expected15mPct, excess15mPct, reason };
  }

  function summaryText(result) {
    const pct = x => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}%` : '—';
    const num = x => Number.isFinite(x) ? x.toFixed(2) : '—';
    return `BTC ${result.level} • BTC15 ${pct(result.btc15mPct)} • β ${num(result.dynamicBeta)} • Corr ${num(result.weightedCorrelation)} • Exp ${pct(result.expected15mPct)} • Rel ${pct(result.excess15mPct)}`;
  }

  async function analyze(symbol, { signal = null, force = false } = {}) {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) throw new Error('BTCImpact symbol is required');

    const cached = resultCache.get(normalized);
    if (!force && cached && now() - cached.at < CONFIG.resultTtlMs) return cached.result;

    const inflightKey = `${normalized}|${signalKey(signal)}`;
    if (!force && resultInFlight.has(inflightKey)) return resultInFlight.get(inflightKey);

    const analysisPromise = (async () => {
      const pairSymbol = normalized === 'BTCUSDT' ? 'BTCUSDT' : normalized;
      const horizonPayloads = await Promise.all(CONFIG.horizons.map(async horizon => {
        const btcPromise = fetchBars('BTCUSDT', horizon, signal);
        const coinPromise = pairSymbol === 'BTCUSDT' ? btcPromise : fetchBars(pairSymbol, horizon, signal);
        const [btcBars, coinBars] = await Promise.all([btcPromise, coinPromise]);
        return { horizon, btcBars, coinBars };
      }));

      const stats = horizonPayloads.map(x => horizonStats(x.btcBars, x.coinBars, x.horizon));
      const recent = horizonPayloads.find(x => x.horizon.interval === '1m') || horizonPayloads[horizonPayloads.length - 1];
      const btc15mPct = currentChangePct(recent.btcBars, 15);
      const btc5mPct = currentChangePct(recent.btcBars, 5);
      const coin15mPct = currentChangePct(recent.coinBars, 15);

      const btcDirection = Number.isFinite(btc15mPct) && btc15mPct < 0 ? 'down' : 'up';
      const dynamicBeta = weightedMetric(stats, s => {
        const directional = btcDirection === 'down' ? s.betaDown : s.betaUp;
        return Number.isFinite(directional) ? directional : s.beta;
      });
      const weightedCorrelation = weightedMetric(stats, s => s.correlation, false);
      const betaUp = weightedMetric(stats, s => Number.isFinite(s.betaUp) ? s.betaUp : s.beta);
      const betaDown = weightedMetric(stats, s => Number.isFinite(s.betaDown) ? s.betaDown : s.beta);

      const classification = classify({ btc15mPct, btc5mPct, coin15mPct, dynamicBeta, weightedCorrelation });
      const result = Object.freeze({
        symbol: normalized,
        at: now(),
        ...classification,
        btc15mPct,
        btc5mPct,
        coin15mPct,
        dynamicBeta,
        betaUp,
        betaDown,
        weightedCorrelation,
        horizons: stats.map(s => Object.freeze({ ...s }))
      });

      resultCache.set(normalized, { at: now(), result });
      return result;
    })();

    resultInFlight.set(inflightKey, analysisPromise);
    try {
      return await analysisPromise;
    } finally {
      if (resultInFlight.get(inflightKey) === analysisPromise) resultInFlight.delete(inflightKey);
    }
  }

  window.BTCImpact = Object.freeze({
    analyze,
    summaryText,
    getCached: symbol => resultCache.get(String(symbol || '').trim().toUpperCase())?.result || null,
    clearCache: () => { rawCache.clear(); resultCache.clear(); rawInFlight.clear(); resultInFlight.clear(); cooldownUntil = 0; },
    getState: () => ({ cooldownUntil, rawCacheSize: rawCache.size, resultCacheSize: resultCache.size, rawInFlight: rawInFlight.size, resultInFlight: resultInFlight.size }),
    config: CONFIG
  });
})();
