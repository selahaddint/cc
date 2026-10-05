(() => {
  'use strict';

  // AutoWatch.js — SIMPLE POST-SELECT ENTRY TIMING
  //
  // P0 = price when 3m-1m scanner produces SELECT.
  // Every Auto3m1m cycle (~5 seconds):
  //   P1 > P0      => first rise, WAIT 1/2
  //   P2 > P1      => second consecutive rise, GREEN
  //
  // Nothing else is checked here.
  // No HL / EMA / MACD / ATR / R/R / BTC Impact / candle analysis / REST.

  const MAX_AGE_MS = 6 * 60 * 1000;
  const REQUIRED_RISES = 2;
  const items = new Map();

  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  };

  const normalizeSymbol = symbol => String(symbol || '').trim().toUpperCase();

  function basePriceOf(row) {
    for (const value of [row?.decisionPrice, row?.snapshot2, row?.price]) {
      const n = num(value);
      if (n > 0) return n;
    }
    return NaN;
  }

  function track(row, { at = Date.now() } = {}) {
    const symbol = normalizeSymbol(row?.symbol);
    if (!symbol) return false;

    const current = items.get(symbol);
    if (current) {
      current.row = { ...row };
      current.lastSelectAt = at;
      return true;
    }

    const basePrice = basePriceOf(row);
    if (!(basePrice > 0)) return false;

    items.set(symbol, {
      symbol,
      row: { ...row },
      basePrice,
      previousPrice: basePrice,
      riseStreak: 0,
      addedAt: at,
      lastSelectAt: at,
      signal: {
        status: 'WAIT',
        label: 'WAIT',
        reason: 'SELECT alındı; ilk yukarı fiyat hareketi bekleniyor.',
        at,
        price: basePrice,
        p0: basePrice,
        previousPrice: basePrice,
        riseStreak: 0,
        requiredRises: REQUIRED_RISES
      }
    });
    return true;
  }

  function remove(symbol) {
    return items.delete(normalizeSymbol(symbol));
  }

  function reset() {
    items.clear();
  }

  function evaluate({ at = Date.now(), getPrice, reservedSymbols = new Set() } = {}) {
    const greenRows = [];
    const examples = [];
    let green = 0;
    let wait = 0;

    for (const [symbol, item] of [...items.entries()]) {
      if (reservedSymbols?.has?.(symbol)) {
        items.delete(symbol);
        continue;
      }

      if (at - item.lastSelectAt > MAX_AGE_MS) {
        items.delete(symbol);
        continue;
      }

      const price = num(getPrice?.(symbol));
      if (!(price > 0)) {
        item.riseStreak = 0;
        item.signal = {
          status: 'WAIT',
          label: 'WAIT',
          reason: 'Canlı fiyat bekleniyor.',
          at,
          price: NaN,
          p0: item.basePrice,
          previousPrice: item.previousPrice,
          riseStreak: 0,
          requiredRises: REQUIRED_RISES
        };
        wait++;
        if (examples.length < 8) examples.push(`${symbol}[WAIT: canlı fiyat yok]`);
        continue;
      }

      const previousPrice = item.previousPrice;
      const rising = price > previousPrice;
      const aboveSelect = price > item.basePrice;

      if (rising && aboveSelect) item.riseStreak += 1;
      else item.riseStreak = 0;

      item.previousPrice = price;

      if (item.riseStreak >= REQUIRED_RISES) {
        item.signal = {
          status: 'GREEN',
          label: 'ENTRY',
          reason: `İki ardışık yükseliş: P0=${item.basePrice} → prev=${previousPrice} → now=${price}.`,
          at,
          price,
          p0: item.basePrice,
          previousPrice,
          riseStreak: item.riseStreak,
          requiredRises: REQUIRED_RISES
        };
        green++;
        greenRows.push({
          ...item.row,
          decisionPrice: price,
          autoWatchTiming: item.signal
        });
        if (examples.length < 8) {
          examples.push(`${symbol}[GREEN 2/2: ${item.basePrice}→${previousPrice}→${price}]`);
        }
      } else {
        let reason;
        if (!aboveSelect) {
          reason = `Fiyat SELECT fiyatının üstünde değil: ${price} ≤ ${item.basePrice}.`;
        } else if (!rising) {
          reason = `Fiyat önceki kontrolden yüksek değil: ${price} ≤ ${previousPrice}.`;
        } else {
          reason = `İlk yükseliş görüldü 1/2; bir sonraki kontrolde tekrar yükseliş bekleniyor.`;
        }

        item.signal = {
          status: 'WAIT',
          label: 'WAIT',
          reason,
          at,
          price,
          p0: item.basePrice,
          previousPrice,
          riseStreak: item.riseStreak,
          requiredRises: REQUIRED_RISES
        };
        wait++;
        if (examples.length < 8) {
          examples.push(`${symbol}[WAIT ${item.riseStreak}/2: P0=${item.basePrice}, prev=${previousPrice}, now=${price}]`);
        }
      }
    }

    return { total: items.size, green, wait, greenRows, examples };
  }

  function visibleRows({ reservedSymbols = new Set() } = {}) {
    const rows = [];
    for (const [symbol, item] of items.entries()) {
      if (reservedSymbols?.has?.(symbol)) continue;
      rows.push({
        ...item.row,
        autoWatchSignal: item.signal,
        autoWatchPending: item.signal?.status !== 'GREEN'
      });
    }
    return rows;
  }

  function getState() {
    return {
      total: items.size,
      items: Object.fromEntries(
        [...items.entries()].map(([symbol, item]) => [symbol, {
          basePrice: item.basePrice,
          previousPrice: item.previousPrice,
          riseStreak: item.riseStreak,
          lastSelectAt: item.lastSelectAt,
          signal: item.signal
        }])
      )
    };
  }

  globalThis.AutoWatch = Object.freeze({
    track,
    remove,
    reset,
    evaluate,
    visibleRows,
    getState,
    config: Object.freeze({
      maxAgeMs: MAX_AGE_MS,
      requiredRises: REQUIRED_RISES
    })
  });
})();
