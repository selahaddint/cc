/*
 * RangeSqueezeLongScan.js
 *
 * Combined LONG scanner:
 *   Stage 1: RangeBreakoutScan finds fresh breakout / breakout-attempt / near-breakout candidates.
 *   Stage 2: Ema200SqueezeLongScan is applied ONLY to those candidates.
 *
 * Neither source algorithm is modified here.
 *
 * Final mapping:
 *   Range SELECT            + Squeeze SELECT -> SELECT / CONFIRMED_BREAKOUT
 *   Range BREAKOUT_ATTEMPT  + Squeeze SELECT -> SELECT / EARLY_BREAKOUT
 *   Range NEAR_BREAKOUT     + Squeeze SELECT -> WAIT   / EARLY_WATCH
 *   Any accepted Range      + Squeeze WAIT   -> WAIT
 *   Any accepted Range      + Squeeze REJECT -> REJECT
 */

(function (global) {
  'use strict';

  let running = false;

  function finite(v) {
    return Number.isFinite(Number(v));
  }

  function uniqueBySymbol(rows) {
    const out = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const symbol = String(row?.symbol || '').trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push(row);
    }
    return out;
  }

  function mapBySymbol(rows) {
    return new Map((Array.isArray(rows) ? rows : [])
      .filter(r => r?.symbol)
      .map(r => [String(r.symbol).toUpperCase(), r]));
  }

  function rangePriority(result) {
    const r = String(result || '').toUpperCase();
    if (r === 'SELECT') return 0;
    if (r === 'BREAKOUT_ATTEMPT') return 1;
    if (r === 'NEAR_BREAKOUT') return 2;
    return 9;
  }

  function combineRow(rangeRow, squeezeRow, rangeSummary, squeezeSummary) {
    const rr = String(rangeRow?.result || '').toUpperCase();
    const sr = String(squeezeRow?.result || 'REJECT').toUpperCase();

    let result = 'REJECT';
    let signalType = 'FILTERED_OUT';

    if (sr === 'SELECT') {
      if (rr === 'SELECT') {
        result = 'SELECT';
        signalType = 'CONFIRMED_BREAKOUT';
      } else if (rr === 'BREAKOUT_ATTEMPT') {
        result = 'SELECT';
        signalType = 'EARLY_BREAKOUT';
      } else if (rr === 'NEAR_BREAKOUT') {
        result = 'WAIT';
        signalType = 'EARLY_WATCH';
      }
    } else if (sr === 'WAIT') {
      result = 'WAIT';
      signalType = rr === 'SELECT'
        ? 'BREAKOUT_WAIT_SQUEEZE'
        : rr === 'BREAKOUT_ATTEMPT'
          ? 'ATTEMPT_WAIT_SQUEEZE'
          : 'NEAR_WAIT_SQUEEZE';
    }

    const currentPrice = finite(squeezeRow?.currentPrice)
      ? Number(squeezeRow.currentPrice)
      : finite(rangeRow?.currentPrice)
        ? Number(rangeRow.currentPrice)
        : NaN;

    const reason = [
      `Range=${rr || '—'}`,
      `Squeeze=${sr || '—'}`,
      signalType,
      rangeRow?.reason ? `Range: ${rangeRow.reason}` : '',
      squeezeRow?.reason ? `Squeeze: ${squeezeRow.reason}` : ''
    ].filter(Boolean).join(' • ');

    return {
      strategyId: 'RANGE_SQUEEZE_LONG',
      strategyLabel: 'Range + EMA200 Squeeze LONG',

      symbol: rangeRow?.symbol || squeezeRow?.symbol,
      result,
      signalType,
      strength: squeezeRow?.strength || (result === 'SELECT' ? 'NORMAL' : 'WATCH'),

      // Combined scan context.
      rangeResult: rr,
      squeezeResult: sr,
      period: rangeSummary?.period,
      periodLabel: rangeSummary?.periodLabel,
      interval: rangeRow?.interval || rangeSummary?.interval,
      timeframe: squeezeSummary?.timeframe,
      timeframeLabel: squeezeSummary?.timeframeLabel,

      currentPrice,
      signalCloseTime: squeezeRow?.signalCloseTime || rangeRow?.breakoutTime || null,

      // Range fields kept flat for UI / details / history.
      rangeLow: rangeRow?.rangeLow,
      rangeHigh: rangeRow?.rangeHigh,
      rangeWidthPct: rangeRow?.rangeWidthPct,
      rangeSlopePct: rangeRow?.rangeSlopePct,
      rangeBars: rangeRow?.rangeBars,
      rangeStartTime: rangeRow?.rangeStartTime,
      rangeEndTime: rangeRow?.rangeEndTime,
      rangeScore: rangeRow?.rangeScore,
      highTouches: rangeRow?.highTouches,
      lowTouches: rangeRow?.lowTouches,
      atr: rangeRow?.atr,
      breakoutBuffer: rangeRow?.breakoutBuffer,
      breakoutLevel: rangeRow?.breakoutLevel,
      maxSelectPrice: rangeRow?.maxSelectPrice,
      breakoutPctAboveRangeHigh: rangeRow?.breakoutPctAboveRangeHigh,
      breakoutTime: rangeRow?.breakoutTime,
      volumeRatio: rangeRow?.volumeRatio,

      // Squeeze fields kept flat so existing Follow / details can read them.
      ema200: squeezeRow?.ema200,
      stopPrice: squeezeRow?.stopPrice,
      stopBufferPct: squeezeRow?.stopBufferPct,
      targetPct: squeezeRow?.targetPct,
      targetPrice: squeezeRow?.targetPrice,

      priceAboveEma200: squeezeRow?.priceAboveEma200,
      swingGreen: squeezeRow?.swingGreen,
      momentumZ: squeezeRow?.momentumZ,
      momentumRecentMin: squeezeRow?.momentumRecentMin,
      momentumBelow2Recently: squeezeRow?.momentumBelow2Recently,
      momentumTurningUp: squeezeRow?.momentumTurningUp,

      macdLine: squeezeRow?.macdLine,
      macdSignal: squeezeRow?.macdSignal,
      macdHistogram: squeezeRow?.macdHistogram,
      macdHistogramSequence: squeezeRow?.macdHistogramSequence,
      macdHistogramWeakening3: squeezeRow?.macdHistogramWeakening3,
      macdBullishCross: squeezeRow?.macdBullishCross,
      heikinAshiDoji: squeezeRow?.heikinAshiDoji,

      squeezeValue: squeezeRow?.squeezeValue,
      squeezeSignal: squeezeRow?.squeezeSignal,

      quoteVolume24h: finite(rangeRow?.quoteVolume24h)
        ? rangeRow.quoteVolume24h
        : squeezeRow?.quoteVolume24h,
      priceChangePct24h: finite(rangeRow?.priceChangePct24h)
        ? rangeRow.priceChangePct24h
        : squeezeRow?.priceChangePct24h,

      reason,

      // Nested copies are useful for debugging/backtest and do not change either source algorithm.
      range: rangeRow || null,
      squeeze: squeezeRow || null
    };
  }

  function sortFinal(a, b) {
    // SELECT before WAIT before REJECT.
    const resultRank = r => r === 'SELECT' ? 0 : r === 'WAIT' ? 1 : 2;
    const rd = resultRank(a.result) - resultRank(b.result);
    if (rd) return rd;

    // Within same result, fresh confirmed breakout first, then breakout attempt, then near.
    const rp = rangePriority(a.rangeResult) - rangePriority(b.rangeResult);
    if (rp) return rp;

    // STRONG squeeze before normal.
    if (a.strength !== b.strength) {
      if (a.strength === 'STRONG') return -1;
      if (b.strength === 'STRONG') return 1;
    }

    // Prefer price that has run less above RangeHigh.
    const ad = finite(a.breakoutPctAboveRangeHigh) ? Math.abs(Number(a.breakoutPctAboveRangeHigh)) : Infinity;
    const bd = finite(b.breakoutPctAboveRangeHigh) ? Math.abs(Number(b.breakoutPctAboveRangeHigh)) : Infinity;
    if (ad !== bd) return ad - bd;

    return (Number(b.rangeScore) || 0) - (Number(a.rangeScore) || 0);
  }

  async function scan(options = {}) {
    if (running) throw new Error('RangeSqueezeLongScan is already running.');

    if (!global.RangeBreakoutScan || typeof global.RangeBreakoutScan.scan !== 'function') {
      throw new Error('RangeBreakoutScan.scan() is not available.');
    }
    if (!global.Ema200SqueezeLongScan || typeof global.Ema200SqueezeLongScan.scan !== 'function') {
      throw new Error('Ema200SqueezeLongScan.scan() is not available.');
    }

    running = true;
    const startedAt = Date.now();
    const period = options.period || options.rangePeriod || '1M';
    const timeframe = options.timeframe || options.interval || '5m';
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    try {
      onProgress({ phase: 'range_start', period, timeframe });

      const rangeSummary = await global.RangeBreakoutScan.scan({
        period,
        symbols: options.symbols,
        config: options.rangeConfig,
        onProgress: p => onProgress({
          phase: 'range',
          period,
          timeframe,
          source: p
        })
      });

      // Range scan already classifies "near" as BREAKOUT_ATTEMPT + NEAR_BREAKOUT.
      const rangeCandidates = uniqueBySymbol([
        ...(Array.isArray(rangeSummary?.selects) ? rangeSummary.selects : []),
        ...(Array.isArray(rangeSummary?.near) ? rangeSummary.near : [])
      ]);

      const symbols = rangeCandidates.map(r => r.symbol);

      onProgress({
        phase: 'range_done',
        period,
        timeframe,
        rangeScanned: Number(rangeSummary?.scanned) || 0,
        rangeSelectCount: Number(rangeSummary?.selectCount) || 0,
        rangeNearCount: Number(rangeSummary?.nearCount) || 0,
        candidateCount: symbols.length
      });

      if (!symbols.length) {
        const completedAt = Date.now();
        const empty = {
          strategyId: 'RANGE_SQUEEZE_LONG',
          strategy: 'Range + EMA200 Squeeze LONG',
          startedAt,
          completedAt,
          period: rangeSummary?.period || period,
          periodLabel: rangeSummary?.periodLabel,
          rangeInterval: rangeSummary?.interval,
          timeframe,
          timeframeLabel: global.Ema200SqueezeLongScan.TIMEFRAMES?.[timeframe]?.label || timeframe,
          scanned: Number(rangeSummary?.scanned) || 0,
          rangeCandidateCount: 0,
          selectCount: 0,
          waitCount: 0,
          rejectCount: 0,
          elapsedMs: completedAt - startedAt,
          selects: [],
          waits: [],
          rejects: [],
          all: [],
          rangeSummary,
          squeezeSummary: null,
          errors: Array.isArray(rangeSummary?.errors) ? rangeSummary.errors : []
        };
        onProgress({ phase: 'done', selectCount: 0, waitCount: 0, candidateCount: 0 });
        try {
          global.dispatchEvent(new CustomEvent('rangesqueeze:results', { detail: empty }));
        } catch (_) {}
        return empty;
      }

      onProgress({ phase: 'squeeze_start', period, timeframe, candidateCount: symbols.length });

      const squeezeSummary = await global.Ema200SqueezeLongScan.scan({
        timeframe,
        symbols,
        config: options.squeezeConfig,
        onProgress: p => onProgress({
          phase: 'squeeze',
          period,
          timeframe,
          candidateCount: symbols.length,
          source: p
        })
      });

      const squeezeMap = mapBySymbol(squeezeSummary?.all);
      const combined = rangeCandidates
        .map(rangeRow => combineRow(
          rangeRow,
          squeezeMap.get(String(rangeRow.symbol).toUpperCase()) || null,
          rangeSummary,
          squeezeSummary
        ))
        .sort(sortFinal);

      const selects = combined.filter(r => r.result === 'SELECT');
      const waits = combined.filter(r => r.result === 'WAIT');
      const rejects = combined.filter(r => r.result === 'REJECT');

      const completedAt = Date.now();
      const errors = [
        ...(Array.isArray(rangeSummary?.errors) ? rangeSummary.errors.map(e => ({ stage: 'RANGE', ...e })) : []),
        ...(Array.isArray(squeezeSummary?.errors) ? squeezeSummary.errors.map(e => ({ stage: 'SQUEEZE', ...e })) : [])
      ];

      const summary = {
        strategyId: 'RANGE_SQUEEZE_LONG',
        strategy: 'Range + EMA200 Squeeze LONG',
        startedAt,
        completedAt,

        period: rangeSummary?.period || period,
        periodLabel: rangeSummary?.periodLabel,
        rangeInterval: rangeSummary?.interval,

        timeframe: squeezeSummary?.timeframe || timeframe,
        timeframeLabel: squeezeSummary?.timeframeLabel,

        scanned: Number(rangeSummary?.scanned) || 0,
        rangeCandidateCount: rangeCandidates.length,

        rangeSelectCount: Number(rangeSummary?.selectCount) || 0,
        rangeNearCount: Number(rangeSummary?.nearCount) || 0,

        selectCount: selects.length,
        waitCount: waits.length,
        rejectCount: rejects.length,
        errorCount: errors.length,
        elapsedMs: completedAt - startedAt,

        selects,
        waits,
        rejects,
        all: combined,
        errors,

        rangeSummary,
        squeezeSummary
      };

      onProgress({
        phase: 'done',
        period: summary.period,
        timeframe: summary.timeframe,
        candidateCount: rangeCandidates.length,
        selectCount: selects.length,
        waitCount: waits.length,
        rejectCount: rejects.length
      });

      try {
        global.dispatchEvent(new CustomEvent('rangesqueeze:results', { detail: summary }));
      } catch (_) {}

      return summary;
    } finally {
      running = false;
    }
  }

  function stop() {
    try { global.RangeBreakoutScan?.stop?.(); } catch (_) {}
    try { global.Ema200SqueezeLongScan?.stop?.(); } catch (_) {}
    running = false;
  }

  global.RangeSqueezeLongScan = Object.freeze({
    scan,
    stop,
    isRunning: () => running
  });

})(window);
