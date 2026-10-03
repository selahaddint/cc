/*
 * LongEntryConfirm.js
 *
 * Generic second-stage LONG confirmation filter.
 *
 * Input:
 *   Any upstream scanner/filter SELECT rows (StartScan, Range Scan, Squeeze Long, etc.).
 *
 * Output:
 *   SELECT / WAIT / REJECT after 4H + 15m confirmation.
 *
 * IMPORTANT:
 * - This module does NOT run Range Scan or Squeeze Long itself.
 * - confirm(sourceSummary) evaluates only sourceSummary.selects.
 * - scan({ sourceSummary }) or scan({ candidates }) are convenience entry points.
 * - Closed 4h / 15m candles are used for structure calculations.
 * - The current/open 15m candle is used only as a near-live price source.
 */

(function (global) {
  'use strict';

  const API_BASE = 'https://fapi.binance.com';

  const DEFAULT_CONFIG = Object.freeze({
    htfInterval: '4h',
    htfLimit: 72,
    htfRangeBars: 36,

    entryInterval: '15m',
    entryLimit: 180,

    swingLeft: 2,
    swingRight: 2,
    atrPeriod: 14,

    bosLookbackBars: 10,
    bosBufferAtr: 0.04,

    sweepLookbackBars: 24,
    sweepMinAtr: 0.02,

    fvgLookbackBars: 24,
    fvgMinAtr: 0.02,
    fvgFibToleranceAtr: 0.20,

    fibRetraceShallow: 0.71,
    fibRetraceDeep: 0.75,
    fibPriceToleranceAtr: 0.15,

    // 4 mandatory video-confirmation gates:
    // 4H alignment + 15m BOS + liquidity sweep + FVG/Fib overlap.
    minCoreScore: 4,
    minRiskReward: 2.0,

    volumeProfileBars: 80,
    volumeProfileBins: 28,
    pocToleranceAtr: 0.50,

    concurrency: 3,
    requestPauseMs: 100,
    timeoutMs: 12000,
    retries: 2,

    // Future HTML/Follow integration can disable this if it wants to publish state itself.
    publishState: true
  });

  let activeController = null;
  let running = false;

  const finite = v => Number.isFinite(Number(v));
  const num = v => Number(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function abortError() {
    try { return new DOMException('Aborted', 'AbortError'); }
    catch (_) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      return e;
    }
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  async function fetchJson(url, { signal, timeoutMs, retries } = {}) {
    const attempts = Math.max(1, Number(retries) + 1 || 1);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      throwIfAborted(signal);

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1000, Number(timeoutMs) || 12000)
      );
      const abortForward = () => controller.abort();
      signal?.addEventListener?.('abort', abortForward, { once: true });

      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        lastError = error?.name === 'AbortError'
          ? new Error('Request timeout')
          : error;
        if (attempt + 1 < attempts) await sleep(180 * (attempt + 1));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abortForward);
      }
    }

    throw lastError || new Error('Request failed');
  }

  function klineToCandle(k) {
    return {
      openTime: num(k?.[0]),
      open: num(k?.[1]),
      high: num(k?.[2]),
      low: num(k?.[3]),
      close: num(k?.[4]),
      volume: num(k?.[5]),
      closeTime: num(k?.[6]),
      quoteVolume: num(k?.[7])
    };
  }

  function normalizeKlines(raw) {
    return Array.isArray(raw)
      ? raw
          .map(klineToCandle)
          .filter(c => [c.open, c.high, c.low, c.close, c.volume, c.closeTime].every(Number.isFinite))
      : [];
  }

  function closedCandles(candles, now = Date.now()) {
    return candles.filter(c => Number.isFinite(c.closeTime) && c.closeTime < now);
  }

  function trueRange(candle, previousClose) {
    if (!candle) return NaN;
    if (!Number.isFinite(previousClose)) return candle.high - candle.low;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  }

  function atrSeries(candles, period = 14) {
    const output = new Array(candles.length).fill(NaN);
    if (!candles.length) return output;

    const tr = candles.map((c, i) =>
      trueRange(c, i ? candles[i - 1].close : NaN)
    );

    let rolling = 0;
    for (let i = 0; i < tr.length; i++) {
      rolling += tr[i];
      if (i >= period) rolling -= tr[i - period];
      if (i >= period - 1) output[i] = rolling / period;
    }

    return output;
  }

  function findSwings(candles, left = 2, right = 2) {
    const highs = [];
    const lows = [];

    for (let i = left; i < candles.length - right; i++) {
      let isHigh = true;
      let isLow = true;

      for (let d = 1; d <= left; d++) {
        if (candles[i].high <= candles[i - d].high) isHigh = false;
        if (candles[i].low >= candles[i - d].low) isLow = false;
      }
      for (let d = 1; d <= right; d++) {
        if (candles[i].high < candles[i + d].high) isHigh = false;
        if (candles[i].low > candles[i + d].low) isLow = false;
      }

      if (isHigh) highs.push({
        index: i,
        price: candles[i].high,
        time: candles[i].closeTime
      });
      if (isLow) lows.push({
        index: i,
        price: candles[i].low,
        time: candles[i].closeTime
      });
    }

    return { highs, lows };
  }

  function latestBefore(points, index) {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].index < index) return points[i];
    }
    return null;
  }

  function findBosAndSweep(candles, atr, cfg) {
    const swings = findSwings(candles, cfg.swingLeft, cfg.swingRight);
    const lastIndex = candles.length - 1;
    const bosStart = Math.max(
      cfg.swingLeft + cfg.swingRight + 2,
      lastIndex - cfg.bosLookbackBars + 1
    );

    let fallbackBos = null;

    for (let i = lastIndex; i >= bosStart; i--) {
      const referenceHigh = latestBefore(swings.highs, i);
      if (!referenceHigh) continue;

      const a = finite(atr[i]) ? atr[i] : 0;
      const buffer = a * cfg.bosBufferAtr;
      if (!(candles[i].close > referenceHigh.price + buffer)) continue;

      const bos = {
        index: i,
        time: candles[i].closeTime,
        close: candles[i].close,
        high: candles[i].high,
        refHigh: referenceHigh.price,
        refHighTime: referenceHigh.time,
        buffer
      };
      fallbackBos = fallbackBos || bos;

      const sweepSearchStart = Math.max(0, i - cfg.sweepLookbackBars);
      let sweep = null;

      for (let s = swings.lows.length - 1; s >= 0; s--) {
        const referenceLow = swings.lows[s];
        if (
          referenceLow.index >= i - 1 ||
          referenceLow.index < sweepSearchStart - cfg.swingLeft - cfg.swingRight
        ) continue;

        const from = Math.max(referenceLow.index + 1, sweepSearchStart);

        for (let j = i - 1; j >= from; j--) {
          const aj = finite(atr[j]) ? atr[j] : 0;
          const minPierce = aj * cfg.sweepMinAtr;
          const candle = candles[j];

          if (
            candle.low < referenceLow.price - minPierce &&
            candle.close > referenceLow.price
          ) {
            sweep = {
              index: j,
              time: candle.closeTime,
              low: candle.low,
              close: candle.close,
              refLow: referenceLow.price,
              refLowTime: referenceLow.time,
              pierce: referenceLow.price - candle.low
            };
            break;
          }
        }

        if (sweep) break;
      }

      if (sweep) return { bos, sweep, swings };
    }

    return { bos: fallbackBos, sweep: null, swings };
  }

  function findBullishFvgs(candles, atr, startIndex, cfg) {
    const last = candles.length - 1;
    const from = Math.max(
      2,
      Number.isFinite(startIndex) ? startIndex : last - cfg.fvgLookbackBars + 1,
      last - cfg.fvgLookbackBars + 1
    );

    const result = [];

    for (let i = from; i <= last; i++) {
      const left = candles[i - 2];
      const right = candles[i];
      const a = finite(atr[i]) ? atr[i] : 0;
      const minGap = a * cfg.fvgMinAtr;
      const gap = right.low - left.high;

      if (gap > minGap) {
        result.push({
          index: i,
          time: right.closeTime,
          low: left.high,
          high: right.low,
          gap,
          atr: a
        });
      }
    }

    return result;
  }

  function zonesOverlap(aLow, aHigh, bLow, bHigh, tolerance = 0) {
    return Math.max(aLow, bLow) <= Math.min(aHigh, bHigh) + Math.max(0, tolerance);
  }

  function approxVolumePoc(candles, bins = 28) {
    if (!Array.isArray(candles) || candles.length < 10) return NaN;

    const low = Math.min(...candles.map(c => c.low));
    const high = Math.max(...candles.map(c => c.high));
    if (!(high > low)) return NaN;

    const count = Math.max(8, Math.min(80, Math.round(bins) || 28));
    const width = (high - low) / count;
    const volumeByBin = new Array(count).fill(0);

    for (const candle of candles) {
      const start = clamp(Math.floor((candle.low - low) / width), 0, count - 1);
      const end = clamp(Math.floor((candle.high - low) / width), 0, count - 1);
      const coveredBins = Math.max(1, end - start + 1);
      const share = Math.max(0, candle.volume) / coveredBins;
      for (let b = start; b <= end; b++) volumeByBin[b] += share;
    }

    let best = 0;
    for (let i = 1; i < volumeByBin.length; i++) {
      if (volumeByBin[i] > volumeByBin[best]) best = i;
    }

    return low + (best + 0.5) * width;
  }

  function higherTimeframeAlignment(htfClosed, currentPrice, cfg) {
    const bars = htfClosed.slice(-Math.max(12, cfg.htfRangeBars));
    if (bars.length < 12) return { ready: false, aligned: false };

    const low = Math.min(...bars.map(c => c.low));
    const high = Math.max(...bars.map(c => c.high));
    if (!(high > low)) return { ready: false, aligned: false };

    const mid = (low + high) / 2;
    const price = finite(currentPrice) ? Number(currentPrice) : bars.at(-1).close;
    const positionPct = ((price - low) / (high - low)) * 100;

    return {
      ready: true,
      aligned: price <= mid,
      low,
      high,
      mid,
      price,
      positionPct
    };
  }

  function makeReason(parts) {
    return parts.filter(Boolean).join(' • ');
  }

  function evaluateCandidate(upstreamRow, htfRaw, entryRaw, sourceSummary, cfg) {
    const now = Date.now();
    const htfAll = normalizeKlines(htfRaw);
    const entryAll = normalizeKlines(entryRaw);
    const htfClosed = closedCandles(htfAll, now);
    const entryClosed = closedCandles(entryAll, now);

    const base = {
      ...upstreamRow,
      upstreamStrategyId: upstreamRow?.strategyId || sourceSummary?.strategyId || null,
      upstreamResult: upstreamRow?.result || 'SELECT',
      strategyId: 'LONG_CONFIRM',
      strategy: 'Long Confirm',
      confirmTimeframe: '15m',
      htfTimeframe: '4h'
    };

    if (htfClosed.length < 16 || entryClosed.length < 40) {
      return {
        ...base,
        result: 'REJECT',
        signalType: 'INSUFFICIENT_DATA',
        coreScore: 0,
        checklistTotal: 4,
        reason: '4H/15m confirmation verisi yetersiz'
      };
    }

    const liveFromOpen = entryAll.at(-1)?.close;
    const currentPrice = finite(liveFromOpen) && liveFromOpen > 0
      ? liveFromOpen
      : finite(upstreamRow?.currentPrice)
        ? Number(upstreamRow.currentPrice)
        : entryClosed.at(-1).close;

    const atr = atrSeries(entryClosed, cfg.atrPeriod);
    const atr15 = atr.at(-1);
    const htf = higherTimeframeAlignment(htfClosed, currentPrice, cfg);
    const structure = findBosAndSweep(entryClosed, atr, cfg);
    const bos = structure.bos;
    const sweep = structure.sweep;

    let impulseLow = NaN;
    let impulseHigh = NaN;
    let fibZoneLow = NaN;
    let fibZoneHigh = NaN;
    let suggestedEntry = NaN;
    let targetPrice = NaN;
    let stopPrice = NaN;
    let fvgs = [];
    let alignedFvg = null;

    if (sweep && bos) {
      const originBars = entryClosed.slice(sweep.index, bos.index + 1);
      const impulseBars = entryClosed.slice(sweep.index, entryClosed.length);

      impulseLow = Math.min(...originBars.map(c => c.low));
      impulseHigh = Math.max(...impulseBars.map(c => c.high));

      if (impulseHigh > impulseLow) {
        const span = impulseHigh - impulseLow;
        const deep = impulseHigh - cfg.fibRetraceDeep * span;
        const shallow = impulseHigh - cfg.fibRetraceShallow * span;

        fibZoneLow = Math.min(deep, shallow);
        fibZoneHigh = Math.max(deep, shallow);
        suggestedEntry = (fibZoneLow + fibZoneHigh) / 2;
        stopPrice = impulseLow;
        targetPrice = impulseHigh;

        fvgs = findBullishFvgs(entryClosed, atr, sweep.index + 1, cfg);
        const tolerance = (finite(atr15) ? atr15 : 0) * cfg.fvgFibToleranceAtr;
        alignedFvg = [...fvgs].reverse().find(fvg =>
          zonesOverlap(fvg.low, fvg.high, fibZoneLow, fibZoneHigh, tolerance)
        ) || null;
      }
    }

    const htfAligned = !!htf.aligned;
    const bosOk = !!bos;
    const sweepOk = !!sweep;
    const imbalanceOk = !!alignedFvg;
    const coreScore = [htfAligned, bosOk, sweepOk, imbalanceOk].filter(Boolean).length;

    const priceTolerance = (finite(atr15) ? atr15 : 0) * cfg.fibPriceToleranceAtr;
    const fibReady =
      finite(fibZoneLow) && finite(fibZoneHigh) &&
      currentPrice >= fibZoneLow - priceTolerance &&
      currentPrice <= fibZoneHigh + priceTolerance;

    const aboveFib = finite(fibZoneHigh) && currentPrice > fibZoneHigh + priceTolerance;
    const belowFib = finite(fibZoneLow) && currentPrice < fibZoneLow - priceTolerance;

    const postBosMin = bos
      ? Math.min(...entryClosed
          .slice(Math.min(entryClosed.length - 1, bos.index + 1))
          .map(c => c.low))
      : NaN;

    const invalidated = finite(stopPrice) && (
      currentPrice <= stopPrice ||
      (finite(postBosMin) && postBosMin <= stopPrice)
    );

    const risk = finite(stopPrice) ? currentPrice - stopPrice : NaN;
    const reward = finite(targetPrice) ? targetPrice - currentPrice : NaN;
    const riskReward = risk > 0 && reward > 0 ? reward / risk : NaN;
    const rrOk = finite(riskReward) && riskReward >= cfg.minRiskReward;

    const profileBars = entryClosed.slice(-Math.max(30, cfg.volumeProfileBars));
    const pocApprox = approxVolumePoc(profileBars, cfg.volumeProfileBins);
    const pocTolerance = (finite(atr15) ? atr15 : 0) * cfg.pocToleranceAtr;
    const pocAligned =
      finite(pocApprox) && finite(fibZoneLow) && finite(fibZoneHigh) &&
      pocApprox >= fibZoneLow - pocTolerance &&
      pocApprox <= fibZoneHigh + pocTolerance;

    let result = 'REJECT';
    let signalType = 'CONFIRM_REJECT';

    if (!invalidated && coreScore >= cfg.minCoreScore) {
      if (fibReady && rrOk) {
        result = 'SELECT';
        signalType = 'FINAL_ENTRY_READY';
      } else if (aboveFib) {
        result = 'WAIT';
        signalType = 'WAIT_FIB_RETRACE';
      } else if (fibReady && !rrOk) {
        result = 'WAIT';
        signalType = 'WAIT_RR';
      } else if (belowFib) {
        result = 'REJECT';
        signalType = 'FIB_ZONE_MISSED';
      }
    } else if (invalidated) {
      signalType = 'INVALIDATED';
    }

    const strength = result === 'SELECT'
      ? (pocAligned && riskReward >= 2.5 ? 'STRONG' : 'VALID')
      : result === 'WAIT'
        ? 'PENDING'
        : 'REJECT';

    const upstreamLabel = String(sourceSummary?.sourceLabel || sourceSummary?.strategy || upstreamRow?.strategy || 'Grid SELECT');
    const reason = makeReason([
      `${upstreamLabel} ✓`,
      `4H discount ${htfAligned ? '✓' : '✗'}`,
      `15m BOS ${bosOk ? '✓' : '✗'}`,
      `Sweep ${sweepOk ? '✓' : '✗'}`,
      `FVG/Fib ${imbalanceOk ? '✓' : '✗'}`,
      `Confirm ${coreScore}/4`,
      finite(riskReward) ? `R/R ${riskReward.toFixed(2)}` : 'R/R —',
      pocAligned ? 'POC bonus ✓' : 'POC bonus —',
      signalType
    ]);

    return {
      ...base,
      result,
      signalType,
      strength,
      reason,

      period: sourceSummary?.period || upstreamRow?.period,
      periodLabel: sourceSummary?.periodLabel || upstreamRow?.periodLabel,
      timeframe: sourceSummary?.timeframe || upstreamRow?.timeframe,
      timeframeLabel: sourceSummary?.timeframeLabel || upstreamRow?.timeframeLabel,

      currentPrice,
      entryPrice: result === 'SELECT' ? currentPrice : suggestedEntry,
      suggestedEntry,
      stopPrice,
      targetPrice,
      riskReward,

      checklistTotal: 4,
      coreScore,
      tradeScorePct: coreScore * 25,

      htfAligned,
      htfDiscount: htfAligned,
      htfLow: htf.low,
      htfHigh: htf.high,
      htfMid: htf.mid,
      htfPositionPct: htf.positionPct,

      bosOk,
      bosTime: bos?.time || null,
      bosClose: bos?.close,
      bosReferenceHigh: bos?.refHigh,

      sweepOk,
      sweepTime: sweep?.time || null,
      sweepLow: sweep?.low,
      sweepReferenceLow: sweep?.refLow,

      imbalanceOk,
      fvgLow: alignedFvg?.low,
      fvgHigh: alignedFvg?.high,
      fvgTime: alignedFvg?.time || null,
      fvgCount: fvgs.length,

      impulseLow,
      impulseHigh,
      fibRetraceShallow: cfg.fibRetraceShallow,
      fibRetraceDeep: cfg.fibRetraceDeep,
      fibZoneLow,
      fibZoneHigh,
      fibReady,
      aboveFib,
      belowFib,
      invalidated,

      atr15,
      pocApprox,
      pocAligned,
      pocIsApproximation: true
    };
  }

  async function mapWithConcurrency(items, concurrency, worker, signal, pauseMs = 0, onDone = null) {
    const output = new Array(items.length);
    let nextIndex = 0;

    async function runner() {
      while (true) {
        throwIfAborted(signal);
        const index = nextIndex++;
        if (index >= items.length) return;

        try {
          output[index] = await worker(items[index], index);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          output[index] = { error, item: items[index] };
        }

        if (typeof onDone === 'function') onDone(output[index], index);
        if (pauseMs > 0) await sleep(pauseMs);
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(items.length || 1, concurrency || 1)) },
        () => runner()
      )
    );

    return output;
  }

  async function analyzeCandidate(upstreamRow, sourceSummary, cfg, signal) {
    const symbol = String(upstreamRow?.symbol || upstreamRow?.coin || '')
      .trim()
      .toUpperCase();

    if (!symbol) throw new Error('Missing symbol');
    const encoded = encodeURIComponent(symbol);

    const [htfRaw, entryRaw] = await Promise.all([
      fetchJson(
        `${API_BASE}/fapi/v1/klines?symbol=${encoded}&interval=${encodeURIComponent(cfg.htfInterval)}&limit=${cfg.htfLimit}`,
        { signal, timeoutMs: cfg.timeoutMs, retries: cfg.retries }
      ),
      fetchJson(
        `${API_BASE}/fapi/v1/klines?symbol=${encoded}&interval=${encodeURIComponent(cfg.entryInterval)}&limit=${cfg.entryLimit}`,
        { signal, timeoutMs: cfg.timeoutMs, retries: cfg.retries }
      )
    ]);

    return evaluateCandidate(upstreamRow, htfRaw, entryRaw, sourceSummary, cfg);
  }

  function sortFinal(a, b) {
    const rank = result => result === 'SELECT' ? 0 : result === 'WAIT' ? 1 : 2;

    const resultDifference = rank(a.result) - rank(b.result);
    if (resultDifference) return resultDifference;

    if ((b.coreScore || 0) !== (a.coreScore || 0)) {
      return (b.coreScore || 0) - (a.coreScore || 0);
    }

    if ((b.pocAligned ? 1 : 0) !== (a.pocAligned ? 1 : 0)) {
      return (b.pocAligned ? 1 : 0) - (a.pocAligned ? 1 : 0);
    }

    return (Number(b.riskReward) || 0) - (Number(a.riskReward) || 0);
  }

  function publishState(summary, cfg) {
    if (cfg?.publishState === false) return;

    try {
      global.CryptoOfferData = global.CryptoOfferData || {};
      const state = {
        startedAt: summary?.startedAt || Date.now(),
        completedAt: summary?.completedAt || Date.now(),
        period: summary?.period,
        periodLabel: summary?.periodLabel,
        timeframe: summary?.timeframe,
        timeframeLabel: summary?.timeframeLabel,
        confirmTimeframe: '15m',
        htfTimeframe: '4h',
        strategyId: 'LONG_CONFIRM',
        results: Array.isArray(summary?.all) ? summary.all : [],
        selects: Array.isArray(summary?.selects) ? summary.selects : [],
        waits: Array.isArray(summary?.waits) ? summary.waits : [],
        rejects: Array.isArray(summary?.rejects) ? summary.rejects : []
      };
      global.CryptoOfferData.longEntryConfirmState = state;
      // Compatibility for existing Follow.js builds that already read this state name.
      global.CryptoOfferData.rangeVideoLongState = state;
    } catch (_) {}
  }

  async function confirm(sourceSummary, options = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const onProgress = typeof options.onProgress === 'function'
      ? options.onProgress
      : () => {};
    const startedAt = Number(options.startedAt) || Date.now();
    const signal = options.signal || null;

    // Generic filter: only upstream SELECT rows are evaluated.
    const upstreamCandidates = Array.isArray(sourceSummary?.selects)
      ? sourceSummary.selects.filter(row => String(row?.result || '').toUpperCase() === 'SELECT')
      : [];

    onProgress({
      phase: 'confirm_input',
      upstreamStrategyId: sourceSummary?.strategyId,
      upstreamSelectCount: upstreamCandidates.length,
      candidateCount: upstreamCandidates.length
    });

    if (!upstreamCandidates.length) {
      const completedAt = Date.now();
      const empty = {
        strategyId: 'LONG_CONFIRM',
        strategy: 'Long Confirm',
        startedAt,
        completedAt,

        period: sourceSummary?.period,
        periodLabel: sourceSummary?.periodLabel,
        timeframe: sourceSummary?.timeframe,
        timeframeLabel: sourceSummary?.timeframeLabel,
        confirmTimeframe: '15m',
        htfTimeframe: '4h',

        upstreamStrategyId: sourceSummary?.strategyId || null,
        upstreamSelectCount: 0,
        selectCount: 0,
        waitCount: 0,
        rejectCount: 0,
        errorCount: 0,
        elapsedMs: completedAt - startedAt,

        selects: [],
        waits: [],
        rejects: [],
        all: [],
        errors: [],
        sourceSummary,
        config: cfg
      };

      publishState(empty, cfg);
      onProgress({ phase: 'done', candidateCount: 0, selectCount: 0, waitCount: 0, rejectCount: 0 });

      try {
        global.dispatchEvent(new CustomEvent('longentryconfirm:results', { detail: empty }));
      } catch (_) {}

      return empty;
    }

    onProgress({
      phase: 'confirm_start',
      candidateCount: upstreamCandidates.length
    });

    let done = 0;
    const raw = await mapWithConcurrency(
      upstreamCandidates,
      cfg.concurrency,
      row => analyzeCandidate(row, sourceSummary, cfg, signal),
      signal,
      cfg.requestPauseMs,
      result => {
        done++;
        const row = result?.error ? result.item : result;
        onProgress({
          phase: 'confirm',
          done,
          total: upstreamCandidates.length,
          symbol: row?.symbol || row?.coin,
          lastResult: result?.error ? 'ERROR' : result?.result
        });
      }
    );

    const errors = [];
    const evaluated = [];

    for (const item of raw) {
      if (!item) continue;
      if (item.error) {
        errors.push({
          stage: 'LONG_CONFIRM',
          symbol: item.item?.symbol || item.item?.coin,
          message: item.error?.message || String(item.error)
        });
      } else {
        evaluated.push(item);
      }
    }

    evaluated.sort(sortFinal);

    const selects = evaluated.filter(row => row.result === 'SELECT');
    const waits = evaluated.filter(row => row.result === 'WAIT');
    const rejects = evaluated.filter(row => row.result === 'REJECT');
    const completedAt = Date.now();

    const summary = {
      strategyId: 'LONG_CONFIRM',
      strategy: 'Long Confirm',
      startedAt,
      completedAt,

      period: sourceSummary?.period,
      periodLabel: sourceSummary?.periodLabel,
      timeframe: sourceSummary?.timeframe,
      timeframeLabel: sourceSummary?.timeframeLabel,
      confirmTimeframe: '15m',
      htfTimeframe: '4h',

      upstreamStrategyId: sourceSummary?.strategyId || null,
      upstreamSelectCount: upstreamCandidates.length,
      selectCount: selects.length,
      waitCount: waits.length,
      rejectCount: rejects.length,
      errorCount: errors.length,
      elapsedMs: completedAt - startedAt,

      selects,
      waits,
      rejects,
      all: evaluated,
      errors,
      sourceSummary,
      config: cfg
    };

    publishState(summary, cfg);

    onProgress({
      phase: 'done',
      candidateCount: upstreamCandidates.length,
      selectCount: selects.length,
      waitCount: waits.length,
      rejectCount: rejects.length,
      errorCount: errors.length
    });

    try {
      global.dispatchEvent(new CustomEvent('longentryconfirm:results', { detail: summary }));
    } catch (_) {}

    return summary;
  }

  async function scan(options = {}) {
    if (running) throw new Error('LongEntryConfirm is already running.');

    if (activeController) activeController.abort();
    activeController = new AbortController();
    const signal = activeController.signal;

    if (options.signal) {
      if (options.signal.aborted) activeController.abort();
      else options.signal.addEventListener('abort', () => activeController.abort(), { once: true });
    }

    const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const startedAt = Date.now();
    running = true;

    try {
      let sourceSummary = options.sourceSummary || null;

      if (!sourceSummary && Array.isArray(options.candidates)) {
        const candidates = options.candidates
          .filter(Boolean)
          .map(row => ({ ...row, result: 'SELECT' }));
        sourceSummary = {
          strategyId: options.upstreamStrategyId || 'GRID_SELECT_SOURCE',
          strategy: options.sourceLabel || 'Grid SELECT',
          sourceLabel: options.sourceLabel || 'Grid SELECT',
          startedAt,
          completedAt: Date.now(),
          selects: candidates,
          all: candidates
        };
      }

      if (!sourceSummary) {
        throw new Error('LongEntryConfirm requires sourceSummary or candidates.');
      }

      return await confirm(sourceSummary, {
        ...options,
        config: cfg,
        signal,
        startedAt,
        onProgress
      });
    } finally {
      running = false;
    }
  }

  function confirmCandidates(candidates, options = {}) {
    return scan({ ...options, candidates });
  }

  function stop() {
    try { activeController?.abort(); } catch (_) {}
    activeController = null;
    running = false;
  }

  global.LongEntryConfirm = Object.freeze({
    scan,
    confirm,
    confirmCandidates,
    stop,
    isRunning: () => running,
    DEFAULT_CONFIG
  });

})(window);
