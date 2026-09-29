(() => {
  'use strict';

  const VERSION = 'CoinScan.BlueprintV2.1';
  const API_BASE = 'https://fapi.binance.com';

  // Trading rules explicitly carried by CryptoBluePrintV2.
  const RULES = Object.freeze({
    direction: 'LONG',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    setupMaxAgeMs: 30 * 60_000,
    emaFast: 7,
    emaSlow: 25,
    emaContext: 99,
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    atrPeriod: 14,
    swingAtrTolerance: 0.10,
    maxValueDistanceAtr: 0.50,
    minFiveMinuteQualityPasses: 1
  });

  // The blueprint requires the swing detector/equality behavior to be versioned,
  // but does not provide numeric left/right counts. This version uses the
  // smallest confirmed local pivot: one closed bar on each side.
  const IMPLEMENTATION = Object.freeze({
    swingLeftBars: 1,
    swingRightBars: 1,
    liveDirection: 'CURRENT_PRICE_VS_OPEN',
    atrSmoothing: 'WILDER',
    rsiSmoothing: 'WILDER',
    rangeRetestZoneAtr: RULES.swingAtrTolerance,
    maxConcurrency: 6,
    klineLimit1h: 140,
    klineLimit15m: 140,
    klineLimit5m: 140,
    klineLimit3m: 3
  });

  const STABLE_BASE_ASSETS = new Set([
    'USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USD1'
  ]);

  let activeController = null;
  let lastResult = null;

  function emit(name, detail) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(`coinscan:${name}`, { detail }));
    }
  }

  function now() {
    return Date.now();
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      if (!signal) return;
      if (signal.aborted) {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  function assertNotAborted(signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  async function api(path, params = {}, signal) {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      cache: 'no-store',
      signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${path}${text ? `: ${text.slice(0, 180)}` : ''}`);
    }
    return response.json();
  }

  function validNumber(value) {
    return Number.isFinite(Number(value));
  }

  function readFastEventSettingsFromUi() {
    if (typeof document === 'undefined') {
      throw new Error('CoinScan UI inputs are unavailable.');
    }

    const secEl = document.getElementById('windowSec');
    const minEl = document.getElementById('minIncrease');
    const maxEl = document.getElementById('maxIncrease');

    if (!secEl || !minEl || !maxEl) {
      throw new Error('CoinScan requires #windowSec, #minIncrease and #maxIncrease inputs.');
    }

    const windowSec = Number(secEl.value);
    const minIncreasePct = Number(minEl.value);
    const maxIncreasePct = Number(maxEl.value);

    if (!Number.isFinite(windowSec) || windowSec <= 0) {
      throw new Error('Sec. must be greater than 0.');
    }
    if (!Number.isFinite(minIncreasePct) || minIncreasePct < 0) {
      throw new Error('MinY% must be 0 or greater.');
    }
    if (!Number.isFinite(maxIncreasePct) || maxIncreasePct <= 0) {
      throw new Error('MaxY% must be greater than 0.');
    }
    if (minIncreasePct > maxIncreasePct) {
      throw new Error('MinY% cannot be greater than MaxY%.');
    }

    return Object.freeze({
      windowSec,
      windowMs: windowSec * 1000,
      minIncreasePct,
      maxIncreasePct
    });
  }

  function pctChange(from, to) {
    const a = Number(from);
    const b = Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
    return 100 * (b / a - 1);
  }

  function parseKlines(rows) {
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
      quoteVolume: Number(r[7]),
      trades: Number(r[8]),
      takerBuyBase: Number(r[9]),
      takerBuyQuote: Number(r[10])
    })).filter((x) => [x.open, x.high, x.low, x.close].every(Number.isFinite));
  }

  function splitClosedAndOpen(candles, ts = now()) {
    const closed = candles.filter((c) => c.closeTime < ts);
    const open = candles.length && candles[candles.length - 1].closeTime >= ts
      ? candles[candles.length - 1]
      : null;
    return { closed, open };
  }

  function emaSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    let prev = seed / period;
    out[period - 1] = prev;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function trueRangeSeries(candles) {
    return candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prevClose = candles[i - 1].close;
      return Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      );
    });
  }

  function wilderSeries(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let prev = sum / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = ((prev * (period - 1)) + values[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  function atrSeries(candles, period = RULES.atrPeriod) {
    return wilderSeries(trueRangeSeries(candles), period);
  }

  function rsiSeries(candles, period = RULES.rsiPeriod) {
    const closes = candles.map((c) => c.close);
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;

    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      gain += Math.max(d, 0);
      loss += Math.max(-d, 0);
    }

    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = ((avgGain * (period - 1)) + Math.max(d, 0)) / period;
      avgLoss = ((avgLoss * (period - 1)) + Math.max(-d, 0)) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return out;
  }

  function macdSeries(candles) {
    const closes = candles.map((c) => c.close);
    const fast = emaSeries(closes, RULES.macdFast);
    const slow = emaSeries(closes, RULES.macdSlow);
    const dif = closes.map((_, i) => (
      fast[i] == null || slow[i] == null ? null : fast[i] - slow[i]
    ));

    const validStart = dif.findIndex((v) => v != null);
    const dea = new Array(closes.length).fill(null);
    if (validStart >= 0) {
      const compact = dif.slice(validStart);
      const compactDea = emaSeries(compact, RULES.macdSignal);
      compactDea.forEach((v, i) => { dea[validStart + i] = v; });
    }

    const hist = dif.map((v, i) => (
      v == null || dea[i] == null ? null : v - dea[i]
    ));
    return { dif, dea, hist };
  }

  function lastFinite(series, offset = 0) {
    let seen = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      if (Number.isFinite(series[i])) {
        if (seen === offset) return { index: i, value: series[i] };
        seen++;
      }
    }
    return null;
  }

  function findSwings(candles, atr) {
    const highs = [];
    const lows = [];
    const L = IMPLEMENTATION.swingLeftBars;
    const R = IMPLEMENTATION.swingRightBars;

    for (let i = L; i < candles.length - R; i++) {
      const a = atr[i];
      if (!Number.isFinite(a) || a <= 0) continue;
      const tolerance = a * RULES.swingAtrTolerance;
      let isHigh = true;
      let isLow = true;

      for (let j = i - L; j <= i + R; j++) {
        if (j === i) continue;
        if (candles[i].high < candles[j].high + (candles[i].high === candles[j].high ? tolerance : 0)) {
          isHigh = false;
        }
        if (candles[i].low > candles[j].low - (candles[i].low === candles[j].low ? tolerance : 0)) {
          isLow = false;
        }
      }

      if (isHigh) {
        highs.push({
          index: i,
          price: candles[i].high,
          time: candles[i].openTime,
          confirmedAt: candles[i + R].closeTime
        });
      }
      if (isLow) {
        lows.push({
          index: i,
          price: candles[i].low,
          time: candles[i].openTime,
          confirmedAt: candles[i + R].closeTime
        });
      }
    }
    return { highs, lows };
  }

  function classifyRegime1h(closed) {
    if (closed.length < 30) return { regime: 'DATA_UNAVAILABLE', reason: '1H_HISTORY_SHORT' };
    const atr = atrSeries(closed);
    const swings = findSwings(closed, atr);
    const hs = swings.highs.filter((s) => s.confirmedAt <= closed[closed.length - 1].closeTime);
    const ls = swings.lows.filter((s) => s.confirmedAt <= closed[closed.length - 1].closeTime);
    if (hs.length < 2 || ls.length < 2) {
      return { regime: 'TRANSITION', swings, reason: 'INSUFFICIENT_CONFIRMED_SWINGS' };
    }

    const h1 = hs[hs.length - 2];
    const h2 = hs[hs.length - 1];
    const l1 = ls[ls.length - 2];
    const l2 = ls[ls.length - 1];
    const lastAtr = lastFinite(atr)?.value;
    const tol = Number.isFinite(lastAtr) ? lastAtr * RULES.swingAtrTolerance : 0;

    const higherHigh = h2.price > h1.price + tol;
    const higherLow = l2.price > l1.price + tol;
    const lowerHigh = h2.price < h1.price - tol;
    const lowerLow = l2.price < l1.price - tol;
    const flatHigh = Math.abs(h2.price - h1.price) <= tol;
    const flatLow = Math.abs(l2.price - l1.price) <= tol;

    let regime = 'TRANSITION';
    if (higherHigh && higherLow) regime = 'UPTREND';
    else if (lowerHigh && lowerLow) regime = 'DOWNTREND';
    else if ((flatHigh || !higherHigh) && (flatLow || !lowerLow) && !lowerHigh && !higherLow) regime = 'RANGE';
    else if (flatHigh && flatLow) regime = 'RANGE';

    return { regime, swings, lastAtr, h1, h2, l1, l2 };
  }

  function emaContext15m(closed) {
    const closes = closed.map((c) => c.close);
    const e7 = emaSeries(closes, RULES.emaFast);
    const e25 = emaSeries(closes, RULES.emaSlow);
    const e99 = emaSeries(closes, RULES.emaContext);
    return { e7, e25, e99 };
  }

  function findPullbackSetup15m(closed, eventStartTime) {
    if (closed.length < RULES.emaContext + 3) return null;
    const { e7, e25, e99 } = emaContext15m(closed);
    const atr = atrSeries(closed);

    for (let i = closed.length - 1; i >= 0; i--) {
      const c = closed[i];
      if (c.closeTime > eventStartTime) continue;
      if (eventStartTime - c.closeTime > RULES.setupMaxAgeMs) break;
      if (![e7[i], e25[i], e99[i], atr[i]].every(Number.isFinite)) continue;

      const trendAligned = e7[i] > e25[i] && e25[i] > e99[i];
      if (!trendAligned) continue;

      const zoneLow = Math.min(e7[i], e25[i]);
      const zoneHigh = Math.max(e7[i], e25[i]);
      const touched = c.low <= zoneHigh && c.high >= zoneLow;
      const held = c.close >= zoneLow;
      if (!touched || !held) continue;

      const swings = findSwings(closed.slice(0, i + 1), atr.slice(0, i + 1));
      const priorLows = swings.lows.filter((s) => s.confirmedAt <= c.closeTime);
      const invalidation = priorLows.length ? priorLows[priorLows.length - 1].price : zoneLow;

      return {
        family: 'PULLBACK_VALUE',
        setupTime: c.closeTime,
        confirmationTime: c.closeTime,
        valueLow: zoneLow,
        valueHigh: zoneHigh,
        invalidation,
        atr15: atr[i],
        candleIndex: i
      };
    }
    return null;
  }

  function findBreakoutRetestSetup15m(closed, eventStartTime) {
    if (closed.length < 30) return null;
    const atr = atrSeries(closed);
    const swings = findSwings(closed, atr);
    const highs = swings.highs.filter((s) => s.confirmedAt <= eventStartTime);
    const lows = swings.lows.filter((s) => s.confirmedAt <= eventStartTime);
    if (highs.length < 1 || lows.length < 1) return null;

    for (let h = highs.length - 1; h >= 0; h--) {
      const resistance = highs[h];
      const level = resistance.price;
      const breakoutIndex = closed.findIndex((c, i) => i > resistance.index && c.closeTime <= eventStartTime && c.close > level);
      if (breakoutIndex < 0) continue;

      for (let i = breakoutIndex + 1; i < closed.length; i++) {
        const c = closed[i];
        if (c.closeTime > eventStartTime) break;
        if (eventStartTime - c.closeTime > RULES.setupMaxAgeMs) continue;
        const a = atr[i];
        if (!Number.isFinite(a) || a <= 0) continue;

        const zone = a * IMPLEMENTATION.rangeRetestZoneAtr;
        const retest = c.low <= level + zone && c.high >= level - zone;
        const held = c.close >= level - zone;
        if (!retest || !held) continue;

        const priorLow = lows.filter((s) => s.index < i).at(-1);
        return {
          family: 'BREAKOUT_RETEST',
          setupTime: c.closeTime,
          confirmationTime: c.closeTime,
          valueLow: level - zone,
          valueHigh: level + zone,
          invalidation: priorLow?.price ?? (level - zone),
          breakoutLevel: level,
          breakoutTime: closed[breakoutIndex].closeTime,
          atr15: a,
          candleIndex: i
        };
      }
    }
    return null;
  }

  function chooseSetup(regime, closed15m, eventStartTime) {
    if (regime === 'UPTREND') {
      return findPullbackSetup15m(closed15m, eventStartTime);
    }
    if (regime === 'RANGE') {
      return findBreakoutRetestSetup15m(closed15m, eventStartTime);
    }
    if (regime === 'TRANSITION') {
      return findPullbackSetup15m(closed15m, eventStartTime)
        || findBreakoutRetestSetup15m(closed15m, eventStartTime);
    }
    return null;
  }

  function fiveMinuteQuality(closed5m, setupTime) {
    if (closed5m.length < 40) return { pass: false, count: 0, reason: '5M_HISTORY_SHORT' };
    const eligible = closed5m.filter((c) => c.closeTime >= setupTime);
    if (!eligible.length) return { pass: false, count: 0, reason: 'NO_CLOSED_5M_AFTER_SETUP' };

    const rsi = rsiSeries(closed5m);
    const macd = macdSeries(closed5m);
    const atr = atrSeries(closed5m);
    const i = closed5m.length - 1;
    const p = i - 1;

    const rsiNow = rsi[i];
    const rsiPrev = rsi[p];
    const rsiPass = Number.isFinite(rsiNow) && Number.isFinite(rsiPrev) && rsiNow > 50 && rsiNow >= rsiPrev;

    const difNow = macd.dif[i];
    const deaNow = macd.dea[i];
    const histNow = macd.hist[i];
    const histPrev = macd.hist[p];
    const macdPass = [difNow, deaNow, histNow, histPrev].every(Number.isFinite)
      && difNow >= deaNow
      && histNow >= histPrev;

    // ATR is directionless. It only passes as a quality/activity component when
    // the last closed bar expands at least its current ATR while closing upward.
    const tr = trueRangeSeries(closed5m);
    const atrNow = atr[i];
    const atrPass = Number.isFinite(atrNow)
      && atrNow > 0
      && tr[i] >= atrNow
      && closed5m[i].close >= closed5m[i].open;

    const count = [rsiPass, macdPass, atrPass].filter(Boolean).length;
    return {
      pass: count >= RULES.minFiveMinuteQualityPasses,
      count,
      rsi: { pass: rsiPass, value: rsiNow, previous: rsiPrev },
      macd: { pass: macdPass, dif: difNow, dea: deaNow, hist: histNow, previousHist: histPrev },
      atr: { pass: atrPass, value: atrNow, trueRange: tr[i] }
    };
  }

  function valueDistanceAtr(price, setup) {
    if (!Number.isFinite(price) || !setup || !Number.isFinite(setup.atr15) || setup.atr15 <= 0) return null;
    let distance = 0;
    if (price > setup.valueHigh) distance = price - setup.valueHigh;
    else if (price < setup.valueLow) distance = setup.valueLow - price;
    return distance / setup.atr15;
  }

  function liveDirection(openCandle, currentPrice) {
    if (!openCandle || !Number.isFinite(currentPrice)) return 'UNKNOWN';
    if (currentPrice > openCandle.open) return 'UP';
    if (currentPrice < openCandle.open) return 'DOWN';
    return 'FLAT';
  }

  function currentLiveGate(direction15m, direction5m, direction3m) {
    // No additional numeric threshold is introduced: current price is compared
    // only with each open candle's opening price. 15m and 5m must not be DOWN;
    // 3m is a timing warning and may be FLAT/UP.
    const pass15 = direction15m === 'UP' || direction15m === 'FLAT';
    const pass5 = direction5m === 'UP' || direction5m === 'FLAT';
    const pass3 = direction3m !== 'DOWN';
    return { pass: pass15 && pass5 && pass3, pass15, pass5, pass3 };
  }

  function returnsFrom1h(closed1h, hours = 4) {
    if (closed1h.length < hours + 1) return null;
    const end = closed1h[closed1h.length - 1].close;
    const start = closed1h[closed1h.length - 1 - hours].close;
    return pctChange(start, end);
  }

  function relativeStrength(coinReturnPct, btcReturnPct) {
    if (!Number.isFinite(coinReturnPct) || !Number.isFinite(btcReturnPct)) return null;
    return {
      coinReturnPct,
      btcReturnPct,
      rsDifferencePctPoints: coinReturnPct - btcReturnPct,
      rsRatioPct: 100 * (((1 + coinReturnPct / 100) / (1 + btcReturnPct / 100)) - 1)
    };
  }

  function mapPrices(rows, eligibleSet) {
    const map = new Map();
    for (const row of rows) {
      if (!eligibleSet.has(row.symbol)) continue;
      const price = Number(row.price);
      if (Number.isFinite(price) && price > 0) map.set(row.symbol, price);
    }
    return map;
  }

  async function getUniverse(signal) {
    const info = await api('/fapi/v1/exchangeInfo', {}, signal);
    const symbols = info.symbols
      .filter((s) => s.status === 'TRADING')
      .filter((s) => s.quoteAsset === RULES.quoteAsset && s.marginAsset === RULES.marginAsset)
      .filter((s) => s.contractType === 'PERPETUAL')
      .filter((s) => !STABLE_BASE_ASSETS.has(s.baseAsset))
      .map((s) => s.symbol);
    return { symbols, set: new Set(symbols), serverTime: Number(info.serverTime) || null };
  }

  async function getKlines(symbol, interval, limit, signal) {
    return parseKlines(await api('/fapi/v1/klines', { symbol, interval, limit }, signal));
  }

  async function getBulkBookTicker(signal) {
    const rows = await api('/fapi/v1/ticker/bookTicker', {}, signal);
    const map = new Map();
    for (const x of rows) {
      const bid = Number(x.bidPrice);
      const ask = Number(x.askPrice);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) continue;
      map.set(x.symbol, {
        bid,
        ask,
        bidQty: Number(x.bidQty),
        askQty: Number(x.askQty),
        spreadAbs: ask - bid,
        spreadAskPct: 100 * (ask - bid) / ask
      });
    }
    return map;
  }

  async function getBulkPremium(signal) {
    const rows = await api('/fapi/v1/premiumIndex', {}, signal);
    const map = new Map();
    for (const x of rows) {
      map.set(x.symbol, {
        markPrice: validNumber(x.markPrice) ? Number(x.markPrice) : null,
        indexPrice: validNumber(x.indexPrice) ? Number(x.indexPrice) : null,
        lastFundingRate: validNumber(x.lastFundingRate) ? Number(x.lastFundingRate) : null,
        nextFundingTime: validNumber(x.nextFundingTime) ? Number(x.nextFundingTime) : null
      });
    }
    return map;
  }

  async function getOpenInterestContext(symbol, signal) {
    try {
      const rows = await api('/futures/data/openInterestHist', {
        symbol,
        period: '5m',
        limit: 2
      }, signal);
      if (!Array.isArray(rows) || rows.length < 2) return null;
      const a = Number(rows[rows.length - 2].sumOpenInterestValue);
      const b = Number(rows[rows.length - 1].sumOpenInterestValue);
      return {
        unit: 'VALUE',
        previous: Number.isFinite(a) ? a : null,
        current: Number.isFinite(b) ? b : null,
        changePct: pctChange(a, b),
        timestamp: Number(rows[rows.length - 1].timestamp) || null
      };
    } catch (_) {
      return null;
    }
  }

  async function workerMap(items, worker, concurrency, signal) {
    const results = new Array(items.length);
    let index = 0;

    async function runWorker() {
      while (true) {
        assertNotAborted(signal);
        const i = index++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }

    const count = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
    await Promise.all(Array.from({ length: count }, runWorker));
    return results;
  }

  async function analyzeCandidate(base, btcReturn4h, signal) {
    const reasons = [];
    const row = {
      coin: base.symbol,
      result: 'CAUTION',
      price: base.currentPrice,
      fastChangePct: base.fastChangePct,
      eventStartTime: base.eventStartTime,
      eventDetectedTime: base.eventDetectedTime,
      regime1h: null,
      setupFamily: null,
      setupTime: null,
      relativeStrength4h: null,
      quality5m: null,
      liveDirection: null,
      valueDistanceAtr15: null,
      valueZone: null,
      invalidation: null,
      quote: null,
      futuresContext: null,
      reasons
    };

    try {
      const raw1h = await getKlines(base.symbol, '1h', IMPLEMENTATION.klineLimit1h, signal);
      const { closed: closed1h } = splitClosedAndOpen(raw1h, base.eventDetectedTime);
      const regimeInfo = classifyRegime1h(closed1h);
      row.regime1h = regimeInfo.regime;
      row.relativeStrength4h = relativeStrength(returnsFrom1h(closed1h, 4), btcReturn4h);

      if (regimeInfo.regime === 'DATA_UNAVAILABLE') {
        reasons.push('DATA_UNAVAILABLE_1H');
        return row;
      }
      if (regimeInfo.regime === 'DOWNTREND') {
        reasons.push('LONG_BLOCKED_1H_DOWNTREND');
        return row;
      }

      const raw15m = await getKlines(base.symbol, '15m', IMPLEMENTATION.klineLimit15m, signal);
      const { closed: closed15m, open: open15m } = splitClosedAndOpen(raw15m, base.eventDetectedTime);
      const setup = chooseSetup(regimeInfo.regime, closed15m, base.eventStartTime);
      if (!setup) {
        reasons.push('NO_VALID_15M_SETUP');
        return row;
      }

      row.setupFamily = setup.family;
      row.setupTime = setup.setupTime;
      row.valueZone = { low: setup.valueLow, high: setup.valueHigh };
      row.invalidation = setup.invalidation;

      if (setup.setupTime > base.eventStartTime) {
        reasons.push('SETUP_AFTER_FAST_EVENT');
        return row;
      }
      if (base.eventStartTime - setup.setupTime > RULES.setupMaxAgeMs) {
        reasons.push('SETUP_TOO_OLD');
        return row;
      }

      const raw5m = await getKlines(base.symbol, '5m', IMPLEMENTATION.klineLimit5m, signal);
      const { closed: closed5m, open: open5m } = splitClosedAndOpen(raw5m, base.eventDetectedTime);
      const lastClosed5m = closed5m.at(-1);
      if (!lastClosed5m || lastClosed5m.closeTime < setup.setupTime) {
        reasons.push('NO_CLOSED_5M_AT_OR_AFTER_SETUP');
        return row;
      }

      const quality = fiveMinuteQuality(closed5m, setup.setupTime);
      row.quality5m = quality;
      if (!quality.pass) {
        reasons.push('5M_QUALITY_LT_1_OF_3');
        return row;
      }

      const distanceAtr = valueDistanceAtr(base.currentPrice, setup);
      row.valueDistanceAtr15 = distanceAtr;
      if (!Number.isFinite(distanceAtr)) {
        reasons.push('DATA_UNAVAILABLE_VALUE_DISTANCE');
        return row;
      }
      if (distanceAtr > RULES.maxValueDistanceAtr) {
        reasons.push('NO_CHASE_DISTANCE_GT_0_50_ATR15');
        return row;
      }

      const raw3m = await getKlines(base.symbol, '3m', IMPLEMENTATION.klineLimit3m, signal);
      const { open: open3m } = splitClosedAndOpen(raw3m, base.eventDetectedTime);
      const d15 = liveDirection(open15m, base.currentPrice);
      const d5 = liveDirection(open5m, base.currentPrice);
      const d3 = liveDirection(open3m, base.currentPrice);
      const liveGate = currentLiveGate(d15, d5, d3);
      row.liveDirection = { m15: d15, m5: d5, m3: d3, ...liveGate };

      if (!liveGate.pass) {
        reasons.push('LIVE_DIRECTION_NOT_READY');
        return row;
      }

      row.result = 'SELECT';
      reasons.push('ALL_COIN_SELECTION_RULES_PASS');
      return row;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      reasons.push(`DATA_UNAVAILABLE:${error?.message || 'UNKNOWN'}`);
      return row;
    }
  }

  async function scan() {
    if (activeController) {
      throw new Error('CoinScan is already running.');
    }

    const fastEventSettings = readFastEventSettingsFromUi();
    const controller = new AbortController();
    activeController = controller;
    const { signal } = controller;
    const startedAt = now();

    try {
      emit('progress', { stage: 'UNIVERSE', startedAt });
      const universe = await getUniverse(signal);

      emit('progress', { stage: 'SNAPSHOT_1', eligibleSymbols: universe.symbols.length });
      const snapshot1Rows = await api('/fapi/v1/ticker/price', {}, signal);
      const p1 = mapPrices(snapshot1Rows, universe.set);
      const eventStartTime = now();

      emit('progress', {
        stage: 'FAST_EVENT_WAIT',
        waitMs: fastEventSettings.windowMs,
        eventStartTime
      });
      await sleep(fastEventSettings.windowMs, signal);

      emit('progress', { stage: 'SNAPSHOT_2' });
      const snapshot2Rows = await api('/fapi/v1/ticker/price', {}, signal);
      const p2 = mapPrices(snapshot2Rows, universe.set);
      const eventDetectedTime = now();

      const eventCandidates = [];
      for (const symbol of universe.symbols) {
        const first = p1.get(symbol);
        const second = p2.get(symbol);
        const chg = pctChange(first, second);
        if (!Number.isFinite(chg)) continue;
        if (chg < fastEventSettings.minIncreasePct || chg > fastEventSettings.maxIncreasePct) continue;
        eventCandidates.push({
          symbol,
          firstPrice: first,
          currentPrice: second,
          fastChangePct: chg,
          eventStartTime,
          eventDetectedTime
        });
      }

      eventCandidates.sort((a, b) => b.fastChangePct - a.fastChangePct);
      emit('progress', {
        stage: 'FAST_EVENT_COMPLETE',
        candidateCount: eventCandidates.length
      });

      if (!eventCandidates.length) {
        const empty = {
          version: VERSION,
          startedAt,
          completedAt: now(),
          requestStrategy: 'BULK_FIRST_THEN_LAZY_PER_CANDIDATE',
          eligibleSymbols: universe.symbols.length,
          eventCandidates: 0,
          select: [],
          caution: [],
          all: []
        };
        lastResult = empty;
        emit('complete', empty);
        return empty;
      }

      // BTC 4h relative-return benchmark: one shared request for all candidates.
      const btc1hRaw = await getKlines('BTCUSDT', '1h', 8, signal);
      const btc1hClosed = splitClosedAndOpen(btc1hRaw, eventDetectedTime).closed;
      const btcReturn4h = returnsFrom1h(btc1hClosed, 4);

      emit('progress', {
        stage: 'STRUCTURE_SETUP_CONFIRMATION',
        candidateCount: eventCandidates.length
      });

      const analyzed = await workerMap(
        eventCandidates,
        async (candidate, index) => {
          const result = await analyzeCandidate(candidate, btcReturn4h, signal);
          emit('progress', {
            stage: 'CANDIDATE_ANALYZED',
            index: index + 1,
            total: eventCandidates.length,
            coin: candidate.symbol,
            result: result.result
          });
          return result;
        },
        IMPLEMENTATION.maxConcurrency,
        signal
      );

      const potentiallyUsable = analyzed.filter((x) => x.result === 'SELECT');
      let book = new Map();
      let premium = new Map();

      if (potentiallyUsable.length) {
        // Both are one bulk request and are delayed until a structural SELECT exists.
        [book, premium] = await Promise.all([
          getBulkBookTicker(signal),
          getBulkPremium(signal)
        ]);

        await workerMap(
          potentiallyUsable,
          async (row) => {
            row.quote = book.get(row.coin) || null;
            const p = premium.get(row.coin) || null;
            const oi = await getOpenInterestContext(row.coin, signal);
            row.futuresContext = p ? { ...p, openInterest5m: oi } : { openInterest5m: oi };

            if (!row.quote) {
              row.result = 'CAUTION';
              row.reasons.push('CURRENT_QUOTE_UNAVAILABLE');
            }
            return row;
          },
          IMPLEMENTATION.maxConcurrency,
          signal
        );
      }

      // Relative strength is ranking/context only; it is not a hidden LONG veto.
      analyzed.sort((a, b) => {
        if (a.result !== b.result) return a.result === 'SELECT' ? -1 : 1;
        const ar = a.relativeStrength4h?.rsDifferencePctPoints;
        const br = b.relativeStrength4h?.rsDifferencePctPoints;
        if (Number.isFinite(ar) && Number.isFinite(br) && ar !== br) return br - ar;
        return (b.fastChangePct ?? -Infinity) - (a.fastChangePct ?? -Infinity);
      });

      const result = {
        version: VERSION,
        startedAt,
        completedAt: now(),
        rules: RULES,
        implementation: IMPLEMENTATION,
        requestStrategy: 'BULK_FIRST_THEN_LAZY_PER_CANDIDATE',
        eligibleSymbols: universe.symbols.length,
        eventCandidates: eventCandidates.length,
        select: analyzed.filter((x) => x.result === 'SELECT'),
        caution: analyzed.filter((x) => x.result === 'CAUTION'),
        all: analyzed
      };

      lastResult = result;
      emit('complete', result);
      return result;
    } catch (error) {
      if (error?.name === 'AbortError') {
        emit('cancelled', { startedAt, cancelledAt: now() });
        throw error;
      }
      emit('error', { message: error?.message || String(error) });
      throw error;
    } finally {
      activeController = null;
    }
  }

  function cancel() {
    if (activeController) activeController.abort();
  }

  function getLastResult() {
    return lastResult;
  }

  const exported = Object.freeze({
    VERSION,
    RULES,
    IMPLEMENTATION,
    scan,
    cancel,
    getLastResult
  });

  if (typeof window !== 'undefined') {
    window.CoinScan = exported;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})();
