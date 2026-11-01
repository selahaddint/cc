/* FROZEN90 JS port of Auto4h1hLineLevels, Auto1h15mLineLevels and Auto15m5mLineLevels.
 * Deliberately no Watch, Follow, trading or email side effects.
 * The 3/3 and 5/5 strict closed-candle pivot confirmation and six HH/LH formulas
 * follow their corresponding C# methods, including tie-breaking and history bounds.
 */
(function (global) {
  'use strict';
  const API = 'https://fapi.binance.com';
  const PERIOD = Object.freeze({ '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 });
  const STRATEGIES = Object.freeze({
    '4h1h': Object.freeze({ id:'4h1h', name:'4H → 1H FROZEN90', source:'Auto4h1hLineScan', upper:'4h', lower:'1h', ratio:4, upperHistory:500, lowerHistory:1500 }),
    '1h15m': Object.freeze({ id:'1h15m', name:'1H → 15m FROZEN90', source:'Auto1h15mLineScan', upper:'1h', lower:'15m', ratio:4, upperHistory:500, lowerHistory:1500 }),
    '15m5m': Object.freeze({ id:'15m5m', name:'15m → 5m FROZEN90', source:'Auto15m5mLineScan', upper:'15m', lower:'5m', ratio:3, upperHistory:500, lowerHistory:1500 })
  });
  const historyCache = new Map();
  const normalize = s => String(s || '').trim().toUpperCase();
  const validSymbol = s => /^[A-Z0-9]{2,25}USDT$/.test(s);
  const upperLimit = 90;

  function parseBars(payload, now = Date.now()) {
    if (!Array.isArray(payload)) throw Error('Binance kline verisi beklenen formatta değil.');
    return payload.filter(r => Array.isArray(r) && r.length >= 7).map(r => ({
      openTime: Number(r[0]), closeTime: Number(r[6]),
      open:Number(r[1]), high:Number(r[2]), low:Number(r[3]), close:Number(r[4])
    })).filter(b => Number.isSafeInteger(b.openTime) && b.openTime>0 && b.closeTime<now &&
      b.low>0 && b.high>=b.low && b.close>0 && [b.open,b.high,b.low,b.close].every(Number.isFinite))
      .sort((a,b) => a.openTime-b.openTime);
  }

  function continuous(bars, period) {
    return bars.length>0 && bars.every((b,i) => i===0 || b.openTime-bars[i-1].openTime===period);
  }

  // Exactly the C# classification: every confirmed pivot high, including FIRST/EQ,
  // becomes the previous reference used to classify the next pivot as HH or LH.
  function confirmedSwings(bars, side, highs) {
    const found=[];
    let previous=null;
    for (let i=side; i+side<bars.length; i++) {
      const price=highs ? bars[i].high : bars[i].low;
      let valid=true;
      for (let j=i-side; j<=i+side; j++) {
        if (j===i) continue;
        if (highs ? bars[j].high>=price : bars[j].low<=price) { valid=false;break; }
      }
      if (!valid) continue;
      const kind=previous===null ? 'FIRST' : highs ?
        price>previous?'HH':price<previous?'LH':'EQ' :
        price>previous?'HL':price<previous?'LL':'EQ';
      previous=price;
      found.push({openTime:bars[i].openTime,price,kind});
    }
    return found;
  }
  function first(list, compare) { return [...list].sort(compare)[0] || null; }
  function compute(symbol, lower, upper, config, now=Date.now()) {
    if (!config || !continuous(lower,PERIOD[config.lower]) || !continuous(upper,PERIOD[config.upper])) return null;
    if (upper.length<upperLimit || lower.length<upperLimit*config.ratio) return null;
    // Match the C# freshness rules. Historical snapshots aren't treated as live SELECTs.
    if (now-lower[lower.length-1].closeTime>2*PERIOD[config.lower] ||
        now-upper[upper.length-1].closeTime>2*PERIOD[config.upper]) return null;
    const start=upper[upper.length-upperLimit].openTime;
    const inReference=lower.filter(c => c.openTime>=start);
    if (inReference.length<upperLimit*config.ratio) return null;
    const hh=confirmedSwings(lower,3,true).filter(x=>x.kind==='HH');
    const lh=confirmedSwings(upper,5,true).filter(x=>x.kind==='LH');
    const recent=hh.filter(x=>x.openTime>=start);
    if (recent.length<2) return null;
    const maximum=first(recent,(a,b)=>b.price-a.price || b.openTime-a.openTime);
    const sell1=first(recent.filter(x=>x.openTime<maximum.openTime), (a,b)=>
      Math.abs(a.price-maximum.price)-Math.abs(b.price-maximum.price) || b.openTime-a.openTime);
    if (!sell1) return null;
    const sell2=first(lh.filter(x=>x.openTime>sell1.openTime),(a,b)=>a.openTime-b.openTime);
    if (!sell2) return null;
    const minimum=first(inReference,(a,b)=>a.low-b.low || a.openTime-b.openTime);
    const sell3=first(lh.filter(x=>x.openTime<minimum.openTime),(a,b)=>b.openTime-a.openTime);
    const buy2=first(hh.filter(x=>x.openTime<minimum.openTime),(a,b)=>
      Math.abs(a.price-minimum.low)-Math.abs(b.price-minimum.low) || b.openTime-a.openTime);
    if (!sell3 || !buy2) return null;
    const buy1=first(hh.filter(x=>x.openTime<buy2.openTime && x.price>buy2.price),(a,b)=>b.openTime-a.openTime);
    if (!buy1) return null;
    const sell4=first(lh.filter(x=>x.openTime<buy1.openTime),(a,b)=>b.openTime-a.openTime);
    if (!sell4 || buy1.price<=buy2.price) return null;
    const last=lower[lower.length-1];
    return {
      symbol:normalize(symbol), strategy:config.id, referenceStart:start,
      buy1:buy1.price,buy2:buy2.price,
      sell1:sell1.price,sell2:sell2.price,sell3:sell3.price,sell4:sell4.price,
      setupTime:last.closeTime,signalTime:now,
      lastOpen:last.open,lastClose:last.close,
      previousOpen:lower[lower.length-2].open,previousClose:lower[lower.length-2].close,
      anchors:{sell1,sell2,sell3,sell4,buy1,buy2,minimum,maximum},
      // Only a SELL strictly ABOVE the entire BUY zone is a valid upper resistance target.
      // Keep all six FROZEN HH/LH prices unchanged.
      target(entry) { return [this.sell1,this.sell2,this.sell3,this.sell4].filter(v=>v>this.buy1 && v>entry).sort((a,b)=>a-b)[0] || null; }
    };
  }

  async function fetchBars(symbol, interval, limit, signal) {
    const coin=normalize(symbol);
    if (!validSymbol(coin) || !PERIOD[interval] || !Number.isInteger(limit) || limit>1500) throw Error('Geçersiz coin, mum periyodu veya limit.');
    const key=`${coin}|${interval}|${limit}`;
    const cached=historyCache.get(key);
    if (cached?.bars && Date.now()<cached.expires) return cached.bars;
    // Intentionally do not share in-flight calls with an AbortSignal: one cancelled scan must
    // not cancel independent chart requests. Reuse only successfully cached closed history.
    const url=`${API}/fapi/v1/klines?symbol=${encodeURIComponent(coin)}&interval=${interval}&limit=${limit}`;
    const response=await fetch(url,{signal,cache:'no-store'});
    if (!response.ok) throw Error(`Binance REST ${response.status} (${coin} ${interval})`);
    const rows=parseBars(await response.json());
    // C# requires continuous bars; reject incomplete responses rather than invent a line.
    if (!continuous(rows,PERIOD[interval])) throw Error(`${coin} ${interval}: mum geçmişinde boşluk var.`);
    const nextClose=Math.floor(Date.now()/PERIOD[interval])*PERIOD[interval]+PERIOD[interval];
    historyCache.set(key,{bars:rows,expires:nextClose+5000});
    return rows;
  }
  async function load(symbol,id,signal) {
    const config=STRATEGIES[id];
    if (!config) throw Error('Bilinmeyen FROZEN strateji.');
    const [lower,upper]=await Promise.all([
      fetchBars(symbol,config.lower,config.lowerHistory,signal),
      fetchBars(symbol,config.upper,config.upperHistory,signal)
    ]);
    return {levels:compute(symbol,lower,upper,config),lower,upper,config};
  }
  // New scan-only gate: ±15% from the LOWER BUY line (BUY2).
  // Keep the existing BUY1 ceiling for the bullish in-zone setup.
  // For below-BUY2 SELECT, require a CLOSED red-to-green reversal and a live ASK
  // no lower than the bullish candle close. Never interpret an unfinished candle
  // as reversal evidence. Six frozen HH/LH level calculations are unchanged.
  function entryMode(levels, entry=levels?.lastClose) {
    if (!levels || !Number.isFinite(entry) || !(entry>0) ||
        !Number.isFinite(levels.buy1) || !Number.isFinite(levels.buy2) ||
        !(levels.buy2>0 && levels.buy2<levels.buy1) ||
        !Number.isFinite(levels.lastOpen) || !Number.isFinite(levels.lastClose) ||
        !(levels.lastClose>levels.lastOpen) ||
        typeof levels.target!=='function') return null;
    // SELL above the entire BUY zone remains mandatory for both modes.
    const target=levels.target(entry);
    if (!Number.isFinite(target) || target<=levels.buy1 || target<=entry) return null;
    const buy2=levels.buy2;
    // Use relative distances to make exactly +15.00%/-15.00% inclusive
    // even for decimal coin prices (avoid 100*1.15 => 114.99999999999).
    const withinUpper=v=>v>=buy2 && v<=levels.buy1 && (v-buy2)/buy2<=0.15+Number.EPSILON;
    const withinLower=v=>v<buy2 && (buy2-v)/buy2<=0.15+Number.EPSILON;
    if (withinUpper(levels.lastClose) && withinUpper(entry)) return 'BUY_ZONE';
    // A red previous candle followed by a green last CLOSED candle marks the turn.
    // Last closed price AND current ASK must both remain within -15% to BUY2.
    if (withinLower(levels.lastClose) && withinLower(entry) &&
        Number.isFinite(levels.previousOpen) && Number.isFinite(levels.previousClose) &&
        levels.previousClose<levels.previousOpen &&
        levels.lastClose>levels.previousClose && entry>=levels.lastClose)
      return 'RECOVERY_BELOW_BUY2';
    return null;
  }
  function qualifies(levels,entry=levels?.lastClose) {
    return entryMode(levels,entry)!==null;
  }
  async function loadPrescreen(symbol, interval, signal) {
    return fetchBars(symbol,interval,2,signal);
  }
  async function bestAsk(symbol, signal) {
    const coin=normalize(symbol);
    if (!validSymbol(coin)) return null;
    try {
      const response=await fetch(`${API}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(coin)}`,{signal,cache:'no-store'});
      if (!response.ok) return null;
      const ask=Number((await response.json()).askPrice);
      return ask>0 && Number.isFinite(ask)?ask:null;
    } catch (err) { if (signal?.aborted) throw err;return null; }
  }
  global.FrozenLineCore=Object.freeze({STRATEGIES,PERIOD,parseBars,continuous,confirmedSwings,compute,load,loadPrescreen,entryMode,qualifies,bestAsk});
})(window);
