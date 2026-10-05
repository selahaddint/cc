/*
 * BTCImpact3m1m.js — BTC context for the Auto 3m/1m LONG family only.
 * ---------------------------------------------------------------------------
 * Uses only 3m and 1m data.
 * Produces: BTC changes, direction-aware beta, correlation, expected coin move,
 * relative strength and short lag estimate.
 *
 * ENTRY: may return WAIT when BTC pressure and coin relative weakness agree.
 * FOLLOW: may return PROTECT, but BTC context alone never returns EXIT.
 *
 * The Auto3m1m scanner can register its WebSocket/history cache as the preferred
 * provider. REST is only a fallback when that provider is unavailable.
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    endpoint: 'https://fapi.binance.com/fapi/v1/klines',
    requestTimeoutMs: 10000,
    cooldownDefaultMs: 120000,
    resultTtlMs: 12000,
    intervals: Object.freeze([
      Object.freeze({ key: '3m', interval: '3m', limit: 305, weight: 0.60, minSamples: 90, ttlMs: 2 * 60 * 1000 }),
      Object.freeze({ key: '1m', interval: '1m', limit: 305, weight: 0.40, minSamples: 120, ttlMs: 45 * 1000 })
    ]),
    minReliableCorrelation: 0.30,
    minReliableBeta: 0.20,
    negativeExpectedPct: -0.10,
    strongNegativeExpectedPct: -0.30,
    positiveExpectedPct: 0.10,
    relativeAllowPct: 0.15,
    relativeStrongPct: 0.25,
    followProtectRelativePct: -0.05,
    maxLagMinutes: 3,
    minLagSamples: 80
  });

  const rawCache = new Map();
  const resultCache = new Map();
  const rawInFlight = new Map();
  const resultInFlight = new Map();
  const signalIds = new WeakMap();
  let nextSignalId = 1;
  let cooldownUntil = 0;
  let marketDataProvider = null;

  const now = () => Date.now();
  const finite = value => Number.isFinite(Number(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function normalizeBar(x) {
    if (Array.isArray(x)) {
      return {
        openTime: Number(x[0]), open: Number(x[1]), high: Number(x[2]), low: Number(x[3]),
        close: Number(x[4]), closeTime: Number(x[6])
      };
    }
    return {
      openTime: Number(x?.openTime), open: Number(x?.open), high: Number(x?.high), low: Number(x?.low),
      close: Number(x?.close), closeTime: Number(x?.closeTime)
    };
  }

  function normalizeBars(rows) {
    return (Array.isArray(rows) ? rows : []).map(normalizeBar)
      .filter(b => [b.openTime, b.open, b.high, b.low, b.close, b.closeTime].every(Number.isFinite))
      .sort((a, b) => a.openTime - b.openTime);
  }

  function closedBars(rows, at = now()) {
    return normalizeBars(rows).filter(b => b.closeTime < at);
  }

  function signalKey(signal) {
    if (!signal) return 'none';
    if (!signalIds.has(signal)) signalIds.set(signal, nextSignalId++);
    return String(signalIds.get(signal));
  }

  function cacheKey(symbol, cfg) {
    return `${symbol}|${cfg.interval}|${cfg.limit}`;
  }

  async function fetchBars(symbol, cfg, signal) {
    const key = cacheKey(symbol, cfg);
    const cached = rawCache.get(key);
    if (cached && now() - cached.at < cfg.ttlMs) return cached.bars;

    const inflightKey = `${key}|${signalKey(signal)}`;
    if (rawInFlight.has(inflightKey)) return rawInFlight.get(inflightKey);
    if (cooldownUntil > now()) {
      const e = new Error(`BTCImpact3m1m cooldown (${Math.ceil((cooldownUntil - now()) / 1000)}s)`);
      e.code = 'COOLDOWN';
      throw e;
    }

    const promise = (async () => {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', forwardAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
      try {
        const qs = new URLSearchParams({ symbol, interval: cfg.interval, limit: String(cfg.limit) });
        const response = await fetch(`${CONFIG.endpoint}?${qs}`, { method: 'GET', cache: 'no-store', signal: controller.signal });
        if (response.status === 418 || response.status === 429) {
          const retryHeader = Number(response.headers.get('Retry-After'));
          const retryMs = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : CONFIG.cooldownDefaultMs;
          cooldownUntil = now() + Math.max(CONFIG.cooldownDefaultMs, retryMs);
          const e = new Error('BTCImpact3m1m public-data rate limit');
          e.code = 'RATE_LIMIT';
          throw e;
        }
        if (!response.ok) throw new Error(`BTCImpact3m1m HTTP ${response.status}`);
        const bars = normalizeBars(await response.json());
        rawCache.set(key, { at: now(), bars });
        return bars;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forwardAbort);
      }
    })();

    rawInFlight.set(inflightKey, promise);
    try { return await promise; }
    finally { if (rawInFlight.get(inflightKey) === promise) rawInFlight.delete(inflightKey); }
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
      cov += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
  }

  function covarianceBeta(xs, ys) {
    if (!Array.isArray(xs) || xs.length !== ys.length || xs.length < 3) return NaN;
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vx = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i] - mx;
      cov += dx * (ys[i] - my); vx += dx * dx;
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
      xy += x * y; xx += x * x; count++;
    }
    return { beta: count >= 12 && xx > 0 ? xy / xx : NaN, count };
  }

  function pairedReturns(btcRows, coinRows, at) {
    const btc = new Map(closedBars(btcRows, at).map(b => [b.openTime, b.close]));
    const coin = new Map(closedBars(coinRows, at).map(b => [b.openTime, b.close]));
    const times = [...btc.keys()].filter(t => coin.has(t)).sort((a, b) => a - b);
    const btcReturns = [], coinReturns = [];
    for (let i = 1; i < times.length; i++) {
      const t0 = times[i - 1], t1 = times[i];
      const b0 = btc.get(t0), b1 = btc.get(t1), c0 = coin.get(t0), c1 = coin.get(t1);
      if (!(b0 > 0 && b1 > 0 && c0 > 0 && c1 > 0)) continue;
      const br = b1 / b0 - 1, cr = c1 / c0 - 1;
      if (Number.isFinite(br) && Number.isFinite(cr)) { btcReturns.push(br); coinReturns.push(cr); }
    }
    return { btcReturns, coinReturns };
  }

  function intervalStats(btcRows, coinRows, cfg, at) {
    const { btcReturns, coinReturns } = pairedReturns(btcRows, coinRows, at);
    const count = btcReturns.length;
    const up = directionalBeta(btcReturns, coinReturns, 'up');
    const down = directionalBeta(btcReturns, coinReturns, 'down');
    return {
      key: cfg.key, count, ready: count >= cfg.minSamples, weight: cfg.weight,
      correlation: correlation(btcReturns, coinReturns), beta: covarianceBeta(btcReturns, coinReturns),
      betaUp: up.beta, betaDown: down.beta, upCount: up.count, downCount: down.count,
      btcReturns, coinReturns
    };
  }

  function bestLag(btcReturns, coinReturns) {
    if (!Array.isArray(btcReturns) || !Array.isArray(coinReturns)) return { minutes: 0, correlation: NaN, beta: NaN, samples: 0 };
    let best = { minutes: 0, correlation: correlation(btcReturns, coinReturns), beta: covarianceBeta(btcReturns, coinReturns), samples: Math.min(btcReturns.length, coinReturns.length) };
    for (let lag = 1; lag <= CONFIG.maxLagMinutes; lag++) {
      const n = Math.min(btcReturns.length, coinReturns.length) - lag;
      if (n < CONFIG.minLagSamples) continue;
      const xs = btcReturns.slice(0, n);
      const ys = coinReturns.slice(lag, lag + n);
      const corr = correlation(xs, ys);
      if (Number.isFinite(corr) && (!Number.isFinite(best.correlation) || corr > best.correlation)) {
        best = { minutes: lag, correlation: corr, beta: covarianceBeta(xs, ys), samples: n };
      }
    }
    return best;
  }

  function priceAt(payloadSide, interval) {
    const p = Number(payloadSide?.price);
    if (p > 0) return p;
    const current = payloadSide?.intervals?.[interval]?.current;
    const cp = Number(current?.close);
    if (cp > 0) return cp;
    const rows = normalizeBars(payloadSide?.intervals?.[interval]?.closed || payloadSide?.intervals?.[interval]?.bars || []);
    return Number(rows.at(-1)?.close);
  }

  function rollingChangePct(oneMinuteRows, currentPrice, minutes, at) {
    const rows = closedBars(oneMinuteRows, at);
    if (!(currentPrice > 0) || !rows.length) return NaN;
    const target = at - minutes * 60 * 1000;
    let reference = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].closeTime <= target) { reference = rows[i]; break; }
    }
    if (!reference || !(reference.close > 0)) return NaN;
    return (currentPrice / reference.close - 1) * 100;
  }

  function weightedMetric(rows, selector, usePositiveCorrelation = false) {
    let total = 0, weights = 0;
    for (const row of rows) {
      if (!row.ready) continue;
      const value = selector(row);
      if (!Number.isFinite(value)) continue;
      let w = row.weight;
      if (usePositiveCorrelation) w *= clamp(Number(row.correlation) || 0, 0, 1);
      if (!(w > 0)) continue;
      total += value * w; weights += w;
    }
    return weights > 0 ? total / weights : NaN;
  }

  function classify({ btc1mPct, btc3mPct, coin1mPct, coin3mPct, stats }) {
    const btcChanges = { '1m': btc1mPct, '3m': btc3mPct };
    const coinChanges = { '1m': coin1mPct, '3m': coin3mPct };
    const components = [];

    for (const s of stats) {
      const btcChange = btcChanges[s.key], coinChange = coinChanges[s.key];
      const direction = Number.isFinite(btcChange) && btcChange < 0 ? 'down' : 'up';
      const directional = direction === 'down' ? s.betaDown : s.betaUp;
      const beta = Number.isFinite(directional) ? directional : s.beta;
      const expected = Number.isFinite(btcChange) && Number.isFinite(beta) ? btcChange * beta : NaN;
      const relative = Number.isFinite(coinChange) && Number.isFinite(expected) ? coinChange - expected : NaN;
      components.push({ ...s, btcChange, coinChange, dynamicBeta: beta, expected, relative });
    }

    const weightedCorrelation = weightedMetric(components, s => s.correlation, false);
    const dynamicBeta = weightedMetric(components, s => s.dynamicBeta, true);
    const expectedPct = weightedMetric(components, s => s.expected, true);
    const relativeStrengthPct = weightedMetric(components, s => s.relative, true);
    const coinCompositePct = weightedMetric(components, s => s.coinChange, false);
    const btcCompositePct = weightedMetric(components, s => s.btcChange, false);
    const readyCount = components.filter(x => x.ready).length;
    const reliable = readyCount >= 2
      && Number.isFinite(weightedCorrelation) && weightedCorrelation >= CONFIG.minReliableCorrelation
      && Number.isFinite(dynamicBeta) && Math.abs(dynamicBeta) >= CONFIG.minReliableBeta;

    let level = 'NEUTRAL';
    let reason = 'BTC relationship is not reliable enough to block the 3m/1m LONG entry.';
    if (reliable) {
      if (Number.isFinite(expectedPct) && expectedPct <= CONFIG.strongNegativeExpectedPct) {
        level = 'STRONG_NEGATIVE'; reason = 'BTC pressure implies a strong negative short-horizon expectation for this coin.';
      } else if (Number.isFinite(expectedPct) && expectedPct <= CONFIG.negativeExpectedPct) {
        level = 'NEGATIVE'; reason = 'BTC pressure is negative for this coin on the 3m/1m horizon.';
      } else if (Number.isFinite(expectedPct) && expectedPct >= CONFIG.positiveExpectedPct) {
        level = 'POSITIVE'; reason = 'BTC context is supportive on the 3m/1m horizon.';
      } else {
        reason = 'BTC expected effect is currently small / neutral.';
      }
    }

    const strongRelative = Number.isFinite(relativeStrengthPct) && relativeStrengthPct >= CONFIG.relativeStrongPct
      && Number.isFinite(coinCompositePct) && coinCompositePct >= 0;
    const positiveRelative = Number.isFinite(relativeStrengthPct) && relativeStrengthPct >= CONFIG.relativeAllowPct
      && Number.isFinite(coinCompositePct) && coinCompositePct >= 0;

    let entryDecision = 'ALLOW';
    let entryReason = 'BTC context does not veto entry.';
    if (reliable && level === 'STRONG_NEGATIVE' && !strongRelative) {
      entryDecision = 'WAIT'; entryReason = 'Strong BTC downside plus insufficient coin relative strength.';
    } else if (reliable && level === 'NEGATIVE' && !positiveRelative
      && Number.isFinite(relativeStrengthPct) && relativeStrengthPct < 0) {
      entryDecision = 'WAIT'; entryReason = 'Negative BTC pressure and coin is underperforming its BTC-implied move.';
    } else if ((level === 'STRONG_NEGATIVE' || level === 'NEGATIVE') && (strongRelative || positiveRelative)) {
      entryReason = 'BTC is negative, but the coin has enough relative strength to avoid an entry veto.';
    }

    let followDecision = 'HOLD';
    if (reliable && level === 'STRONG_NEGATIVE'
      && (!Number.isFinite(relativeStrengthPct) || relativeStrengthPct < CONFIG.relativeAllowPct)) {
      followDecision = 'PROTECT';
    } else if (reliable && level === 'NEGATIVE'
      && Number.isFinite(relativeStrengthPct) && relativeStrengthPct <= CONFIG.followProtectRelativePct) {
      followDecision = 'PROTECT';
    }

    return {
      level, reliable, reason, entryDecision, entryReason, followDecision,
      weightedCorrelation, dynamicBeta, expectedPct, relativeStrengthPct,
      coinCompositePct, btcCompositePct,
      components: components.map(x => ({
        key: x.key, count: x.count, ready: x.ready, weight: x.weight,
        correlation: x.correlation, beta: x.beta, betaUp: x.betaUp, betaDown: x.betaDown,
        dynamicBeta: x.dynamicBeta, btcChange: x.btcChange, coinChange: x.coinChange,
        expected: x.expected, relative: x.relative
      }))
    };
  }

  async function providerPayload(symbol) {
    if (typeof marketDataProvider !== 'function') return null;
    try {
      const x = await marketDataProvider(symbol);
      return x && typeof x === 'object' ? x : null;
    } catch (_) { return null; }
  }

  async function restPayload(symbol, signal) {
    const at = now();
    const payload = {
      at,
      source: 'REST',
      btc: { intervals: {} },
      coin: { intervals: {} }
    };
    await Promise.all(CONFIG.intervals.map(async cfg => {
      const btcPromise = fetchBars('BTCUSDT', cfg, signal);
      const coinPromise = symbol === 'BTCUSDT' ? btcPromise : fetchBars(symbol, cfg, signal);
      const [btc, coin] = await Promise.all([btcPromise, coinPromise]);
      const btcRows = normalizeBars(btc), coinRows = normalizeBars(coin);
      payload.btc.intervals[cfg.key] = { bars: btcRows, closed: btcRows.filter(x => x.closeTime < at), current: btcRows.find(x => x.openTime <= at && x.closeTime >= at) || null };
      payload.coin.intervals[cfg.key] = { bars: coinRows, closed: coinRows.filter(x => x.closeTime < at), current: coinRows.find(x => x.openTime <= at && x.closeTime >= at) || null };
    }));
    payload.btc.price = priceAt(payload.btc, '1m');
    payload.coin.price = priceAt(payload.coin, '1m');
    return payload;
  }

  async function loadPayload(symbol, signal) {
    const preferred = await providerPayload(symbol);
    if (preferred?.btc?.intervals && preferred?.coin?.intervals) return { ...preferred, source: preferred.source || 'PROVIDER' };
    return restPayload(symbol, signal);
  }

  function summaryText(result) {
    const pct = x => Number.isFinite(Number(x)) ? `${Number(x) >= 0 ? '+' : ''}${Number(x).toFixed(2)}%` : '—';
    const num = x => Number.isFinite(Number(x)) ? Number(x).toFixed(2) : '—';
    const lag = Number.isFinite(Number(result?.lagMinutes)) ? `${Number(result.lagMinutes)}m` : '—';
    return `BTC ${result?.level || 'NEUTRAL'} • B1 ${pct(result?.btc1mPct)} B3 ${pct(result?.btc3mPct)} • β ${num(result?.dynamicBeta)} • Corr ${num(result?.weightedCorrelation)} • Exp ${pct(result?.expectedPct)} • Rel ${pct(result?.relativeStrengthPct)} • Lag ${lag} • ${result?.entryDecision || 'ALLOW'}`;
  }

  async function analyze(symbol, { signal = null, force = false } = {}) {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) throw new Error('BTCImpact3m1m symbol is required');

    const cached = resultCache.get(normalized);
    if (!force && cached && now() - cached.at < CONFIG.resultTtlMs) return cached.result;
    const inflightKey = `${normalized}|${signalKey(signal)}`;
    if (!force && resultInFlight.has(inflightKey)) return resultInFlight.get(inflightKey);

    const promise = (async () => {
      const payload = await loadPayload(normalized, signal);
      const at = Number(payload.at) || now();
      const btcPrice = Number(payload.btc?.price) > 0 ? Number(payload.btc.price) : priceAt(payload.btc, '1m');
      const coinPrice = Number(payload.coin?.price) > 0 ? Number(payload.coin.price) : priceAt(payload.coin, '1m');
      const oneBtc = payload.btc?.intervals?.['1m']?.closed || payload.btc?.intervals?.['1m']?.bars || [];
      const oneCoin = payload.coin?.intervals?.['1m']?.closed || payload.coin?.intervals?.['1m']?.bars || [];

      const btc1mPct = rollingChangePct(oneBtc, btcPrice, 1, at);
      const btc3mPct = rollingChangePct(oneBtc, btcPrice, 3, at);
      const coin1mPct = rollingChangePct(oneCoin, coinPrice, 1, at);
      const coin3mPct = rollingChangePct(oneCoin, coinPrice, 3, at);

      const stats = CONFIG.intervals.map(cfg => {
        const b = payload.btc?.intervals?.[cfg.key]?.closed || payload.btc?.intervals?.[cfg.key]?.bars || [];
        const c = payload.coin?.intervals?.[cfg.key]?.closed || payload.coin?.intervals?.[cfg.key]?.bars || [];
        return intervalStats(b, c, cfg, at);
      });
      const oneStats = stats.find(x => x.key === '1m');
      const lag = oneStats ? bestLag(oneStats.btcReturns, oneStats.coinReturns) : { minutes: 0, correlation: NaN, beta: NaN, samples: 0 };
      const classification = classify({ btc1mPct, btc3mPct, coin1mPct, coin3mPct, stats });

      const result = Object.freeze({
        symbol: normalized, at, dataSource: String(payload.source || 'UNKNOWN'),
        btc1mPct, btc3mPct, coin1mPct, coin3mPct,
        lagMinutes: lag.minutes, lagCorrelation: lag.correlation, lagBeta: lag.beta, lagSamples: lag.samples,
        ...classification
      });
      resultCache.set(normalized, { at: now(), result });
      return result;
    })();

    resultInFlight.set(inflightKey, promise);
    try { return await promise; }
    finally { if (resultInFlight.get(inflightKey) === promise) resultInFlight.delete(inflightKey); }
  }

  function setMarketDataProvider(provider) {
    marketDataProvider = typeof provider === 'function' ? provider : null;
    resultCache.clear();
  }

  window.BTCImpact3m1m = Object.freeze({
    analyze,
    summaryText,
    setMarketDataProvider,
    getCached: symbol => resultCache.get(String(symbol || '').trim().toUpperCase())?.result || null,
    clearCache: () => { rawCache.clear(); resultCache.clear(); rawInFlight.clear(); resultInFlight.clear(); cooldownUntil = 0; },
    getState: () => ({ cooldownUntil, providerActive: typeof marketDataProvider === 'function', rawCacheSize: rawCache.size, resultCacheSize: resultCache.size }),
    config: CONFIG
  });
})();
