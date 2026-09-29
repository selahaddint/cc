(() => {
  'use strict';
  // OneMScan 6: independent 5–30 minute LONG decision engine.
  // Source/book-supported: Elder PDF 76–77, 175, 177: structure, participation,
  // and separating direction from execution; Darvas PDF 64–65: defined ranges.
  // Inference from sources: 15m context / 5m structure / live 5m quote.
  // Model suggestion not explicitly supported by sources: ATR-confirmed turns,
  // measured-move target, fee estimate and noise-range entry ceiling below.
  // These implementation assumptions are NOT pre-existing user-approved rules.
  // Legacy lifecycle, fixed-bar setup, indicator votes and 4h learning are removed.
  const VERSION='OneM-Live-12';
  const CONFIG=Object.freeze({horizonMin:5,horizonMaxMin:30,atrPeriod:14,
    historyLimit:100,minHistory:30,concurrency:4,maxKlineSymbols:120,quoteMaxAgeMs:60000,
    estimatedRoundTripCostPct:0.14,
    // Sensitivity parameters. These are implementation parameters, not book
    // rules. Elder warns that mechanical filters can remove early signals
    // (PDF pp.94–95), so turn detection must not demand a full ATR reversal.
    turnAtrFactor:0.55,
    earlyPullbackPosition:0.25});
  const BASE='https://fapi.binance.com';
  // V5 response-grid metadata. Coin-selection engine does not use these values.
  const META_SPOT_API_BASES=['https://api.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com'];
  const META_PRODUCT_ENDPOINTS=[
    'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true',
    'https://www.binance.com/exchange-api/v2/public/asset-service/product/get-products?includeEtf=true'
  ];
  const META_WEB3_SEARCH_ENDPOINTS=[
    'https://web3.binance.com/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search/ai',
    'https://web3.binance.com/bapi/defi/v5/public/wallet-direct/buw/wallet/market/token/search'
  ];
  const META_WEB3_DYNAMIC_ENDPOINTS=[
    'https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai',
    'https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info'
  ];
  const META_CHAIN_IDS='1,56,8453,CT_501';
  const META_SUPPLY_CONCURRENCY=4;
  const META_HISTORY_CONCURRENCY=4;
  const META_PRICE_RATIO_MIN=0.95,META_PRICE_RATIO_MAX=1.05,META_CIRC_RATIO_MIN=0.90,META_CIRC_RATIO_MAX=1.10;
  const ACTIVITY_CACHE_MS=30*60*1000;
  const ACTIVITY_CACHE_KEY='CryptoOfferV3.ActivityRankCache.v1';
  const ACTIVITY_CACHE_VERSION=2;
  const STABLE_BASES=new Set(['USDC','FDUSD','TUSD','USDP','DAI','USDE','USDS','BUSD','AEUR']);
  const entrySnapshotCache=new Map();
  const $=id=>document.getElementById(id);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const fmt=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
  const pct=x=>Number.isFinite(x)?`${x>=0?'+':''}${x.toFixed(3)}%`:'—';
  const resultKind=r=>String(r?.result||'').trim().toUpperCase();
  const compact=x=>{
    if(!Number.isFinite(x)) return '—';
    return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(x);
  };
  const money=x=>Number.isFinite(x)?`${compact(x)} USDT`:'—';
  const htmlEscape=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  const state={running:false,controller:null,startedAt:0,requestCount:0,errors:[],results:[],activity:[],context:null,settings:null,activityCache:null,gateDiagnostics:{},rateLimited:false};
  function autoScanEnabled(){return !!$('autoScan')?.checked;}
  function resetBaseDropDiagnostics(){state.gateDiagnostics={};for(const el of document.querySelectorAll('[id^="gate"]'))el.textContent='—';}
  function priceFmt(x){return Number.isFinite(x)?new Intl.NumberFormat('en-US',{maximumSignificantDigits:8}).format(x):'—';}
  function startScanModule(){
    return window.CryptoFlowScanner?.modules?.startScan||null;
  }
  function followModule(){
    return window.CryptoFlowScanner?.modules?.follow||null;
  }
  let scanPreservedFollowRows=[];
  function preservedFollowRows(){
    const liveRows=followModule()?.getPreservedRows?.();
    // Always mirror the Follow module exactly, including an empty list.
    // This prevents a stopped/exited Follow row from surviving from an older render.
    if(Array.isArray(liveRows)){
      scanPreservedFollowRows=liveRows.filter(r=>r&&typeof r.symbol==='string');
    }
    return scanPreservedFollowRows.slice();
  }
  function captureFollowRowsBeforeScan(){
    const liveRows=followModule()?.getPreservedRows?.();
    scanPreservedFollowRows=Array.isArray(liveRows)?liveRows.filter(r=>r&&typeof r.symbol==='string'):[];
  }
  function mergeRowsWithFollow(rows){
    const fresh=Array.isArray(rows)?rows:[];
    const preserved=preservedFollowRows();
    if(!preserved.length)return gridRowsForDisplay(fresh);

    // Active Follow rows are a separate persistent section of the grid.
    // They always stay first and are never replaced by a row from the new scan.
    // If the same symbol is found again, the new-scan duplicate is omitted.
    // Follow rows also do not consume the CAUTION first-3 display quota.
    const followSymbols=new Set(preserved.map(r=>r.symbol));
    const freshOnly=fresh.filter(r=>r&&typeof r.symbol==='string'&&!followSymbols.has(r.symbol));
    return [...preserved,...gridRowsForDisplay(freshOnly)];
  }
  function notifyCandidatesRendered(){
    document.dispatchEvent(new CustomEvent('cryptooffer:candidates-rendered'));
    const liveRows=followModule()?.getPreservedRows?.();
    if(Array.isArray(liveRows))scanPreservedFollowRows=liveRows.filter(r=>r&&typeof r.symbol==='string');
  }
  window.CryptoOfferData=window.CryptoOfferData||{};
  window.CryptoOfferData.oneMScanState=state;

  function log(msg){
    const t=new Date().toLocaleTimeString('tr-TR');
    $('logBox').textContent += `\n[${t}] ${msg}`;
    $('logBox').scrollTop=$('logBox').scrollHeight;
  }
  function setStatus(text,cls='info'){
    const el=$('mainStatus');el.textContent=text;el.className=`status ${cls}`;
  }
  function progress(p,text){
    p=clamp(p,0,100);$('progressBar').style.width=`${p}%`;$('progressText').textContent=`${Math.round(p)}%`;$('stageText').textContent=text||'';
  }
  function setButtons(running){
    const normalRunning=!!startScanModule()?.state?.running;
    const one=$('oneMScanBtn'),start=$('startBtn'),cancel=$('cancelBtn');
    if(one)one.disabled=running||normalRunning;
    if(start)start.disabled=running||normalRunning||autoScanEnabled();
    if(cancel)cancel.disabled=!(running||normalRunning);
    if($('refreshRankBtn'))$('refreshRankBtn').disabled=running||normalRunning;
    if($('clearEventsBtn'))$('clearEventsBtn').disabled=running||normalRunning;
    if($('csvBtn'))$('csvBtn').disabled=running||!state.results.length;
    if($('jsonBtn'))$('jsonBtn').disabled=running||!state.results.length;
  }
  function resetUI(){
    ['sumActive','sumRanked','sumUniverse','sum301','sumFast','sumEventWatch','sumSelect','sumCaution','sumWait','sumReject','sumV2Analyzed','sumV2Ready','sumV2Wait','sumV2Skip','ctxBtc','ctxMedian','ctxBreadth','ctxResult'].forEach(id=>{const el=$(id);if(el)el.textContent='—';});
    ['gateFast','gateLiquidity','gateOi','gateData','gateOperational','gateAnalyzed','gateEntryError','gate1hBlock','gate1hTransition','gateFreshElder','gate15m','gate5m','gateTrigger','gateRR','gateSoft','gateSelect'].forEach(id=>{const el=$(id);if(el)el.textContent='—';});
    if(preservedFollowRows().length)renderCandidates([],state.settings?.windowSec||num($('windowSec').value)||60);
    else $('candidateBody').innerHTML='<tr><td colspan="21" class="empty">OneM 5–30m Scan çalışıyor…</td></tr>';
    $('manualQueue').innerHTML='<span class="empty">OneM 5–30m Scan çalışıyor…</span>';
    $('contextStatus').textContent='Hesaplanıyor…';$('contextStatus').className='status info';
    $('logBox').textContent='OneM 5–30m Scan initialized.';progress(0,'OneM initializing');
    state.errors=[];state.results=[];state.activity=[];state.context=null;state.thresholds=null;state.snapshotElapsedMs=null;state.requestCount=0;resetBaseDropDiagnostics();
  }

  function clearMarketContext(message='Bu scan için hesaplanmadı.') {
    ['ctxBtc','ctxMedian','ctxBreadth','ctxResult'].forEach(id=>$(id).textContent='—');
    $('ctxResult').className='v';
    $('contextStatus').textContent=message;
    $('contextStatus').className='status warn';
    state.context=null;
  }

  function activityCacheAgeMs(){
    return state.activityCache?Date.now()-state.activityCache.createdAt:Infinity;
  }

  function formatCacheAge(ms){
    if(!Number.isFinite(ms)||ms<0)return '—';
    const totalSec=Math.floor(ms/1000),m=Math.floor(totalSec/60),s=totalSec%60;
    return `${m}m ${String(s).padStart(2,'0')}s`;
  }

  function updateActivityCacheStatus(){
    const el=$('cacheStatus');if(!el)return;
    if(!state.activityCache){el.textContent=`Activity Rank Cache: empty • TTL ${ACTIVITY_CACHE_MS/60000}m`;return;}
    const age=activityCacheAgeMs(),valid=age<ACTIVITY_CACHE_MS;
    const remaining=Math.max(0,ACTIVITY_CACHE_MS-age);
    el.textContent=valid
      ?`Activity Rank Cache: HIT-ready • age ${formatCacheAge(age)} • expires in ${formatCacheAge(remaining)} • live USDT-M validation on scan`
      :`Activity Rank Cache: expired • age ${formatCacheAge(age)} • next scan rebuilds`;
  }

  function validActivityCacheObject(x){
    return !!x&&x.version===ACTIVITY_CACHE_VERSION&&Number.isFinite(Number(x.createdAt))&&Number.isFinite(Number(x.activeCount))&&Array.isArray(x.activity)&&x.activity.length>0&&x.activity.every(r=>r&&typeof r.symbol==='string'&&Number.isFinite(Number(r.activityRank))&&Number.isFinite(Number(r.activityScore)));
  }

  function loadPersistentActivityCache(){
    try{
      const raw=localStorage.getItem(ACTIVITY_CACHE_KEY);
      if(!raw){updateActivityCacheStatus();return;}
      const parsed=JSON.parse(raw);
      if(!validActivityCacheObject(parsed)){localStorage.removeItem(ACTIVITY_CACHE_KEY);updateActivityCacheStatus();return;}
      state.activityCache={createdAt:Number(parsed.createdAt),activeCount:Number(parsed.activeCount),activity:parsed.activity};
      updateActivityCacheStatus();
    }catch(e){
      state.activityCache=null;
      updateActivityCacheStatus();
      log(`Persistent Activity Rank cache unavailable: ${e.message||e}`);
    }
  }

  function savePersistentActivityCache(cache){
    state.activityCache=cache;
    try{
      localStorage.setItem(ACTIVITY_CACHE_KEY,JSON.stringify({version:ACTIVITY_CACHE_VERSION,...cache}));
    }catch(e){
      log(`Persistent Activity Rank cache save failed; memory cache remains active: ${e.message||e}`);
    }
    updateActivityCacheStatus();
  }

  function clearActivityRankCache(){
    state.activityCache=null;
    try{localStorage.removeItem(ACTIVITY_CACHE_KEY);}catch(e){log(`Persistent Activity Rank cache clear failed: ${e.message||e}`);}
    updateActivityCacheStatus();
  }


  function formatDateTime(ms){
    const n=Number(ms);if(!Number.isFinite(n))return '—';
    return new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(n));
  }

  async function fetchJson(url,{retries=3,timeout=15000,essential=false}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      if(state.controller?.signal.aborted) throw new DOMException('Aborted','AbortError');
      const timeoutController=new AbortController();
      const timer=setTimeout(()=>timeoutController.abort(),timeout);
      const onAbort=()=>timeoutController.abort();
      state.controller?.signal.addEventListener('abort',onAbort,{once:true});
      try{
        state.requestCount++;
        const res=await fetch(url,{signal:timeoutController.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(res.status===429||res.status===418){
          state.rateLimited=true;
          state.controller?.abort();
          throw new DOMException(`HTTP ${res.status}: rate limit; scan stopped`,'AbortError');
        }
        if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      }catch(e){
        lastErr=e;
        if(e.name==='AbortError'&&state.controller?.signal.aborted) throw e;
        if(attempt<retries){
          const wait=Number.isFinite(e.retryDelayMs)?e.retryDelayMs:450*Math.pow(2,attempt);
          if(Number.isFinite(e.retryDelayMs)) log(`Rate limit; ${Math.round(wait/1000)}s bekleniyor.`);
          await sleep(wait);
        }
      }finally{
        clearTimeout(timer);state.controller?.signal.removeEventListener('abort',onAbort);
      }
    }
    const msg=`API failed: ${url} → ${lastErr?.message||lastErr}`;
    state.errors.push(msg);log(msg);
    if(essential) throw new Error(msg);
    return null;
  }

  async function mapLimit(items,limit,worker,{pauseMs=0,onProgress=null}={}){
    const out=new Array(items.length);let next=0,done=0;
    async function runner(){
      while(true){
        const i=next++;if(i>=items.length) return;
        try{out[i]=await worker(items[i],i);}catch(e){
          if(e.name==='AbortError') throw e;
          out[i]=null;state.errors.push(`${items[i]?.symbol||items[i]}: ${e.message}`);log(`Item error ${items[i]?.symbol||items[i]}: ${e.message}`);
        }
        done++;if(onProgress) onProgress(done,items.length);
        if(pauseMs) await sleep(pauseMs);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},runner));
    return out;
  }

  function percentile(arr,p){
    const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return NaN;if(a.length===1)return a[0];
    const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos),w=pos-lo;return a[lo]*(1-w)+a[hi]*w;
  }
  function median(arr){return percentile(arr,.5)}

  function assignRankScore(rows,key,{higherBetter=true,outKey=null}={}){
    const scoreKey=outKey||`${key}Score`;
    const valid=rows.filter(r=>Number.isFinite(r[key])).slice().sort((a,b)=>higherBetter?b[key]-a[key]:a[key]-b[key]);
    const n=valid.length;
    let i=0;
    while(i<n){
      let j=i+1;
      while(j<n && valid[j][key]===valid[i][key]) j++;
      const avgIndex=(i+(j-1))/2;
      const score=n<=1?100:100*(1-avgIndex/(n-1));
      for(let k=i;k<j;k++) valid[k][scoreKey]=score;
      i=j;
    }
    rows.filter(r=>!Number.isFinite(r[key])).forEach(r=>r[scoreKey]=0);
  }

  function spreadPct(book){
    const bid=num(book?.bidPrice),ask=num(book?.askPrice);if(!(bid>0&&ask>0&&ask>=bid))return NaN;const mid=(bid+ask)/2;return (ask-bid)/mid*100;
  }

  async function getExchangeInfo(){return fetchJson(`${BASE}/fapi/v1/exchangeInfo`,{essential:true});}
  async function getBulk24(){return fetchJson(`${BASE}/fapi/v1/ticker/24hr`,{essential:true});}
  async function getBulkBook(){return fetchJson(`${BASE}/fapi/v1/ticker/bookTicker`,{essential:true});}
  async function getBulkPrices(){return fetchJson(`${BASE}/fapi/v2/ticker/price`,{essential:true});}
  async function getServerTime(){
    const x=await fetchJson(`${BASE}/fapi/v1/time`,{essential:true}),time=Number(x.serverTime);
    if(!Number.isFinite(time))throw new Error('Server clock unavailable');
    state.clockAnchor={time,local:performance.now()};return time;
  }
  function serverNow(fallback){const a=state.clockAnchor;return a?a.time+performance.now()-a.local:fallback;}
  function priceTicks(price,tick){return Math.round(price/tick);}


  function activeSymbols(exchange){
    return (exchange.symbols||[]).filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.underlyingType==='COIN'&&s.quoteAsset==='USDT'&&s.marginAsset==='USDT'&&!STABLE_BASES.has(s.baseAsset));
  }

  async function buildActivityRank(exchange,tickers,books){
    const syms=activeSymbols(exchange);
    const tickerMap=new Map((tickers||[]).map(x=>[x.symbol,x]));
    const bookMap=new Map((books||[]).map(x=>[x.symbol,x]));
    $('sumActive').textContent=String(syms.length);
    log(`Active crypto-only USDT PERPETUAL contracts (underlyingType=COIN): ${syms.length}`);

    // V14.2 performance rule: Activity Rank must be bulk-only.
    // Do NOT request openInterest/depth once per universe symbol. With Risk Universe=All,
    // Activity Rank is ordering/context information; heavy OI + real 10bps depth are fetched
    // only for symbols that actually pass the current Fast Event.
    const rows=syms.map(s=>{
      const t=tickerMap.get(s.symbol),b=bookMap.get(s.symbol);if(!t||!b)return null;
      const price=num(t.lastPrice),quoteVolume=num(t.quoteVolume),sp=spreadPct(b);
      const bid=num(b.bidPrice),ask=num(b.askPrice),bidQty=num(b.bidQty),askQty=num(b.askQty);
      const topBookDepth=(bid>0&&ask>0&&bidQty>=0&&askQty>=0)?Math.min(bid*bidQty,ask*askQty):NaN;
      if(![price,quoteVolume,sp,topBookDepth].every(Number.isFinite)||!(price>0))return null;
      return {symbol:s.symbol,baseAsset:s.baseAsset,onboardDate:Number(s.onboardDate)||0,deliveryDate:Number(s.deliveryDate)||NaN,price,quoteVolume,spreadPct:sp,activityDepthProxy:topBookDepth,status:s.status};
    });

    const good=rows.filter(Boolean);
    assignRankScore(good,'quoteVolume',{higherBetter:true,outKey:'volumeScore'});
    assignRankScore(good,'spreadPct',{higherBetter:false,outKey:'spreadScore'});
    assignRankScore(good,'activityDepthProxy',{higherBetter:true,outKey:'depthScore'});
    for(const r of good){
      r.liquidityScore=.5*r.spreadScore+.5*r.depthScore;
      // Previous non-OI weights renormalized: volume 0.40/(0.40+0.25), liquidity 0.25/(0.40+0.25).
      // Activity is only an ordering metric; it does not grant a LONG signal.
      r.activityScore=.6153846154*r.volumeScore+.3846153846*r.liquidityScore;
    }
    good.sort((a,b)=>{
      const as=Math.round(a.activityScore*10),bs=Math.round(b.activityScore*10);
      if(bs!==as) return bs-as;
      return b.onboardDate-a.onboardDate; // new coin only when score is tied at 0.1-point resolution
    });
    good.forEach((r,i)=>r.activityRank=i+1);
    $('sumRanked').textContent=String(good.length);
    if(good.length<syms.length) log(`Bulk Activity Rank complete: ${good.length}/${syms.length}; incomplete bulk rows excluded.`);
    log(`Activity Rank V14.2 bulk-only: 0 symbol-specific OI/depth requests for ${good.length} ranked contracts.`);
    progress(40,'Activity Rank bulk-only complete');
    return good;
  }

  function mean(values){
    const a=values.filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
  }

  function atrSeries(candles,period=14){
    const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
    const out=new Array(candles.length).fill(NaN);if(tr.length<period)return out;
    let prev=mean(tr.slice(0,period));out[period-1]=prev;
    for(let i=period;i<tr.length;i++){prev=((prev*(period-1))+tr[i])/period;out[i]=prev;}
    return out;
  }

  // Price turns are confirmed by a reversal larger than the local true-range
  // estimate. A turn can take any number of candles; no fixed bar-count setup.
  // This is a causal implementation choice, NOT an agreed user/book rule.
  function priceStructure(candles){
    const atr=atrSeries(candles,CONFIG.atrPeriod),pivots=[];
    let direction=0,extreme=0,wickExtreme=0;
    for(let i=1;i<candles.length;i++){
      const a=atr[extreme];
      if(!(a>0)){extreme=i;wickExtreme=i;continue;}
      const p=candles[i].close,e=candles[extreme].close;
      if(direction===0){
        if(Math.abs(p-e)<a*CONFIG.turnAtrFactor)continue;
        direction=p>e?1:-1;
        pivots.push({type:direction>0?'LOW':'HIGH',index:extreme,price:direction>0?candles[extreme].low:candles[extreme].high,confirmedAt:candles[i].closeTime});
        extreme=i;wickExtreme=i;
      }else{
        // The pivot's protection level includes every observed wick in its leg,
        // not just the candle with the most extreme close.
        if(direction>0?candles[i].high>candles[wickExtreme].high:candles[i].low<candles[wickExtreme].low)wickExtreme=i;
        if((direction>0&&p>=e)||(direction<0&&p<=e))extreme=i;
        else if(Math.abs(p-e)>=a*CONFIG.turnAtrFactor){
          pivots.push({type:direction>0?'HIGH':'LOW',index:wickExtreme,price:direction>0?candles[wickExtreme].high:candles[wickExtreme].low,confirmedAt:candles[i].closeTime});
          direction=-direction;extreme=i;wickExtreme=i;
        }
      }
    }
    const highs=pivots.filter(p=>p.type==='HIGH'),lows=pivots.filter(p=>p.type==='LOW');
    const hh=highs.length>1&&highs.at(-1).price>highs.at(-2).price;
    const hl=lows.length>1&&lows.at(-1).price>lows.at(-2).price;
    const lh=highs.length>1&&highs.at(-1).price<highs.at(-2).price;
    const ll=lows.length>1&&lows.at(-1).price<lows.at(-2).price;
    return {pivots,highs,lows,atr:atr.at(-1),direction,
      pending:{type:direction>0?'HIGH':'LOW',index:wickExtreme,price:direction>0?candles[wickExtreme].high:candles[wickExtreme].low,confirmedAt:null},
      regime:hh&&hl?'UPTREND':lh&&ll?'DOWNTREND':'TRANSITION'};
  }

  function validateCandles(candles,ms,time,capturedAt=time){
    // A candle still open when requested must never become closed just because
    // the clock advanced while other symbols were being fetched.
    const closed=candles.filter(c=>c.closeTime<Math.min(time,capturedAt));
    if(closed.length<CONFIG.minHistory)throw new Error(`${ms/60000}m history incomplete`);
    for(let i=0;i<closed.length;i++){
      const c=closed[i];
      if(![c.openTime,c.closeTime,c.open,c.high,c.low,c.close,c.volume,c.quoteVolume,c.takerBuyQuoteVolume].every(Number.isFinite)||
        !(c.low>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0&&c.quoteVolume>=0&&c.takerBuyQuoteVolume>=0&&c.takerBuyQuoteVolume<=c.quoteVolume))throw new Error('Invalid OHLC/volume data');
      if(c.closeTime!==c.openTime+ms-1||(i&&c.openTime!==closed[i-1].openTime+ms))throw new Error('Non-contiguous candles');
    }
    if(closed.at(-1).closeTime!==Math.floor(time/ms)*ms-1)throw new Error(`${ms/60000}m snapshot stale`);
    return closed;
  }

  function participation(candles,lowTime,time){
    const current=candles.filter(c=>c.openTime>=lowTime&&c.openTime<=time);
    const start=current[0]?.openTime;
    const reference=candles.filter(c=>c.closeTime<start&&c.openTime>=start-CONFIG.horizonMaxMin*60000);
    const average=reference.length?reference.reduce((s,c)=>s+c.quoteVolume,0)/reference.length:NaN;
    const quote=current.reduce((s,c)=>s+c.quoteVolume,0),buy=current.reduce((s,c)=>s+c.takerBuyQuoteVolume,0);
    const end=current.length?Math.min(time,current.at(-1).closeTime+1):NaN;
    const elapsed=(end-start)/60000;
    const ratio=average>0&&elapsed>0?quote/elapsed/average:NaN;
    // Participation is supporting evidence, not a direction signal. Do not
    // extrapolate a partially formed candle; compare elapsed turnover rates.
    return {pass:quote>0&&(buy>quote-buy||(Number.isFinite(ratio)&&ratio>=1)),
      buyShare:quote>0?buy/quote:NaN,relativeTurnover:ratio};
  }

  function decideEntry(row,snapshots,book,premium,time){
    const bid=num(book?.bidPrice),ask=num(book?.askPrice),quoteTime=num(book?.time);
    if(!(bid>0&&ask>=bid&&num(book.bidQty)>0&&num(book.askQty)>0))throw new Error('Executable bid/ask unavailable');
    if(!Number.isFinite(quoteTime)||quoteTime>time||time-quoteTime>CONFIG.quoteMaxAgeMs)throw new Error('Quote stale');
    if(!snapshots.m5||!snapshots.m15)throw new Error('Market snapshots incomplete');
    if(!Number.isFinite(snapshots.m5.asOf)||snapshots.m5.asOf>time||time-snapshots.m5.asOf>CONFIG.quoteMaxAgeMs)throw new Error('5m snapshot stale');
    const c5=validateCandles(snapshots.m5.candles,300000,time,snapshots.m5.asOf);
    const c15=validateCandles(snapshots.m15.candles,900000,time,snapshots.m15.asOf);
    const five=priceStructure(c5),context=priceStructure(c15);
    // The 5m request is also the execution-noise reference. A separate 1m
    // request per symbol adds cost without improving the 5–30m decision.
    const one=five;
    const cautions=[],warnings=[],drops=[];
    let gate='SETUP',setup='NONE',level=NaN,stop=NaN,target=NaN,rr=NaN,entryCeiling=NaN,triggerTime=NaN,flow=null,triggerConfirmed=false,earlyPullback=false,entryLevel=NaN;
    if(!(one.atr>0))throw new Error('Execution volatility unavailable');
    if(ask-bid>=one.atr)drops.push('Spread consumes the normal 5m price range');
    if(context.regime==='DOWNTREND')warnings.push('15m structure remains bearish');
    // The 5m chart owns both setup and live timing. A separate 1m chart is not
    // required for this 5–30m decision and would multiply provider requests.
    // Elder's day-trading example uses a higher-timeframe bias and a 5m
    // entry/stop (PDF pp.175, 177–178); using 1m to invent the setup made the
    // engine wait for an unrelated micro swing and suppressed live SELECTs.
    const low=five.direction<0?five.pending:five.lows.at(-1);
    const high=low?five.highs.filter(h=>h.index<low.index).at(-1):null;
    const previousLow=high?five.lows.filter(l=>l.index<high.index).at(-1):null;
    if(!low||!high||!previousLow)cautions.push('A complete pullback/turn structure is not yet visible');
    else{
      setup=low.price>previousLow.price?'PULLBACK_RESUMPTION':'RESISTANCE_RECLAIM';
      const tick=num(row.tickSize);
      if(!(tick>0))throw new Error('Price tick unavailable');
      // Buy one tick above the 5m setup resistance. This is a direct
      // lower-timeframe adaptation of Elder's buy-stop example; no 1m bar
      // count or 1m swing is required to qualify the setup.
      const triggerHigh=high.price;
      const levelTicks=priceTicks(triggerHigh,tick)+1,stopTicks=priceTicks(low.price,tick)-1;
      level=Number((levelTicks*tick).toPrecision(15));stop=Number((stopTicks*tick).toPrecision(15));
      const start=c5[low.index].closeTime;
      const later=c5.filter(c=>c.closeTime>start);
      const pullbackRange=Math.max(0,high.price-low.price);
      const positionInPullback=pullbackRange>0?(bid-low.price)/pullbackRange:0;
      // A positive Fast Event is itself the live execution trigger when price
      // has reclaimed a meaningful part of a valid 5m higher-low pullback.
      // Waiting for another 1m/5m close would select after the move, which is
      // the late-entry failure this scanner is meant to avoid.
      earlyPullback=setup==='PULLBACK_RESUMPTION'&&five.regime==='UPTREND'&&
        context.regime!=='DOWNTREND'&&positionInPullback>=CONFIG.earlyPullbackPosition&&
        positionInPullback<1&&num(row.fastChange)>0;
      // A later recovery starts a new reclaim. A prior dip below resistance is
      // not a permanent veto when structural support remained intact.
      const lastBelow=later.findLastIndex(c=>priceTicks(c.close,tick)<levelTicks);
      const crossing=later.slice(lastBelow+1).find(c=>priceTicks(c.close,tick)>=levelTicks);
      // Clicking Scan does not invalidate an intact entry. Current discovery,
      // held support, participation and the entry ceiling determine readiness.
      const eventStart=num(row.fastEventStartTime);
      if(!Number.isFinite(eventStart)||eventStart>time)throw new Error('Scan event time unavailable');
      const liveCross=!crossing&&priceTicks(bid,tick)>=levelTicks;
      triggerTime=crossing?.closeTime??(liveCross?quoteTime:NaN);
      const triggered=earlyPullback||Number.isFinite(triggerTime);
      const entryTicks=earlyPullback?priceTicks(ask,tick):levelTicks;
      entryLevel=Number((entryTicks*tick).toPrecision(15));
      const held=earlyPullback?priceTicks(bid,tick)>stopTicks:priceTicks(bid,tick)>=levelTicks;
      const observedLive=snapshots.m5.candles.find(c=>c.openTime<=snapshots.m5.asOf&&c.closeTime>=snapshots.m5.asOf&&c.openTime>start);
      const invalidated=later.some(c=>priceTicks(c.low,tick)<=stopTicks)||priceTicks(bid,tick)<=stopTicks||
        (observedLive&&priceTicks(observedLive.low,tick)<=stopTicks);
      const resistance5=five.highs.at(-1)?.price;
      if(five.regime==='DOWNTREND'&&!(bid>resistance5)){gate='STRUCTURE5M';cautions.push(`5m bearish structure has not reclaimed ${priceFmt(resistance5)}`);}
      if(invalidated){if(!cautions.length)gate='INVALIDATED';cautions.push('Pullback support has broken');}
      if(!triggered){if(!cautions.length)gate='WAIT_BREAKOUT';cautions.push(`Waiting for trigger ${priceFmt(level)}`);}
      else if(!held){if(!cautions.length)gate='FAILED_BREAKOUT';cautions.push('Breakout has failed to hold');}
      triggerConfirmed=triggered&&held&&!invalidated;
      // Use the available closed 5m turnover. It is participation evidence,
      // not a standalone direction signal.
      flow=participation(c5,c5[low.index].openTime,Math.min(time,snapshots.m5.asOf));
      if(!flow.pass){
        const message='Neither buyer participation nor turnover confirms the price turn';
        // A pullback continuation can be selected while turnover is still
        // building: volume is confirmation, not a standalone direction
        // signal.  Keep it a hard gate for a resistance reclaim, where the
        // breakout itself needs participation to validate the move.
        if(setup==='RESISTANCE_RECLAIM'){if(!cautions.length)gate='PARTICIPATION';cautions.push(message);}
        else warnings.push(`${message}; treat the continuation as lower confidence`);
      }
      // A measured move is a scenario, never a promised forecast. Confirmed
      // overhead resistance can only lower that scenario target.
      // Execution risk uses the current quote; the 5–30m objective belongs to 5m.
      // Project the previous completed 5m upswing, not a tiny execution bounce.
      const referenceHigh=five.highs.at(-1);
      const referenceLow=referenceHigh?five.lows.filter(l=>l.index<referenceHigh.index).at(-1):null;
      const priorImpulse=referenceLow?referenceHigh.price-referenceLow.price:NaN;
      // Compare exchange tick units: floating point must not re-add our own
      // trigger as a target. Resistance already cleared by the live bid is not
      // remaining upside; retain the next unpassed level, including inside spread.
      const overhead=[...(earlyPullback?[]:five.highs),...context.highs].map(h=>h.price)
        .filter(p=>priceTicks(p,tick)>Math.max(entryTicks,priceTicks(ask,tick)));
      target=Math.min(priorImpulse>0?entryLevel+priorImpulse:Infinity,...overhead);
      if(!Number.isFinite(target))target=NaN;
      const funding=num(premium?.lastFundingRate),fundingTime=num(premium?.nextFundingTime);
      if(!Number.isFinite(funding)||!(fundingTime>time))throw new Error('Funding timing unavailable');
      const fundingCost=fundingTime<=time+CONFIG.horizonMaxMin*60000?Math.max(0,funding):0;
      const costRate=CONFIG.estimatedRoundTripCostPct/100+fundingCost;
      const cost=ask*costRate;
      rr=ask>stop&&target>ask?(target-ask-cost)/(ask-stop+cost):NaN;
      // No-chase is one execution noise range AND the remaining net reward/risk
      // boundary. There is no inherited 0.50 ATR5/ATR15 or fixed 3-candle gate.
      // R/R remains visible as a warning metric.  It must not create a second
      // fixed-ratio entry veto: the source material treats target/stop as a
      // plan to define before entry, while rigid mechanical filters can erase
      // otherwise valid early signals.  The ATR ceiling is the no-chase gate.
      entryCeiling=level+one.atr;
      if(!(rr>0)){if(!cautions.length)gate='REWARD_RISK';cautions.push('No positive net reward remains above the executable price');}
      else if(rr<1)warnings.push(`Net R/R below 1 (${fmt(rr,2)}); use reduced size or wait for a better entry`);
      if(earlyPullback)entryCeiling=level;
      if(ask>entryCeiling){if(!cautions.length)gate='TOO_LATE';cautions.push(`Entry has moved beyond ${priceFmt(entryCeiling)}`);}
    }
    const result=drops.length?'DROP':cautions.length?'CAUTION':'SELECT';
    const reasonLevel=earlyPullback?entryLevel:level;
    const reason=cautions.length?cautions.join('; '):`Valid ${setup}; bid holds ${priceFmt(reasonLevel)}, buyers support the turn`;
    const plan={level:earlyPullback?entryLevel:level,setupLevel:level,stop,target,entryCeiling,netRR:rr,triggerTime,setup,
      horizonMin:CONFIG.horizonMin,horizonMaxMin:CONFIG.horizonMaxMin,flow,
      targetBasis:'Completed 5m upswing projection capped by confirmed resistance',costEstimatePct:CONFIG.estimatedRoundTripCostPct};
    return {...row,result,decisionPrice:ask,decisionTime:time,liveSpread:spreadPct(book),reasons:[...drops,...cautions,...warnings],plan,
      chartAnalysis:{engine:VERSION,final:result==='SELECT'?'READY':result,reason,gate:result==='SELECT'?'SELECT':drops.length?'LIQUIDITY':gate,plan,
        step7:{regime:context.regime,timeframe:'15m'},step8:{setup,status:setup==='NONE'?'WAIT':'PASS',timeframe:'5m structure'},
        step9:{status:triggerConfirmed?'CONFIRMED':'WAIT',score:flow?.pass?'SUPPORTED':'WAIT',timeframe:'live'},
        step10:{status:ask>entryCeiling?'SKIP_CHASE':result==='SELECT'?'READY':'WAIT'},
        priceLocation:{structuralAsymmetry:rr,stop,target,verdict:rr>=1?'ACCEPTABLE':rr>0?'LOW_MARGIN':'INSUFFICIENT'},
        decision:{result,drops,cautions,coreCautions:cautions,softWarnings:warnings}}};
  }

  function klineToCandle(k){return {openTime:Number(k[0]),open:num(k[1]),high:num(k[2]),low:num(k[3]),close:num(k[4]),volume:num(k[5]),closeTime:Number(k[6]),quoteVolume:num(k[7]),takerBuyQuoteVolume:num(k[10])};}
  function aggregateCandles(candles,intervalMs=900000,baseMs=300000){
    const groups=new Map();
    for(const c of candles||[]){
      const bucket=Math.floor(c.openTime/intervalMs)*intervalMs;
      const list=groups.get(bucket)||[];list.push(c);groups.set(bucket,list);
    }
    return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([openTime,list])=>{
      list.sort((a,b)=>a.openTime-b.openTime);
      if(list.length!==intervalMs/baseMs)return [];
      for(let i=1;i<list.length;i++)if(list[i].openTime!==list[i-1].openTime+baseMs)return [];
      const first=list[0],last=list.at(-1);
      return [{openTime,open:first.open,high:Math.max(...list.map(c=>c.high)),low:Math.min(...list.map(c=>c.low)),close:last.close,
        volume:list.reduce((s,c)=>s+c.volume,0),closeTime:last.closeTime,quoteVolume:list.reduce((s,c)=>s+c.quoteVolume,0),
        takerBuyQuoteVolume:list.reduce((s,c)=>s+c.takerBuyQuoteVolume,0)}];
    });
  }
  async function prepareEntrySnapshots(row,time){
    const cached=entrySnapshotCache.get(row.symbol)||{},requestTime=Math.floor(serverNow(time)),old=cached.m5;
    if(old&&old.asOf>=Math.floor(requestTime/300000)*300000&&requestTime-old.asOf<CONFIG.quoteMaxAgeMs)return;
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(row.symbol)}&interval=5m&limit=${CONFIG.historyLimit}`,{retries:1});
    if(!Array.isArray(raw))throw new Error('5m candles unavailable');
    const candles=raw.map(klineToCandle);
    cached.m5={candles,asOf:requestTime};
    cached.m15={candles:aggregateCandles(candles),asOf:requestTime};
    entrySnapshotCache.set(row.symbol,cached);
  }
  async function analyzeChartCandidate(row,time,books,premiums){
    try{return decideEntry(row,entrySnapshotCache.get(row.symbol)||{},books.get(row.symbol),premiums.get(row.symbol),time);}
    catch(e){if(e.name==='AbortError')throw e;return {...row,result:'CAUTION',reasons:[e.message],chartAnalysis:{engine:VERSION,final:'CAUTION',gate:'DATA',reason:e.message,decision:{drops:[],cautions:[e.message],coreCautions:[e.message],softWarnings:[]}}};}
  }
  function finalizeGateDiagnostics(rows){
    const counts={};for(const r of rows){const k=r.chartAnalysis?.gate||'DATA';counts[k]=(counts[k]||0)+1;}
    state.gateDiagnostics=counts;
    for(const [id,n] of Object.entries({gateAnalyzed:rows.length,gateData:counts.DATA||0,gateLiquidity:counts.LIQUIDITY||0,gateSelect:counts.SELECT||0}))if($(id))$(id).textContent=String(n);
    log(`OneM decision reasons: ${Object.entries(counts).map(([k,n])=>`${k}=${n}`).join(' | ')}`);
  }
  function sortCandidates(rows){return rows.slice().sort((a,b)=>(resultKind(b)==='SELECT')-(resultKind(a)==='SELECT')||(b.plan?.netRR||0)-(a.plan?.netRR||0)||(b.activityScore||0)-(a.activityScore||0));}
  function entryDecisionSummary(r){return `${r.result} | 5–30m | ${r.chartAnalysis?.reason||r.reasons?.join('; ')||'—'}`;}
  function entryDecisionTitle(r){const p=r.plan;return `${entryDecisionSummary(r)}${p?` | Trigger ${priceFmt(p.level)}; reference stop ${priceFmt(p.stop)}; target scenario ${priceFmt(p.target)}; net R/R ${fmt(p.netRR)}. Follow stop/exit is independent.`:''}`;}
  function resultPill(r){const kind=resultKind(r);return `<span class="pill ${kind.toLowerCase()}">${kind||'—'}</span>`;}
  function v2NotRun(reason='Not analyzed'){return {final:'NOT_RUN',reason};}
  function metaToNumber(v){if(v===null||v===undefined||v==='')return NaN;const n=Number(v);return Number.isFinite(n)?n:NaN;}
  function metaNormalizeName(v){return String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\b(token|coin|protocol|network|finance|chain)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
  function metaNamesCompatible(a,b){if(a===b)return true;return a.length>=4&&b.length>=4&&(a.includes(b)||b.includes(a));}
  function metaRatioInRange(a,b,min,max){if(!(a>0)||!(b>0))return false;const r=a/b;return r>=min&&r<=max;}
  function metaFormatRequestTime(d=new Date()){return new Intl.DateTimeFormat('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(d);}
  function metaFormatDate(ms){if(!Number.isFinite(ms))return '—';return new Intl.DateTimeFormat('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(ms));}
  function metaFormatAge(ms){
    if(!Number.isFinite(ms))return '—';const start=new Date(ms),now=new Date();if(start>now)return '—';
    let years=now.getUTCFullYear()-start.getUTCFullYear(),months=now.getUTCMonth()-start.getUTCMonth(),days=now.getUTCDate()-start.getUTCDate();
    if(days<0){months--;days+=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),0)).getUTCDate();}
    if(months<0){years--;months+=12;}
    if(years>0)return `${years} yıl ${months} ay`;if(months>0)return `${months} ay ${days} gün`;return `${Math.max(0,days)} gün`;
  }
  function metaFormatSupply(v){return Number.isFinite(v)?new Intl.NumberFormat('tr-TR',{maximumFractionDigits:2}).format(v):'—';}
  function metaFormatVolume(v){return Number.isFinite(v)?`${new Intl.NumberFormat('tr-TR',{notation:'compact',maximumFractionDigits:2}).format(v)} USDT`:'—';}
  function metaFormatPrice(v){return Number.isFinite(v)?priceFmt(v):'—';}
  const META_YS_MIN_LISTING_TIME=Date.UTC(2025,0,1);
  function metaYsResult(totalSupply,spotPrice,listingTime){
    if(!(Number.isFinite(totalSupply)&&totalSupply>=1&&Number.isFinite(spotPrice)&&spotPrice>0&&Number.isFinite(listingTime)))return null;
    const rules=[
      [100000,100,500,false],
      [1000000,30,100,false],
      [10000000,1,10,false],
      [100000000,1,5,false],
      [1000000000,0.01,0.10,true],
      [10000000000,0.001,0.01,true]
    ];
    const supplyPriceMatch=rules.some(([sMax,pMin,pMax,upperExclusive])=>totalSupply<=sMax&&spotPrice>=pMin&&(upperExclusive?spotPrice<pMax:spotPrice<=pMax));
    return supplyPriceMatch&&listingTime>=META_YS_MIN_LISTING_TIME;
  }
  function metaYsHtml(v){if(v===true)return '<span class="ysMark true" title="YS True: supply/fiyat eşleşti ve Cr Spot USDT başlangıcı 2025+">✓</span>';if(v===false)return '<span class="ysMark false" title="YS False">✕</span>';return '<span class="ysMark unknown" title="YS için gerekli Total Supply / Spot fiyat / Cr başlangıç tarihi doğrulanamadı">—</span>';}

  async function metaFetchWithTimeout(url,ms=15000){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),ms);const onAbort=()=>ctrl.abort();
    state.controller?.signal.addEventListener('abort',onAbort,{once:true});
    try{state.requestCount++;return await fetch(url,{method:'GET',mode:'cors',cache:'no-store',credentials:'omit',headers:{Accept:'application/json'},signal:ctrl.signal});}
    finally{clearTimeout(timer);state.controller?.signal.removeEventListener('abort',onAbort);}
  }
  async function metaSpotJson(path){
    let last;for(const base of META_SPOT_API_BASES){try{const r=await metaFetchWithTimeout(`${base}${path}`);if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Cr Spot REST unavailable');
  }
  async function metaProducts(){
    let last;for(const url of META_PRODUCT_ENDPOINTS){try{const r=await metaFetchWithTimeout(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(!Array.isArray(j?.data))throw new Error('product format');return j.data;}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Cr product data unavailable');
  }
  async function metaWeb3Search(keyword){
    let last;for(const endpoint of META_WEB3_SEARCH_ENDPOINTS){try{const qs=new URLSearchParams({keyword,chainIds:META_CHAIN_IDS,orderBy:'volume24h'});const r=await metaFetchWithTimeout(`${endpoint}?${qs}`,12000);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j?.code&&String(j.code)!=='000000')throw new Error(`Web3 ${j.code}`);return Array.isArray(j?.data)?j.data:[];}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    if(last)console.debug('V5 Web3 search unavailable',last);return [];
  }
  async function metaWeb3Dynamic(chainId,contractAddress){
    let last;for(const endpoint of META_WEB3_DYNAMIC_ENDPOINTS){try{const qs=new URLSearchParams({chainId:String(chainId),contractAddress:String(contractAddress)});const r=await metaFetchWithTimeout(`${endpoint}?${qs}`,12000);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j?.code&&String(j.code)!=='000000')throw new Error(`Web3 ${j.code}`);return j?.data||null;}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Cr Web3 dynamic unavailable');
  }
  async function metaVerifiedTotalSupply(meta){
    if(!(meta?.spotBase&&meta.spotPrice>0&&meta.circulatingSupply>0))return NaN;
    const candidates=await metaWeb3Search(meta.spotBase),exact=candidates.filter(c=>String(c?.symbol||'').toUpperCase()===meta.spotBase);if(!exact.length)return NaN;
    const cexName=metaNormalizeName(meta.name),byName=exact.filter(c=>{if(!cexName)return true;const w=metaNormalizeName(c?.name);return !!w&&metaNamesCompatible(cexName,w);});if(!byName.length)return NaN;
    const matched=byName.map(c=>({c,p:metaToNumber(c?.price),mc:metaToNumber(c?.marketCap)||0,vol:metaToNumber(c?.volume24h)||0})).filter(x=>x.p>0&&metaRatioInRange(x.p,meta.spotPrice,META_PRICE_RATIO_MIN,META_PRICE_RATIO_MAX)).sort((a,b)=>b.mc-a.mc||b.vol-a.vol);
    if(!matched.length)return NaN;const best=matched[0].c;if(!best?.chainId||!best?.contractAddress)return NaN;
    const d=await metaWeb3Dynamic(best.chainId,best.contractAddress),dynPrice=metaToNumber(d?.price),dynCirc=metaToNumber(d?.circulatingSupply),total=metaToNumber(d?.totalSupply);
    if(!(dynPrice>0)||!metaRatioInRange(dynPrice,meta.spotPrice,META_PRICE_RATIO_MIN,META_PRICE_RATIO_MAX))return NaN;
    if(!(dynCirc>0)||!metaRatioInRange(dynCirc,meta.circulatingSupply,META_CIRC_RATIO_MIN,META_CIRC_RATIO_MAX))return NaN;
    if(!(total>0)||total+1e-9<dynCirc)return NaN;return total;
  }
  async function metaSpotKlines(symbol,interval,startTime,limit){const qs=new URLSearchParams({symbol,interval,startTime:String(startTime),limit:String(limit)});const x=await metaSpotJson(`/api/v3/klines?${qs}`);if(!Array.isArray(x))throw new Error(`${symbol} kline format`);return x;}
  function metaSelectSpotSymbol(row,spotMap){
    const direct=String(row.baseAsset||row.symbol?.replace(/USDT$/,'')||'').toUpperCase();if(spotMap.has(`${direct}USDT`))return {symbol:`${direct}USDT`,base:direct};
    const m=direct.match(/^(\d+)([A-Z].*)$/);if(m&&spotMap.has(`${m[2]}USDT`))return {symbol:`${m[2]}USDT`,base:m[2]};
    return null;
  }
  async function enrichV5GridMetadata(rows){
    const requestTime=metaFormatRequestTime(new Date());
    for(const r of rows)r.gridMeta={requestTime,spotSymbol:null,spotBase:null,name:null,spotPrice:NaN,volume24h:NaN,totalSupply:NaN,circulatingSupply:NaN,listingTime:NaN,allTimeHigh:NaN,allTimeLow:NaN,ys:null};
    let exchange=null,tickers=[],products=[];
    const settled=await Promise.allSettled([metaSpotJson('/api/v3/exchangeInfo'),metaSpotJson('/api/v3/ticker/24hr?type=MINI'),metaProducts()]);
    if(settled[0].status==='fulfilled')exchange=settled[0].value;else log(`V5 metadata Spot exchangeInfo unavailable: ${settled[0].reason?.message||settled[0].reason}`);
    if(settled[1].status==='fulfilled'&&Array.isArray(settled[1].value))tickers=settled[1].value;else log(`V5 metadata Spot ticker unavailable: ${settled[1].reason?.message||settled[1].reason}`);
    if(settled[2].status==='fulfilled')products=settled[2].value;else log(`V5 metadata Cr supply products unavailable: ${settled[2].reason?.message||settled[2].reason}`);
    if(state.controller?.signal.aborted)throw new DOMException('Aborted','AbortError');

    const spotMap=new Map(((exchange?.symbols)||[]).filter(s=>String(s?.quoteAsset).toUpperCase()==='USDT'&&String(s?.status).toUpperCase()==='TRADING'&&s?.isSpotTradingAllowed!==false).map(s=>[String(s.symbol).toUpperCase(),s]));
    const tickerMap=new Map(tickers.map(t=>[String(t?.symbol||'').toUpperCase(),t]));
    const productMap=new Map(products.map(p=>[String(p?.s||'').toUpperCase(),p]).filter(x=>x[0]));
    for(const r of rows){
      const sel=metaSelectSpotSymbol(r,spotMap);if(!sel)continue;const m=r.gridMeta;m.spotSymbol=sel.symbol;m.spotBase=sel.base;
      const t=tickerMap.get(sel.symbol),p=productMap.get(sel.symbol);m.spotPrice=metaToNumber(t?.lastPrice);m.volume24h=metaToNumber(t?.quoteVolume);m.circulatingSupply=metaToNumber(p?.cs);m.name=String(p?.an||sel.base).trim();
    }

    let next=0;async function supplyWorker(){while(true){const i=next++;if(i>=rows.length)return;const r=rows[i],m=r.gridMeta;if(!(m?.spotPrice>0&&m?.circulatingSupply>0))continue;try{m.totalSupply=await metaVerifiedTotalSupply(m);}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;console.debug('V5 Total Supply unavailable',r.symbol,e);}}}
    await Promise.all(Array.from({length:Math.min(META_SUPPLY_CONCURRENCY,rows.length)},supplyWorker));

    next=0;async function historyWorker(){while(true){const i=next++;if(i>=rows.length)return;const r=rows[i],m=r.gridMeta;if(!m?.spotSymbol)continue;try{const [firstDaily,monthly]=await Promise.all([metaSpotKlines(m.spotSymbol,'1d',0,1),metaSpotKlines(m.spotSymbol,'1M',0,1000)]);if(firstDaily.length){const t=metaToNumber(firstDaily[0]?.[0]);if(Number.isFinite(t))m.listingTime=t;}if(monthly.length){let hi=-Infinity,lo=Infinity;for(const k of monthly){const h=metaToNumber(k?.[2]),l=metaToNumber(k?.[3]);if(h>0&&h>hi)hi=h;if(l>0&&l<lo)lo=l;}if(Number.isFinite(hi))m.allTimeHigh=hi;if(Number.isFinite(lo))m.allTimeLow=lo;}}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;console.debug('V5 Cr history unavailable',r.symbol,e);}}}
    await Promise.all(Array.from({length:Math.min(META_HISTORY_CONCURRENCY,rows.length)},historyWorker));
    for(const r of rows){const m=r.gridMeta;m.ys=metaYsResult(m.totalSupply,m.spotPrice,m.listingTime);}
  }

  function scanRow(symbol){
    return [...document.querySelectorAll('#candidateBody tr[data-symbol]')].find(tr=>tr.dataset.symbol===symbol)||null;
  }

  function coinRangeLabel(r){
    const entry=num(Number.isFinite(r?.decisionPrice)?r.decisionPrice:r?.snapshot2);
    const target=num(r?.plan?.target),stop=num(r?.plan?.stop);
    if(!(Number.isFinite(target)||Number.isFinite(stop)))return String(r?.symbol||'');
    const upPct=entry>0&&target>entry?(target-entry)/entry*100:NaN;
    const downPct=entry>0&&stop>0&&stop<entry?(entry-stop)/entry*100:NaN;
    const up=Number.isFinite(target)?`↑ ${priceFmt(target)} USDT${Number.isFinite(upPct)?` / +${upPct.toFixed(2)}%`:''}`:'↑ —';
    const down=Number.isFinite(stop)?`↓ ${priceFmt(stop)} USDT${Number.isFinite(downPct)?` / -${downPct.toFixed(2)}%`:''}`:'↓ —';
    return `${String(r?.symbol||'')} (${up} · ${down})`;
  }

function gridRowsForDisplay(rows){
  const source=Array.isArray(rows)?rows:[];
  // Final response-grid contract:
  //   1) show EVERY SELECT (SELECT = Entry Ready)
  //   2) show at most 3 CAUTION rows for manual inspection
  //   3) all hard-failed/internal DROP rows stay out of the grid
  const selects=source.filter(r=>resultKind(r)==='SELECT');
  const cautions=source.filter(r=>resultKind(r)==='CAUTION').slice(0,3);
  return [...selects,...cautions];
}

function renderCandidates(rows,windowSec){
    const body=$('candidateBody'),displayRows=mergeRowsWithFollow(rows);
    if(!displayRows.length){
      body.innerHTML='<tr><td colspan="21" class="empty">Aktif Fast Event adayı yok.</td></tr>';
      notifyCandidatesRendered();
      return;
    }
    body.innerHTML=displayRows.map((r,i)=>{
      const g=r.gridMeta||{};
      const age=metaFormatAge(g.listingTime),ageDate=metaFormatDate(g.listingTime);
      const pl=r.decisionSupport?.priceLevel,rl=r.decisionSupport?.riskLevel;
      const plLabel=pl?.label||'—',rlLabel=rl?.label||'—';
      const plTitle=Number.isFinite(pl?.score)?`PriceScore ${(pl.score*100).toFixed(1)}/100`:"Coin adına tıklanınca hesaplanır; selection'ı etkilemez.";
      const rlTitle=Number.isFinite(rl?.score)?`RiskScore ${(rl.score*100).toFixed(1)}/100`:"Coin adına tıklanınca hesaplanır; selection'ı etkilemez.";
      const coinLabel=coinRangeLabel(r);
      return `<tr data-symbol="${htmlEscape(r.symbol)}">
        <td>${i+1}</td>
        <td class="symbol"><button class="symbolBtn" data-action="decision-support" data-symbol="${htmlEscape(r.symbol)}" type="button" title="Upside/downside karar fiyatına göre hesaplanmıştır; PriceLevel ve RiskLevel için tıkla">${htmlEscape(coinLabel)}</button></td>
        <td data-role="ys">${metaYsHtml(g.ys)}</td>
        <td>${resultPill(r.result)}</td>
        <td class="decisionCell ${plLabel==='—'||plLabel==='N/A'?'na':''}" data-role="price-level" title="${htmlEscape(plTitle)}">${htmlEscape(plLabel)}</td>
        <td class="decisionCell ${rlLabel==='—'||rlLabel==='N/A'?'na':''}" data-role="risk-level" title="${htmlEscape(rlTitle)}">${htmlEscape(rlLabel)}</td>
        <td><input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" placeholder="Entry Price" inputmode="decimal"></td>
        <td><input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" placeholder="Stop Price" inputmode="decimal"></td>
        <td class="num" data-role="current-price" title="USDⓈ-M Futures final decision price">${htmlEscape(metaFormatPrice(Number.isFinite(r.decisionPrice)?r.decisionPrice:r.snapshot2))}</td>
        <td><button class="followBtn" data-action="follow" data-symbol="${htmlEscape(r.symbol)}" type="button">Follow</button></td>
        <td class="monitorCell"><span class="monitorDot off" title="OFF" aria-label="OFF"></span></td>
        <td class="monitorReason"><span class="reasonText" title="${htmlEscape(entryDecisionTitle(r))}">${htmlEscape(entryDecisionSummary(r))}</span><div class="monitorTime"></div></td>
        <td class="liveChangeCell" data-role="live-change"></td>
        <td class="liveResultCell" data-role="live-result"></td>
        <td class="num" data-role="meta-volume" title="Cr Spot USDT quoteVolume">${htmlEscape(metaFormatVolume(g.volume24h))}</td>
        <td class="num" data-role="meta-total-supply">${htmlEscape(metaFormatSupply(g.totalSupply))}</td>
        <td class="num" data-role="meta-circ-supply">${htmlEscape(metaFormatSupply(g.circulatingSupply))}</td>
        <td class="metaAge" data-role="meta-age" title="${Number.isFinite(g.listingTime)?`İlk Cr Spot USDT günlük mum: ${htmlEscape(ageDate)}`:''}">${htmlEscape(age)}${Number.isFinite(g.listingTime)?`<small>${htmlEscape(ageDate)}</small>`:''}</td>
        <td class="num" data-role="meta-max">${htmlEscape(metaFormatPrice(g.allTimeHigh))}</td>
        <td class="num" data-role="meta-min">${htmlEscape(metaFormatPrice(g.allTimeLow))}</td>
        <td data-role="meta-hour">${htmlEscape(g.requestTime||'—')}</td>
      </tr>`;
    }).join('');
    notifyCandidatesRendered();
  }


  function updateCandidateMomentumUI(rows){
    // Momentum Analysis UI was removed in V13.4.
  }

  function updateV5MetadataUI(rows){
    for(const r of rows||[]){
      const tr=scanRow(r.symbol);if(!tr)continue;
      const g=r.gridMeta||{},age=metaFormatAge(g.listingTime),ageDate=metaFormatDate(g.listingTime);
      const ys=tr.querySelector('[data-role="ys"]');if(ys)ys.innerHTML=metaYsHtml(g.ys);
      const vol=tr.querySelector('[data-role="meta-volume"]');if(vol)vol.textContent=metaFormatVolume(g.volume24h);
      const total=tr.querySelector('[data-role="meta-total-supply"]');if(total)total.textContent=metaFormatSupply(g.totalSupply);
      const circ=tr.querySelector('[data-role="meta-circ-supply"]');if(circ)circ.textContent=metaFormatSupply(g.circulatingSupply);
      const ageCell=tr.querySelector('[data-role="meta-age"]');if(ageCell){ageCell.title=Number.isFinite(g.listingTime)?`İlk Cr Spot USDT günlük mum: ${ageDate}`:'';ageCell.innerHTML=`${htmlEscape(age)}${Number.isFinite(g.listingTime)?`<small>${htmlEscape(ageDate)}</small>`:''}`;}
      const max=tr.querySelector('[data-role="meta-max"]');if(max)max.textContent=metaFormatPrice(g.allTimeHigh);
      const min=tr.querySelector('[data-role="meta-min"]');if(min)min.textContent=metaFormatPrice(g.allTimeLow);
      const hour=tr.querySelector('[data-role="meta-hour"]');if(hour)hour.textContent=g.requestTime||'—';
    }
  }
function renderQueue(rows){
  const q=rows.filter(r=>resultKind(r)==='SELECT'),el=$('manualQueue');
  if(!q.length){el.innerHTML='<span class="empty">Entry Ready / SELECT yok.</span>';return;}
  el.innerHTML=q.map((r,i)=>{const c=r.chartAnalysis||v2NotRun('analysis unavailable');return `<span class="queueItem" title="${htmlEscape(c.reason||'')}"><b>${i+1}. ${htmlEscape(coinRangeLabel(r))}</b> · 7 ${htmlEscape(c.step7?.regime||'—')} · 8 ${htmlEscape(c.step8?.setup||'—')} · 9 ${htmlEscape(c.step9?.score||'—')} · 10 ${htmlEscape(c.step10?.status||'—')} · Loc ${htmlEscape(c.priceLocation?.verdict||'—')} · R/R ${c.priceLocation?.structuralAsymmetry===Infinity?'OPEN':fmt(c.priceLocation?.structuralAsymmetry,2)} · <b>ENTRY READY</b></span>`;}).join('');
}

function updateSummary(rows,universeCount,fastCount,eventCount){
  $('sumUniverse').textContent=String(universeCount);$('sumFast').textContent=String(fastCount);$('sumEventWatch').textContent=String(eventCount);
  $('sumSelect').textContent=String(rows.filter(r=>resultKind(r)==='SELECT').length);
  $('sumCaution').textContent=String(rows.filter(r=>resultKind(r)==='CAUTION').length);
  if($('sumWait'))$('sumWait').textContent='0';
  if($('sumReject'))$('sumReject').textContent='0';
  const analyzed=rows.filter(r=>r.chartAnalysis&&r.chartAnalysis.final!=='NOT_RUN');
  $('sumV2Analyzed').textContent=String(analyzed.length);
  $('sumV2Ready').textContent=String(rows.filter(r=>resultKind(r)==='SELECT').length);
  $('sumV2Wait').textContent=String(rows.filter(r=>resultKind(r)==='CAUTION').length);
  $('sumV2Skip').textContent=String(rows.filter(r=>r.chartAnalysis?.step10?.status==='SKIP_CHASE').length);
}


  async function startScan(){
    if(state.running||startScanModule()?.state?.running)return;
    const windowSec=num($('windowSec').value),minIncrease=num($('minIncrease').value),maxIncrease=num($('maxIncrease').value);
    if(!(windowSec>=1&&windowSec<=300&&minIncrease>=0&&maxIncrease>=minIncrease&&maxIncrease<=100)){setStatus('Sec / MinY / MaxY değerlerini kontrol edin.','bad');return;}
    startScanModule()?.autoScan?.cancel?.();
    captureFollowRowsBeforeScan();entrySnapshotCache.clear();
    state.running=true;state.controller=new AbortController();state.startedAt=Date.now();state.settings={windowSec,minIncrease,maxIncrease,mode:VERSION};
    resetUI();state.rateLimited=false;setButtons(true);
    document.dispatchEvent(new CustomEvent('cryptooffer:scan-start',{detail:{reason:'OneM 5–30m LONG scan',preserveFollow:true,source:'OneMScan'}}));
    try{
      const exchange=await getExchangeInfo(),eligible=activeSymbols(exchange),eligibleMap=new Map(eligible.map(x=>[x.symbol,x]));
      let activity;
      if(state.activityCache&&activityCacheAgeMs()<ACTIVITY_CACHE_MS)activity=state.activityCache.activity.filter(r=>eligibleMap.has(r.symbol));
      else{
        const [tickers,books]=await Promise.all([getBulk24(),getBulkBook()]);
        activity=await buildActivityRank(exchange,tickers,books);
        savePersistentActivityCache({createdAt:Date.now(),activeCount:eligible.length,activity});
      }
      activity=activity.map(r=>({...r,tickSize:num(eligibleMap.get(r.symbol)?.filters?.find(f=>f.filterType==='PRICE_FILTER')?.tickSize)}));
      state.activity=activity;$('sumActive').textContent=eligible.length;$('sumRanked').textContent=activity.length;
      $('sum301').textContent=activity.filter(r=>r.activityRank>=300).length;
      const first=await getBulkPrices(),t1=await getServerTime();
      const firstMap=new Map(first.map(p=>[p.symbol,p]));
      const deadline=performance.now()+windowSec*1000;
      setStatus(`OneM: ${windowSec} saniyelik güncel fiyat hareketi ölçülüyor…`);
      while(performance.now()<deadline){
        if(state.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
        progress(40+10*(1-(deadline-performance.now())/(windowSec*1000)),'Snapshot #2');
        await sleep(Math.min(250,Math.max(0,deadline-performance.now())));
      }
      const second=await getBulkPrices(),t2=await getServerTime(),secondMap=new Map(second.map(p=>[p.symbol,p]));
      state.snapshotElapsedMs=t2-t1;
      const candidates=activity.map(r=>{
        const a=firstMap.get(r.symbol),b=secondMap.get(r.symbol),p1=num(a?.price),p2=num(b?.price);
        return {...r,snapshot1:p1,snapshot2:p2,fastChange:(p2/p1-1)*100,fastEventStartTime:t1,fastEventTime:t2,fastEventPrice:p2,
          quoteSnapshotsValid:p1>0&&p2>0&&Number.isFinite(num(a?.time))&&Number.isFinite(num(b?.time))&&num(a.time)<=t1&&num(b.time)<=t2&&t1-num(a.time)<=CONFIG.quoteMaxAgeMs&&t2-num(b.time)<=CONFIG.quoteMaxAgeMs};
      }).filter(r=>r.quoteSnapshotsValid).sort((a,b)=>b.fastChange-a.fastChange);
      log(`Current scan: ${candidates.length}/${activity.length} current snapshots valid; Sec=${windowSec}. MinY/MaxY are diagnostic only; no historical candidates injected.`);
      const scanCandidates=candidates.slice(0,CONFIG.maxKlineSymbols);
      log(`Structure data budget: ${scanCandidates.length} symbols × 1 request (5m); Fast Event thresholds are not a selection gate.`);
      let rows=[];
      if(scanCandidates.length){
        // One current 5m kline request per selected live symbol. 15m candles
        // are aggregated locally from those closed 5m candles.
        await mapLimit(scanCandidates,CONFIG.concurrency,r=>prepareEntrySnapshots(r,t2),{onProgress:(d,n)=>progress(50+30*d/n,`5m structure ${d}/${n}`)});
        const structureTime=await getServerTime(),setupRows=[],waitingRows=[];
        for(const r of scanCandidates){
          const cached=entrySnapshotCache.get(r.symbol)||{};
          let hasSetup=false;
          try{
            const c5=validateCandles(cached.m5?.candles||[],300000,structureTime,cached.m5?.asOf);
            const c15=validateCandles(cached.m15?.candles||[],900000,structureTime,cached.m15?.asOf);
            const five=priceStructure(c5),low=five.direction<0?five.pending:five.lows.at(-1);
            const high=low?five.highs.filter(h=>h.index<low.index).at(-1):null;
            const previousLow=high?five.lows.filter(l=>l.index<high.index).at(-1):null;
            hasSetup=!!(c15.length>=CONFIG.minHistory&&low&&high&&previousLow);
          }catch{}
          if(hasSetup)setupRows.push(r);
          else waitingRows.push({...r,result:'CAUTION',reasons:['5m setup structure is not complete'],chartAnalysis:{engine:VERSION,final:'CAUTION',gate:'SETUP',reason:'5m setup structure is not complete',step7:{regime:'—',timeframe:'15m'},step8:{setup:'NONE',status:'WAIT',timeframe:'5m structure'},step9:{status:'WAIT',score:'WAIT',timeframe:'live'},step10:{status:'WAIT'},decision:{result:'CAUTION',drops:[],cautions:['5m setup structure is not complete'],coreCautions:['5m setup structure is not complete'],softWarnings:[]}}});
        }
        const [books,premium,latestExchange]=await Promise.all([getBulkBook(),fetchJson(`${BASE}/fapi/v1/premiumIndex`,{essential:true}),getExchangeInfo()]);
        const time=await getServerTime(),booksMap=new Map(books.map(b=>[b.symbol,b]));
        const premiums=new Map(premium.map(p=>[p.symbol,p]));
        const latest=new Map(activeSymbols(latestExchange).map(s=>[s.symbol,s]));
        const analyzed=await Promise.all(setupRows.map(r=>{
          const s=latest.get(r.symbol),delivery=num(s?.deliveryDate);
          if(!s||(delivery>0&&delivery<=time+CONFIG.horizonMaxMin*60000))return {...r,result:'DROP',reasons:['Contract no longer eligible'],chartAnalysis:{gate:'OPERATIONAL',reason:'Contract no longer eligible'}};
          return analyzeChartCandidate(r,time,booksMap,premiums);
        }));
        rows=[...waitingRows,...analyzed];
      }
      finalizeGateDiagnostics(rows);
      state.results=sortCandidates(rows.filter(r=>resultKind(r)!=='DROP'));
      renderCandidates(state.results,windowSec);renderQueue(state.results);
      updateSummary(state.results,activity.length,scanCandidates.length,candidates.length);
      for(const id of ['learnCompleted','learnPending'])if($(id))$(id).textContent='—';
      clearMarketContext('OneM: 15m yön bilgisi sonuç satırında; eski 4h model kullanılmıyor.');
      progress(100,'OneM decisions ready');
      const displayed=gridRowsForDisplay(state.results);
      const selected=state.results.filter(r=>resultKind(r)==='SELECT').length;
      log(`Grid render: SELECT=${selected}, displayed=${displayed.filter(r=>resultKind(r)==='SELECT').length}`);
      const rejected=Object.entries(state.gateDiagnostics).filter(([k])=>k!=='SELECT').map(([k,n])=>`${k}: ${n}`).join(' · ');
      setStatus(`OneM ${VERSION}: SELECT ${selected} · ${rejected||'aday yok'}. Ek bilgiler yükleniyor…`,selected?'good':'warn');
      log(`Round-trip cost estimate: ${CONFIG.estimatedRoundTripCostPct}%, plus positive funding when due within 30m. This is an assumption, not an account fee quote.`);
      if(displayed.length){await enrichV5GridMetadata(displayed);updateV5MetadataUI(displayed);}
      setStatus(`OneM ${VERSION}: SELECT ${selected} · ${rejected||'aday yok'} · ${state.requestCount} requests · ${((Date.now()-state.startedAt)/1000).toFixed(1)}s`,selected?'good':'warn');
    }catch(e){
      setStatus(state.rateLimited?'Veri sağlayıcı hız sınırı: tarama durduruldu.':e.name==='AbortError'?'OneM taraması iptal edildi.':`OneM tamamlanamadı: ${e.message}`,'warn');
      log(e.message);
    }finally{
      entrySnapshotCache.clear();state.running=false;setButtons(false);
      if(autoScanEnabled())startScanModule()?.autoScan?.schedule?.();
    }
  }
  function exportCSV(){
    const columns=['symbol','result','decisionTime','decisionPrice','setup','level','stop','target','entryCeiling','netRR','reasons'];
    const lines=[columns.join(',')];
    for(const r of state.results){const p=r.plan||{};lines.push(columns.map(k=>JSON.stringify(k==='reasons'?r.reasons.join('; '):r[k]??p[k]??'')).join(','));}
    downloadBlob(lines.join('\r\n'),'OneMScan.csv','text/csv;charset=utf-8');
  }
  function exportJSON(){downloadBlob(JSON.stringify({version:VERSION,settings:state.settings,diagnostics:state.gateDiagnostics,results:state.results},null,2),'OneMScan.json','application/json');}
  function downloadBlob(text,name,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

  // OneMScan uses the existing UI fields. Other modules keep their own state.
  $('oneMScanBtn')?.addEventListener('click',()=>void startScan());
  $('cancelBtn')?.addEventListener('click',()=>{if(state.running)state.controller?.abort();});
  for(const [id,action] of [['csvBtn',exportCSV],['jsonBtn',exportJSON]])$(id)?.addEventListener('click',event=>{
    if(!state.running&&state.results.length&&state.startedAt>(startScanModule()?.state?.startedAt||0)){
      event.preventDefault();event.stopImmediatePropagation();action();
    }
  },true);
  loadPersistentActivityCache();
  window.CryptoFlowScanner=window.CryptoFlowScanner||{modules:{}};
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.oneMScan={version:VERSION,state,start:startScan,cancel:()=>state.controller?.abort(),config:CONFIG};
})();
