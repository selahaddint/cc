(() => {
  'use strict';

  // ================================================================
  // START SCAN MODULE
  // Owns: Start Scan, candidate selection, chart/location analysis,
  // metadata enrichment, scan caches, summaries and scan exports.
  // Does NOT call Risk Management or Follow functions.
  // ================================================================

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
  const MAX_HOLD_MS=4*60*60*1000;
  const DEPTH_BPS=10;
  const ACTIVITY_CONCURRENCY=10;
  const ACTIVITY_PAUSE_MS=0;
  const DETAIL_CONCURRENCY=4;
  const ACTIVITY_CACHE_MS=30*60*1000;
  const ACTIVITY_CACHE_KEY='CryptoOfferV3.ActivityRankCache.v1';
  const ACTIVITY_CACHE_VERSION=1;
  const FAST_EVENT_TTL_MS=MAX_HOLD_MS;
  const FAST_EVENT_CACHE_KEY='CryptoOfferV4.1.FastEventWatch.v1';
  const FAST_EVENT_CACHE_VERSION=1;
  const PRICE_LEARNING_KEY='CryptoOfferV4.2.PriceLearning.v1';
  const PRICE_LEARNING_VERSION=1;
  const PRICE_CONFIG=Object.freeze({minStatSamples:30,levelMergeAtr:0.20,completionPerScan:12,completionConcurrency:3,breakoutVolumeSma:20});

  // Start Scan / SELECT-only Entry Freshness Gate.
  // Fast path uses only recent completed 15m candles. Historical analogs are built
  // asynchronously after the scan and cached per symbol so Start Scan is not blocked.
  const ENTRY_FRESHNESS_CONFIG=Object.freeze({
    recentLimit:150,recentMinBars:120,historyLimit:1500,forwardBars:16,minSamples:30,neighbors:30,
    cacheKey:'CryptoOfferV13.EntryFreshnessModel.v2',cacheVersion:2,cacheRefreshMs:6*60*60*1000,
    cacheHardMaxAgeMs:7*24*60*60*1000,cacheMaxSymbols:16,warmPauseMs:250
  });

  const entryFreshnessModelCache=new Map();
  const entryFreshnessRecentCache=new Map();
  let entryFreshnessWarmController=null;
  const STABLE_BASES=new Set(['USDC','FDUSD','TUSD','USDP','DAI','USDE','USDS','BUSD','AEUR']);

  const V2_CONFIG=Object.freeze({
    candleLimit:300,swingLeft:2,swingRight:2,structureAtr:0.10,emaSlopeBars:3,emaSlopeAtr:0.05,
    rangeEmaGapAtr:0.50,rangeBars:10,rangeMinEachSide:3,valueAtr:0.15,pullbackLookback:5,deepPullbackAtr:0.50,
    breakoutLookback:20,breakoutAtr:0.10,retestAtr:0.20,retestMaxBars:4,volumeSma:20,rsiPeriod:14,rsiMin:50,rsiMax:70,
    atrPeriod:14,atrPercentileLookback:100,atrPercentileMin:30,atrPercentileMax:80,triggerAtr5:0.05,noChaseAtr15:0.50,triggerValidBars:2
  });

  const $=id=>document.getElementById(id);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const fmt=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
  const pct=x=>Number.isFinite(x)?`${x>=0?'+':''}${x.toFixed(3)}%`:'—';
  const compact=x=>{
    if(!Number.isFinite(x)) return '—';
    return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(x);
  };
  const money=x=>Number.isFinite(x)?`${compact(x)} USDT`:'—';
  const htmlEscape=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  const state={running:false,controller:null,startedAt:0,requestCount:0,errors:[],results:[],activity:[],context:null,settings:null,thresholds:null,snapshotElapsedMs:null,fundingInfoLoaded:false,activityCache:null,eventWatch:new Map(),priceLearning:[]};
  window.CryptoOfferData=window.CryptoOfferData||{};
  window.CryptoOfferData.scanState=state;

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
    $('startBtn').disabled=running;$('cancelBtn').disabled=!running;$('refreshRankBtn').disabled=running;$('clearEventsBtn').disabled=running;
    $('csvBtn').disabled=running||!state.results.length;$('jsonBtn').disabled=running||!state.results.length;
  }
  function resetUI(){
    ['sumActive','sumRanked','sumUniverse','sum301','sumFast','sumEventWatch','sumSelect','sumCaution','sumWait','sumReject','sumV2Analyzed','sumV2Ready','sumV2Wait','sumV2Skip','ctxBtc','ctxMedian','ctxBreadth','ctxResult'].forEach(id=>$(id).textContent='—');
    $('candidateBody').innerHTML='<tr><td colspan="21" class="empty">Scan çalışıyor…</td></tr>';
    $('manualQueue').innerHTML='<span class="empty">Scan çalışıyor…</span>';
    $('contextStatus').textContent='Hesaplanıyor…';$('contextStatus').className='status info';
    $('logBox').textContent='Scan initialized.';progress(0,'Initializing');
    state.errors=[];state.results=[];state.activity=[];state.context=null;state.thresholds=null;state.snapshotElapsedMs=null;state.requestCount=0;state.fundingInfoLoaded=false;
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


  function validFastEvent(e){
    return !!e&&typeof e.symbol==='string'&&Number.isFinite(Number(e.eventTime))&&Number.isFinite(Number(e.eventPrice))&&Number.isFinite(Number(e.fastChange));
  }

  function updateFastEventWatchStatus(){
    const el=$('eventWatchStatus');if(!el)return;
    el.textContent=`Fast Event Watch: ${state.eventWatch.size} active • max age ${FAST_EVENT_TTL_MS/3600000}h • new event refreshes sequence`;
  }

  function saveFastEventWatch(){
    const events=[...state.eventWatch.values()];
    try{localStorage.setItem(FAST_EVENT_CACHE_KEY,JSON.stringify({version:FAST_EVENT_CACHE_VERSION,events}));}
    catch(e){log(`Fast Event watch save failed; memory watch remains active: ${e.message||e}`);}
    updateFastEventWatchStatus();
  }

  function pruneFastEventWatch(referenceTime=Date.now()){
    let removed=0;
    for(const [symbol,e] of state.eventWatch){
      const age=referenceTime-Number(e.eventTime);
      if(!validFastEvent(e)||!Number.isFinite(age)||age<0||age>FAST_EVENT_TTL_MS){state.eventWatch.delete(symbol);removed++;}
    }
    if(removed)saveFastEventWatch();else updateFastEventWatchStatus();
    return removed;
  }

  function clearFastEventWatch(){
    state.eventWatch=new Map();
    try{localStorage.removeItem(FAST_EVENT_CACHE_KEY);}catch(e){log(`Fast Event watch clear failed: ${e.message||e}`);}
    updateFastEventWatchStatus();
  }

  function loadFastEventWatch(){
    state.eventWatch=new Map();
    try{
      const raw=localStorage.getItem(FAST_EVENT_CACHE_KEY);if(!raw){updateFastEventWatchStatus();return;}
      const parsed=JSON.parse(raw);if(parsed?.version!==FAST_EVENT_CACHE_VERSION||!Array.isArray(parsed.events)){localStorage.removeItem(FAST_EVENT_CACHE_KEY);updateFastEventWatchStatus();return;}
      for(const e of parsed.events)if(validFastEvent(e))state.eventWatch.set(e.symbol,e);
      const removed=pruneFastEventWatch(Date.now());
      log(`Fast Event watch loaded: ${state.eventWatch.size} active${removed?`, ${removed} expired removed`:''}.`);
    }catch(e){state.eventWatch=new Map();updateFastEventWatchStatus();log(`Fast Event watch load failed: ${e.message||e}`);}
  }

  function registerFastEvents(fastPass,referenceTime){
    let added=0,refreshed=0;
    pruneFastEventWatch(referenceTime);
    for(const r of fastPass){
      const eventTime=Number(r.fastEventTime)||referenceTime;
      const existed=state.eventWatch.has(r.symbol);
      state.eventWatch.set(r.symbol,{symbol:r.symbol,eventTime,eventPrice:r.snapshot2,fastChange:r.fastChange,windowSec:state.settings?.windowSec||NaN,minIncrease:state.settings?.minIncrease,maxIncrease:state.settings?.maxIncrease,createdAt:Date.now()});
      existed?refreshed++:added++;
    }
    if(added||refreshed)saveFastEventWatch();else updateFastEventWatchStatus();
    return {added,refreshed};
  }

  function priceFmt(x){
    if(!Number.isFinite(x))return '—';
    const a=Math.abs(x),d=a>=1000?2:a>=1?4:a>=0.01?6:8;
    return x.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
  }

  function updateLearningStatus(){
    const completed=state.priceLearning.filter(x=>x.completed).length,pending=state.priceLearning.length-completed;
    if($('learnCompleted'))$('learnCompleted').textContent=String(completed);
    if($('learnPending'))$('learnPending').textContent=String(pending);
  }

  function validLearningObservation(x){
    return !!x&&typeof x.id==='string'&&typeof x.symbol==='string'&&Number.isFinite(Number(x.entryTime))&&Number.isFinite(Number(x.entryPrice))&&x.entryPrice>0;
  }

  function loadPriceLearning(){
    state.priceLearning=[];
    try{
      const raw=localStorage.getItem(PRICE_LEARNING_KEY);if(!raw){updateLearningStatus();return;}
      const parsed=JSON.parse(raw);if(parsed?.version!==PRICE_LEARNING_VERSION||!Array.isArray(parsed.observations)){localStorage.removeItem(PRICE_LEARNING_KEY);updateLearningStatus();return;}
      state.priceLearning=parsed.observations.filter(validLearningObservation);
    }catch(e){log(`Price learning load failed: ${e.message||e}`);state.priceLearning=[];}
    updateLearningStatus();
  }

  function savePriceLearning(){
    try{localStorage.setItem(PRICE_LEARNING_KEY,JSON.stringify({version:PRICE_LEARNING_VERSION,observations:state.priceLearning}));}
    catch(e){log(`Price learning save failed: ${e.message||e}`);}
    updateLearningStatus();
  }

  function learningKey(regime,setup){return `${regime||'—'}|${setup||'—'}`;}

  function getStatModel(regime,setup,horizonMin=240){
    const allowed=[15,30,60,120,240];
    const horizon=allowed.find(x=>x>=horizonMin)||240;
    const mk=`mfe${horizon}Pct`,ak=`mae${horizon}Pct`;
    const rows=state.priceLearning.filter(x=>x.completed&&x.regime===regime&&x.setup===setup&&Number.isFinite(Number(x[mk]))&&Number.isFinite(Number(x[ak])));
    const mfe=median(rows.map(x=>Number(x[mk]))),mae=median(rows.map(x=>Number(x[ak])));
    return {key:learningKey(regime,setup),horizonMin:horizon,n:rows.length,ready:rows.length>=PRICE_CONFIG.minStatSamples,mfePct:mfe,maePct:mae};
  }

  async function getForward5mKlines(symbol,entryTime){
    const start=Math.floor((entryTime+1)/300000)*300000;
    const end=entryTime+MAX_HOLD_MS;
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&startTime=${start}&endTime=${end}&limit=60`,{retries:2,timeout:15000});
    if(!Array.isArray(raw))return [];
    return raw.map(klineToCandle).filter(c=>c.openTime>entryTime&&c.closeTime<=end&&[c.high,c.low].every(Number.isFinite));
  }

  function excursionAt(candles,entryPrice,entryTime,horizonMin){
    const end=entryTime+horizonMin*60000,rows=candles.filter(c=>c.closeTime<=end);
    if(!rows.length)return {mfePct:NaN,maePct:NaN};
    const hi=Math.max(...rows.map(c=>c.high)),lo=Math.min(...rows.map(c=>c.low));
    return {mfePct:Math.max(0,(hi/entryPrice-1)*100),maePct:Math.max(0,(1-lo/entryPrice)*100)};
  }

  async function completePriceLearning(referenceTime){
    const due=state.priceLearning.filter(x=>!x.completed&&referenceTime>=Number(x.entryTime)+MAX_HOLD_MS).slice(0,PRICE_CONFIG.completionPerScan);
    if(!due.length){updateLearningStatus();return 0;}
    const done=await mapLimit(due,PRICE_CONFIG.completionConcurrency,async obs=>{
      const candles=await getForward5mKlines(obs.symbol,Number(obs.entryTime));
      if(candles.length<40)return null;
      const patch={completed:true,completedAt:referenceTime};
      for(const h of [15,30,60,120,240]){const x=excursionAt(candles,Number(obs.entryPrice),Number(obs.entryTime),h);patch[`mfe${h}Pct`]=x.mfePct;patch[`mae${h}Pct`]=x.maePct;}
      return {id:obs.id,patch};
    });
    let count=0;
    for(const x of done.filter(Boolean)){
      const idx=state.priceLearning.findIndex(o=>o.id===x.id);if(idx<0)continue;
      state.priceLearning[idx]={...state.priceLearning[idx],...x.patch};count++;
    }
    if(count)savePriceLearning();else updateLearningStatus();
    log(`Price learning completion: ${count}/${due.length} due observations completed${state.priceLearning.filter(x=>!x.completed&&referenceTime>=Number(x.entryTime)+MAX_HOLD_MS).length?', more remain for next scan':''}.`);
    return count;
  }

  function registerPriceObservation(row,chart,location){
    if(chart?.step10?.status!=='READY'||!Number.isFinite(location?.currentPrice)||!Number.isFinite(location?.currentTime))return;
    const id=`${row.symbol}|${Number(row.fastEventTime)||0}|${Number(chart.step8?.setupTime)||0}|${Number(chart.step9?.firstConfirmationTime)||0}`;
    if(state.priceLearning.some(x=>x.id===id))return;
    state.priceLearning.push({id,symbol:row.symbol,createdAt:Date.now(),entryTime:location.currentTime,entryPrice:location.currentPrice,regime:chart.step7?.regime||'—',setup:chart.step8?.setup||'—',atr15:location.atr15,fastChange:row.fastChange,activityRank:row.activityRank,context:state.context?.result||'—',completed:false});
    savePriceLearning();
    log(`Price learning observation registered: ${row.symbol} ${chart.step7?.regime}/${chart.step8?.setup} @ ${priceFmt(location.currentPrice)}.`);
  }

  function clusterPriceLevels(levels,atr15){
    const valid=levels.filter(x=>x&&Number.isFinite(x.price)&&x.price>0).sort((a,b)=>a.price-b.price);
    if(!valid.length)return [];
    const gap=Number.isFinite(atr15)&&atr15>0?PRICE_CONFIG.levelMergeAtr*atr15:0;
    const groups=[];
    for(const x of valid){
      const g=groups.at(-1);
      if(g&&Math.abs(x.price-g.price)<=gap){
        g.items.push(x);g.weight+=x.weight||1;g.price=g.items.reduce((a,v)=>a+v.price*(v.weight||1),0)/g.weight;
      }else groups.push({price:x.price,weight:x.weight||1,items:[x]});
    }
    return groups.map(g=>({...g,sources:[...new Set(g.items.map(x=>x.source))]}));
  }

  function buildStructuralLevels(c1h,c15,i15,step7,step8,currentPrice){
    const t15=c15.length-1,atr15=i15.atr14[t15];
    const h1=findSwings(c1h,V2_CONFIG.swingLeft,V2_CONFIG.swingRight),h15=findSwings(c15,V2_CONFIG.swingLeft,V2_CONFIG.swingRight);
    const resist=[],support=[];
    for(const x of h1.highs.slice(-8))resist.push({price:x.price,weight:3,source:'1h Swing High'});
    for(const x of h1.lows.slice(-8))support.push({price:x.price,weight:3,source:'1h Swing Low'});
    for(const x of h15.highs.slice(-10))resist.push({price:x.price,weight:2,source:'15m Swing High'});
    for(const x of h15.lows.slice(-10))support.push({price:x.price,weight:2,source:'15m Swing Low'});
    if(step7?.regime==='RANGE'&&c15.length>=V2_CONFIG.breakoutLookback){
      const recent=c15.slice(-V2_CONFIG.breakoutLookback),rh=Math.max(...recent.map(c=>c.high)),rl=Math.min(...recent.map(c=>c.low));
      resist.push({price:rh,weight:2.5,source:'15m Range Upper'});support.push({price:rl,weight:2.5,source:'15m Range Lower'});
    }
    if(step8?.setup==='PULLBACK_VALUE'){
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'15m Value Low'});
      if(Number.isFinite(step8.ema25))support.push({price:step8.ema25,weight:2,source:'15m EMA25'});
    }
    if(step8?.setup==='BREAKOUT_RETEST'){
      if(Number.isFinite(step8.rangeHigh))support.push({price:step8.rangeHigh,weight:3,source:'Breakout/Retest Level'});
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'Retest Low'});
    }
    const rc=clusterPriceLevels(resist,atr15).filter(x=>x.price>currentPrice).sort((a,b)=>a.price-b.price);
    const sc=clusterPriceLevels(support,atr15).filter(x=>x.price<currentPrice).sort((a,b)=>b.price-a.price);
    return {atr15,resistance:rc[0]||null,support:sc[0]||null,resistanceClusters:rc,supportClusters:sc};
  }

  function structuralInvalidation(step8,i15,c15){
    const t=c15.length-1,atr=i15.atr14[t];
    if(step8?.setup==='PULLBACK_VALUE'&&Number.isFinite(indSafe(i15.ema25,t))&&Number.isFinite(atr))return i15.ema25[t]-V2_CONFIG.deepPullbackAtr*atr;
    if(step8?.setup==='BREAKOUT_RETEST'&&Number.isFinite(step8.entryZoneLow))return step8.entryZoneLow;
    return NaN;
  }
  function indSafe(a,i){return Array.isArray(a)?a[i]:NaN;}

  function computePriceLocation(c1h,c15,c5,i15,step7,step8,{horizonMin=240}={}){
    const t5=c5.length-1,currentPrice=c5[t5].close,currentTime=c5[t5].closeTime;
    const structural=buildStructuralLevels(c1h,c15,i15,step7,step8,currentPrice),atr15=structural.atr15;
    const model=getStatModel(step7?.regime,step8?.setup,horizonMin);
    const r=structural.resistance?.price??NaN,s=structural.support?.price??NaN;
    const statUpper=model.ready&&Number.isFinite(model.mfePct)?currentPrice*(1+model.mfePct/100):NaN;
    const statLower=model.ready&&Number.isFinite(model.maePct)?currentPrice*(1-model.maePct/100):NaN;
    const maxExpected=Number.isFinite(r)&&Number.isFinite(statUpper)?Math.min(r,statUpper):Number.isFinite(r)?r:statUpper;
    const invalidation=structuralInvalidation(step8,i15,c15);
    const structuralLower=Number.isFinite(s)?s:invalidation;
    const minExpected=Number.isFinite(structuralLower)&&Number.isFinite(statLower)?Math.min(structuralLower,statLower):Number.isFinite(structuralLower)?structuralLower:statLower;
    const upsideAtr=Number.isFinite(maxExpected)&&Number.isFinite(atr15)&&atr15>0?(maxExpected-currentPrice)/atr15:NaN;
    const downsideAtr=Number.isFinite(minExpected)&&Number.isFinite(atr15)&&atr15>0?(currentPrice-minExpected)/atr15:NaN;
    const asymmetry=Number.isFinite(upsideAtr)&&Number.isFinite(downsideAtr)&&downsideAtr>0?upsideAtr/downsideAtr:NaN;
    let verdict='INSUFFICIENT';
    if(Number.isFinite(maxExpected)&&Number.isFinite(minExpected))verdict=model.ready?(Number.isFinite(asymmetry)&&asymmetry>=1?'FAVORABLE':'UNFAVORABLE'):'CALIBRATING';
    return {currentPrice,currentTime,atr15,nearestResistance:r,nearestResistanceSources:structural.resistance?.sources||[],nearestSupport:s,nearestSupportSources:structural.support?.sources||[],structuralInvalidation:invalidation,statUpper,statLower,maxExpected,minExpected,upsideAtr,downsideAtr,asymmetry,verdict,model,horizonMin:model.horizonMin};
  }

  function locationPill(loc){const v=(loc?.verdict||'INSUFFICIENT').toLowerCase();return `<span class="pill ${v}">${htmlEscape(loc?.verdict||'INSUFFICIENT')}</span>`;}

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
          const retryAfter=Number(res.headers.get('Retry-After'));
          const err=new Error(`HTTP ${res.status}`);
          err.retryDelayMs=Number.isFinite(retryAfter)?retryAfter*1000:1500*Math.pow(2,attempt);
          throw err;
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

  function depthMetrics(book,mid){
    if(!book||!Number.isFinite(mid)||mid<=0) return {bidDepth:NaN,askDepth:NaN,depth:NaN};
    const band=DEPTH_BPS/10000;
    let bid=0,ask=0;
    for(const [ps,qs] of (book.bids||[])){
      const p=num(ps),q=num(qs);if(Number.isFinite(p)&&Number.isFinite(q)&&p>=mid*(1-band)) bid+=p*q;
    }
    for(const [ps,qs] of (book.asks||[])){
      const p=num(ps),q=num(qs);if(Number.isFinite(p)&&Number.isFinite(q)&&p<=mid*(1+band)) ask+=p*q;
    }
    return {bidDepth:bid,askDepth:ask,depth:Math.min(bid,ask)};
  }
  function spreadPct(book){
    const bid=num(book?.bidPrice),ask=num(book?.askPrice);if(!(bid>0&&ask>0&&ask>=bid))return NaN;const mid=(bid+ask)/2;return (ask-bid)/mid*100;
  }

  const RISK_BANDS=Object.freeze({
    '0-10':[0,10],
    '11-50':[11,50],
    '51-100':[51,100],
    '100-150':[100,150],
    '150-200':[150,200],
    '250-300':[250,300],
    '300+':[300,Infinity]
  });
  function selectedRiskBands(){
    return ['all'];
  }
  function rankMatchesRiskBands(rank,bands){
    if(!Number.isFinite(rank)||!Array.isArray(bands)||!bands.length)return false;
    if(bands.includes('all'))return true;
    return bands.some(key=>{const range=RISK_BANDS[key];return range&&rank>=range[0]&&rank<=range[1];});
  }
  function riskBandsLabel(bands){return bands.includes('all')?'All':bands.join(', ');}

  async function getExchangeInfo(){return fetchJson(`${BASE}/fapi/v1/exchangeInfo`,{essential:true});}
  async function getBulk24(){return fetchJson(`${BASE}/fapi/v1/ticker/24hr`,{essential:true});}
  async function getBulkBook(){return fetchJson(`${BASE}/fapi/v1/ticker/bookTicker`,{essential:true});}
  async function getBulkPrices(){return fetchJson(`${BASE}/fapi/v2/ticker/price`,{essential:true});}
  async function getServerTime(){const x=await fetchJson(`${BASE}/fapi/v1/time`,{essential:true});return Number(x.serverTime);}

  function activeSymbols(exchange){
    return (exchange.symbols||[]).filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.underlyingType==='COIN'&&s.quoteAsset==='USDT'&&s.marginAsset==='USDT');
  }

  async function buildActivityRank(exchange,tickers,books){
    const syms=activeSymbols(exchange);
    const tickerMap=new Map((tickers||[]).map(x=>[x.symbol,x]));
    const bookMap=new Map((books||[]).map(x=>[x.symbol,x]));
    $('sumActive').textContent=String(syms.length);
    log(`Active crypto-only USDT PERPETUAL contracts (underlyingType=COIN): ${syms.length}`);

    const rows=await mapLimit(syms,ACTIVITY_CONCURRENCY,async s=>{
      const t=tickerMap.get(s.symbol),b=bookMap.get(s.symbol);if(!t||!b)return null;
      const price=num(t.lastPrice),quoteVolume=num(t.quoteVolume),sp=spreadPct(b),mid=(num(b.bidPrice)+num(b.askPrice))/2;
      const [oi,depth]=await Promise.all([
        fetchJson(`${BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(s.symbol)}`,{retries:2}),
        fetchJson(`${BASE}/fapi/v1/depth?symbol=${encodeURIComponent(s.symbol)}&limit=50`,{retries:2})
      ]);
      if(!oi||!depth||!(price>0)) return null;
      const oiQty=num(oi.openInterest),oiNotional=oiQty*price,dm=depthMetrics(depth,mid);
      if(![quoteVolume,sp,oiNotional,dm.depth].every(Number.isFinite)) return null;
      return {symbol:s.symbol,baseAsset:s.baseAsset,onboardDate:Number(s.onboardDate)||0,deliveryDate:Number(s.deliveryDate)||NaN,price,quoteVolume,spreadPct:sp,depth:dm.depth,oiQty,oiNotional,status:s.status};
    },{pauseMs:ACTIVITY_PAUSE_MS,onProgress:(d,n)=>progress(5+35*d/n,`Activity Rank data ${d}/${n}`)});

    const good=rows.filter(Boolean);
    assignRankScore(good,'quoteVolume',{higherBetter:true,outKey:'volumeScore'});
    assignRankScore(good,'oiNotional',{higherBetter:true,outKey:'oiScore'});
    assignRankScore(good,'spreadPct',{higherBetter:false,outKey:'spreadScore'});
    assignRankScore(good,'depth',{higherBetter:true,outKey:'depthScore'});
    for(const r of good){
      r.liquidityScore=.5*r.spreadScore+.5*r.depthScore;
      r.activityScore=.40*r.volumeScore+.35*r.oiScore+.25*r.liquidityScore;
    }
    good.sort((a,b)=>{
      const as=Math.round(a.activityScore*10),bs=Math.round(b.activityScore*10);
      if(bs!==as) return bs-as;
      return b.onboardDate-a.onboardDate; // new coin only when score is tied at 0.1-point resolution
    });
    good.forEach((r,i)=>r.activityRank=i+1);
    $('sumRanked').textContent=String(good.length);
    if(good.length<syms.length) log(`Activity data complete: ${good.length}/${syms.length}; incomplete symbols excluded from ranking.`);
    return good;
  }

  async function priceNear4hAgo(symbol,referenceTime){
    const target=referenceTime-4*60*60*1000;
    const start=target-60*1000,end=target+2*60*1000;
    const k=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${start}&endTime=${end}&limit=4`,{retries:2});
    if(!Array.isArray(k)||!k.length)return NaN;
    let best=k[0],dist=Math.abs(Number(k[0][0])-target);
    for(const row of k){const d=Math.abs(Number(row[0])-target);if(d<dist){best=row;dist=d;}}
    return num(best[4]);
  }

  async function computeMarketContext(activity,price2Map,referenceTime){
    const basket=[];
    for(const r of activity){
      if(r.symbol==='BTCUSDT'||STABLE_BASES.has(r.baseAsset))continue;
      basket.push(r);if(basket.length>=10)break;
    }
    const symbols=['BTCUSDT',...basket.map(x=>x.symbol)];
    const oldPrices=await mapLimit(symbols,4,async sym=>({symbol:sym,old:await priceNear4hAgo(sym,referenceTime)}),{pauseMs:80});
    const oldMap=new Map(oldPrices.filter(Boolean).map(x=>[x.symbol,x.old]));
    const ret=sym=>{const now=num(price2Map.get(sym)?.price),old=oldMap.get(sym);return now>0&&old>0?(now/old-1)*100:NaN;};
    const btc=ret('BTCUSDT'),basketReturns=basket.map(x=>ret(x.symbol)).filter(Number.isFinite);
    const med=median(basketReturns),breadth=basketReturns.length?100*basketReturns.filter(x=>x>0).length/basketReturns.length:NaN;
    const complete=Number.isFinite(btc)&&basketReturns.length===10&&Number.isFinite(med)&&Number.isFinite(breadth);
    let result='MIXED';
    if(complete){
      if(btc>0&&med>0&&breadth>50)result='UP';
      else if(btc<0&&med<0&&breadth<50)result='DOWN';
    }
    const ctx={btc,median:med,breadth,result,basketCount:basketReturns.length,complete,basketSymbols:basket.map(x=>x.symbol)};
    $('ctxBtc').textContent=pct(btc);$('ctxMedian').textContent=pct(med);$('ctxBreadth').textContent=Number.isFinite(breadth)?`${breadth.toFixed(1)}%`:'—';$('ctxResult').textContent=result;
    $('ctxResult').className=`v ${result==='UP'?'good':result==='DOWN'?'bad':'warn'}`;
    $('contextStatus').textContent=`Basket ${basketReturns.length}/10 usable • ${complete?'COMPLETE':'INCOMPLETE'} • ${result} yalnız context; otomatik LONG sinyali değildir.`;
    $('contextStatus').className=`status ${result==='UP'?'good':result==='DOWN'?'bad':'warn'}`;
    return ctx;
  }

  async function loadPremiumFunding(){
    const [premium,fundingInfo]=await Promise.all([
      fetchJson(`${BASE}/fapi/v1/premiumIndex`,{retries:3}),
      fetchJson(`${BASE}/fapi/v1/fundingInfo`,{retries:3})
    ]);
    state.fundingInfoLoaded=Array.isArray(fundingInfo);
    return {
      premiumMap:new Map((Array.isArray(premium)?premium:[]).map(x=>[x.symbol,x])),
      fundingInfoMap:new Map((Array.isArray(fundingInfo)?fundingInfo:[]).map(x=>[x.symbol,x]))
    };
  }

  function nearestOi4h(hist,refTime){
    if(!Array.isArray(hist)||!hist.length)return NaN;const target=refTime-4*60*60*1000;
    let best=hist[0],bestDist=Math.abs(Number(hist[0].timestamp)-target);
    for(const h of hist){const d=Math.abs(Number(h.timestamp)-target);if(d<bestDist){best=h;bestDist=d;}}
    return num(best.sumOpenInterest);
  }

  function entryFreshnessFeature(candles,ind,index,hlPrice,priceOverride=NaN){
    const atr=ind.atr14[index],e7=ind.ema7[index],e25=ind.ema25[index];
    const price=Number.isFinite(priceOverride)?priceOverride:candles[index]?.close;
    if(![atr,e7,e25,price,hlPrice].every(Number.isFinite)||!(atr>0)||!(hlPrice>0)||!(price>0))return null;
    const valueUpper=Math.max(e7,e25)+V2_CONFIG.valueAtr*atr;
    return {
      hlExtension:(price-hlPrice)/atr,
      valueExtension:Math.max(0,(price-valueUpper)/atr),
      valueUpper,atr,price
    };
  }

  function activeConfirmedHL(candles,ind,index){
    const right=V2_CONFIG.swingRight,lows=findSwings(candles,V2_CONFIG.swingLeft,right).lows.filter(x=>x.index+right<=index);
    if(lows.length<2)return null;
    const last=lows.at(-1),prev=lows.at(-2),confirmIndex=last.index+right,atrAtConfirm=ind.atr14[confirmIndex];
    if(!(Number.isFinite(atrAtConfirm)&&atrAtConfirm>0))return null;
    const tol=V2_CONFIG.structureAtr*atrAtConfirm;
    if(!(last.price>prev.price+tol))return null;
    return {price:last.price,index:last.index,confirmIndex,previousPrice:prev.price,time:candles[last.index]?.closeTime??NaN};
  }

  function entryFreshnessHistoricalSamples(candles,ind){
    const cfg=ENTRY_FRESHNESS_CONFIG,right=V2_CONFIG.swingRight,forward=cfg.forwardBars;
    const lows=findSwings(candles,V2_CONFIG.swingLeft,right).lows;
    const samples=[];
    let ptr=0,lastLow=null,prevLow=null,activeHL=null;
    const lastUsable=candles.length-forward-1;
    for(let i=0;i<=lastUsable;i++){
      while(ptr<lows.length&&lows[ptr].index+right<=i){
        prevLow=lastLow;lastLow=lows[ptr++];activeHL=null;
        if(prevLow){
          const confirmIndex=lastLow.index+right,atrAtConfirm=ind.atr14[confirmIndex];
          if(Number.isFinite(atrAtConfirm)&&atrAtConfirm>0&&lastLow.price>prevLow.price+V2_CONFIG.structureAtr*atrAtConfirm){
            activeHL={price:lastLow.price,index:lastLow.index,confirmIndex,hlTime:candles[lastLow.index]?.closeTime??NaN};
          }
        }
      }
      if(!activeHL)continue;
      const f=entryFreshnessFeature(candles,ind,i,activeHL.price);
      if(!f||!(f.valueExtension>0))continue;
      const future=candles.slice(i+1,i+1+forward);
      if(future.length!==forward)continue;
      const hi=Math.max(...future.map(c=>c.high)),lo=Math.min(...future.map(c=>c.low));
      const mfeAtr=Math.max(0,(hi-f.price)/f.atr),maeAtr=Math.max(0,(f.price-lo)/f.atr);
      if(![mfeAtr,maeAtr].every(Number.isFinite))continue;
      samples.push({index:i,hlTime:activeHL.hlTime,hlExtension:f.hlExtension,valueExtension:f.valueExtension,mfeAtr,maeAtr});
    }
    return samples;
  }

  function selectIndependentFreshnessNeighbors(samples,current,currentHlTime=NaN){
    const cfg=ENTRY_FRESHNESS_CONFIG;
    const ranked=(samples||[])
      .filter(s=>!(Number.isFinite(currentHlTime)&&Number(s.hlTime)===Number(currentHlTime)))
      .map(s=>({...s,distance:Math.hypot(s.hlExtension-current.hlExtension,s.valueExtension-current.valueExtension)}))
      .filter(s=>Number.isFinite(s.distance)).sort((a,b)=>a.distance-b.distance);
    const selected=[];
    for(const s of ranked){
      // Keep selected 4h forward windows independent inside the cached history.
      if(selected.some(x=>Math.abs(x.index-s.index)<cfg.forwardBars))continue;
      selected.push(s);if(selected.length>=cfg.neighbors)break;
    }
    return selected;
  }

  function validEntryFreshnessSample(s){
    return !!s&&Number.isFinite(Number(s.index))&&Number.isFinite(Number(s.hlExtension))&&Number.isFinite(Number(s.valueExtension))&&Number.isFinite(Number(s.mfeAtr))&&Number.isFinite(Number(s.maeAtr));
  }

  function loadEntryFreshnessCache(){
    entryFreshnessModelCache.clear();
    try{
      const raw=localStorage.getItem(ENTRY_FRESHNESS_CONFIG.cacheKey);if(!raw)return;
      const parsed=JSON.parse(raw);if(parsed?.version!==ENTRY_FRESHNESS_CONFIG.cacheVersion||!Array.isArray(parsed.models))return;
      for(const m of parsed.models){
        if(!m||typeof m.symbol!=='string'||!Number.isFinite(Number(m.createdAt))||!Array.isArray(m.samples))continue;
        const samples=m.samples.filter(validEntryFreshnessSample).map(s=>({index:Number(s.index),hlTime:Number(s.hlTime),hlExtension:Number(s.hlExtension),valueExtension:Number(s.valueExtension),mfeAtr:Number(s.mfeAtr),maeAtr:Number(s.maeAtr)}));
        if(samples.length)entryFreshnessModelCache.set(m.symbol,{symbol:m.symbol,createdAt:Number(m.createdAt),samples});
      }
    }catch(e){log(`Entry Freshness cache load failed: ${e.message||e}`);}
  }

  function saveEntryFreshnessCache(){
    try{
      const models=[...entryFreshnessModelCache.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,ENTRY_FRESHNESS_CONFIG.cacheMaxSymbols);
      const compactModels=models.map(m=>({symbol:m.symbol,createdAt:m.createdAt,samples:m.samples.map(s=>({
        index:s.index,hlTime:s.hlTime,
        hlExtension:Number(s.hlExtension.toFixed(4)),valueExtension:Number(s.valueExtension.toFixed(4)),
        mfeAtr:Number(s.mfeAtr.toFixed(4)),maeAtr:Number(s.maeAtr.toFixed(4))
      }))}));
      localStorage.setItem(ENTRY_FRESHNESS_CONFIG.cacheKey,JSON.stringify({version:ENTRY_FRESHNESS_CONFIG.cacheVersion,models:compactModels}));
      const keep=new Set(models.map(m=>m.symbol));for(const key of [...entryFreshnessModelCache.keys()])if(!keep.has(key))entryFreshnessModelCache.delete(key);
    }catch(e){log(`Entry Freshness cache save failed: ${e.message||e}`);}
  }

  function entryFreshnessCachedModel(symbol){
    const m=entryFreshnessModelCache.get(symbol);if(!m)return null;
    const age=Date.now()-Number(m.createdAt);
    if(!Number.isFinite(age)||age<0||age>ENTRY_FRESHNESS_CONFIG.cacheHardMaxAgeMs){entryFreshnessModelCache.delete(symbol);saveEntryFreshnessCache();return null;}
    return {...m,age,refreshNeeded:age>ENTRY_FRESHNESS_CONFIG.cacheRefreshMs};
  }

  function entryFreshnessRecentBucket(serverTime){return Math.floor((serverTime-1)/(15*60*1000));}

  async function getEntryFreshnessRecent(symbol,serverTime){
    const bucket=entryFreshnessRecentBucket(serverTime),cached=entryFreshnessRecentCache.get(symbol);
    if(cached?.bucket===bucket)return cached;
    const cfg=ENTRY_FRESHNESS_CONFIG;
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=${cfg.recentLimit}`,{retries:2,timeout:12000});
    if(!Array.isArray(raw))return null;
    const candles=raw.map(klineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<serverTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
    if(candles.length<cfg.recentMinBars)return {bucket,candles,ind:null,hl:null};
    const ind=buildIndicators(candles),hl=activeConfirmedHL(candles,ind,candles.length-1),value={bucket,candles,ind,hl};
    entryFreshnessRecentCache.set(symbol,value);
    if(entryFreshnessRecentCache.size>64){const first=entryFreshnessRecentCache.keys().next().value;entryFreshnessRecentCache.delete(first);}
    return value;
  }

  function analyze15mElderImpulse(recent){
    if(!recent||!Array.isArray(recent.candles)||recent.candles.length<35)return {status:'UNAVAILABLE',reason:'insufficient completed 15m candles'};
    const candles=recent.candles,t=candles.length-1,closes=candles.map(c=>c.close);
    const ema13=emaSeries(closes,13),macd=recent.ind?.macd||macdSeries(closes);
    const emaNow=ema13[t],emaPrev=ema13[t-1],histNow=macd?.hist?.[t],histPrev=macd?.hist?.[t-1];
    if(![emaNow,emaPrev,histNow,histPrev].every(Number.isFinite))return {status:'UNAVAILABLE',reason:'15m EMA13/MACD-H inputs incomplete'};
    const emaSlope=emaNow-emaPrev,histSlope=histNow-histPrev;
    const status=emaSlope<0&&histSlope<0?'BEARISH':emaSlope>0&&histSlope>0?'BULLISH':'NEUTRAL';
    return {status,ema13:emaNow,ema13Prev:emaPrev,emaSlope,macdHist:histNow,macdHistPrev:histPrev,histSlope,
      reason:status==='BEARISH'?'EMA13 slope DOWN + MACD-H slope DOWN':status==='BULLISH'?'EMA13 slope UP + MACD-H slope UP':'EMA13 and MACD-H slopes are mixed'};
  }

  function entryImpulseReason(x){
    if(!x||x.status==='UNAVAILABLE')return `15m Elder Impulse UNAVAILABLE — ${x?.reason||'unknown'}`;
    if(x.status==='BEARISH')return '15m Elder Impulse BEARISH — EMA13 slope DOWN + MACD-H slope DOWN';
    if(x.status==='BULLISH')return '15m Elder Impulse BULLISH — EMA13 slope UP + MACD-H slope UP';
    return '15m Elder Impulse NEUTRAL — EMA13 / MACD-H slopes mixed';
  }

  async function analyzeEntryFreshness(symbol,currentPrice,serverTime){
    const cfg=ENTRY_FRESHNESS_CONFIG;
    try{
      const recent=await getEntryFreshnessRecent(symbol,serverTime);
      if(!recent)return {status:'UNAVAILABLE',ready:false,n:0,impulse:{status:'UNAVAILABLE',reason:'recent 15m history unavailable'},reason:'recent 15m history unavailable'};
      const impulse=analyze15mElderImpulse(recent);
      if(!recent.ind||recent.candles.length<cfg.recentMinBars)return {status:'CALIBRATING',ready:false,n:0,impulse,reason:`recent 15m history ${recent.candles.length}/${cfg.recentMinBars}`};
      const t=recent.candles.length-1,hl=recent.hl;
      if(!hl)return {status:'NO_ACTIVE_HL',ready:false,n:0,impulse,reason:'no active confirmed 15m HL'};
      const current=entryFreshnessFeature(recent.candles,recent.ind,t,hl.price,currentPrice);
      if(!current)return {status:'UNAVAILABLE',ready:false,n:0,impulse,reason:'15m freshness inputs incomplete'};

      // Fast path: no historical model is needed unless price is actually extended above value.
      if(!(current.valueExtension>0)){
        return {status:'FRESH',ready:true,n:0,impulse,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
          medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:'price is not above 15m value zone'};
      }

      const cached=entryFreshnessCachedModel(symbol);
      if(!cached){
        return {status:'CALIBRATING',ready:false,n:0,impulse,needsModel:true,refreshNeeded:false,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
          medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:'historical model not cached yet; background calibration scheduled'};
      }

      const neighbors=selectIndependentFreshnessNeighbors(cached.samples,current,hl.time),n=neighbors.length;
      if(n<cfg.minSamples){
        return {status:'CALIBRATING',ready:false,n,impulse,needsModel:false,refreshNeeded:cached.refreshNeeded,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
          medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`independent cached analogs ${n}/${cfg.minSamples}`};
      }
      const medianMfeAtr=median(neighbors.map(x=>x.mfeAtr)),medianMaeAtr=median(neighbors.map(x=>x.maeAtr));
      const asymmetry=medianMaeAtr>0?medianMfeAtr/medianMaeAtr:(medianMfeAtr>0?Infinity:1);
      const status=Number.isFinite(asymmetry)&&asymmetry<1?'WAIT_EXTENDED':'FAVORABLE';
      return {status,ready:true,n,impulse,needsModel:false,refreshNeeded:cached.refreshNeeded,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
        medianMfeAtr,medianMaeAtr,asymmetry,reason:status==='WAIT_EXTENDED'?'historical remaining upside < adverse move':'historical remaining upside >= adverse move'};
    }catch(e){
      if(e.name==='AbortError')throw e;
      return {status:'UNAVAILABLE',ready:false,n:0,impulse:{status:'UNAVAILABLE',reason:e.message||String(e)},reason:e.message||String(e)};
    }
  }

  function entryFreshnessReason(x){
    if(!x)return 'Entry Freshness unavailable';
    const h=Number.isFinite(x.hlExtension)?x.hlExtension.toFixed(2):'—',v=Number.isFinite(x.valueExtension)?x.valueExtension.toFixed(2):'—';
    const mfe=Number.isFinite(x.medianMfeAtr)?x.medianMfeAtr.toFixed(2):'—',mae=Number.isFinite(x.medianMaeAtr)?x.medianMaeAtr.toFixed(2):'—';
    const a=x.asymmetry===Infinity?'∞':Number.isFinite(x.asymmetry)?x.asymmetry.toFixed(2):'—';
    if(x.status==='WAIT_EXTENDED')return `Entry Freshness WAIT_EXTENDED — 15m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`;
    if(x.status==='FAVORABLE')return `Entry Freshness FAVORABLE — 15m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`;
    if(x.status==='FRESH')return `Entry Freshness FRESH — price inside/at 15m value zone, HLext ${h} ATR`;
    if(x.status==='CALIBRATING')return `Entry Freshness CALIBRATING — ${x.reason}`;
    if(x.status==='NO_ACTIVE_HL')return 'Entry Freshness CALIBRATING — no active confirmed 15m HL';
    return `Entry Freshness UNAVAILABLE — ${x.reason||'unknown'}`;
  }

  function stopEntryFreshnessWarmup(){
    if(entryFreshnessWarmController){entryFreshnessWarmController.abort();entryFreshnessWarmController=null;}
  }

  async function fetchEntryFreshnessHistoryBackground(symbol,signal){
    const cfg=ENTRY_FRESHNESS_CONFIG,url=`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=${cfg.historyLimit}`;
    let lastErr=null;
    for(let attempt=0;attempt<2;attempt++){
      try{
        const res=await fetch(url,{signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      }catch(e){
        if(signal.aborted)throw e;lastErr=e;if(attempt===0)await sleep(500);
      }
    }
    throw lastErr||new Error('history request failed');
  }

  async function warmEntryFreshnessModels(symbols){
    const unique=[...new Set((symbols||[]).filter(Boolean))];if(!unique.length)return;
    const controller=new AbortController();entryFreshnessWarmController=controller;
    try{
      for(const symbol of unique){
        if(controller.signal.aborted)break;
        try{
          const raw=await fetchEntryFreshnessHistoryBackground(symbol,controller.signal);
          if(!Array.isArray(raw))continue;
          const now=Date.now(),candles=raw.map(klineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<now&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
          if(candles.length<ENTRY_FRESHNESS_CONFIG.recentMinBars)continue;
          const ind=buildIndicators(candles),samples=entryFreshnessHistoricalSamples(candles,ind);
          if(samples.length){entryFreshnessModelCache.set(symbol,{symbol,createdAt:Date.now(),samples});saveEntryFreshnessCache();log(`Entry Freshness model cached: ${symbol}, samples=${samples.length}.`);}
        }catch(e){if(controller.signal.aborted)break;log(`Entry Freshness background calibration failed ${symbol}: ${e.message||e}`);}
        if(ENTRY_FRESHNESS_CONFIG.warmPauseMs)await sleep(ENTRY_FRESHNESS_CONFIG.warmPauseMs);
      }
    }finally{
      if(entryFreshnessWarmController===controller)entryFreshnessWarmController=null;
    }
  }

  async function candidateDetails(row,refTime,serverTime,premiumMap,fundingInfoMap,thresholds){
    const symbol=row.symbol;
    const [oldPx,oiHist,taker,freshOi,freshPremium]=await Promise.all([
      priceNear4hAgo(symbol,refTime),
      fetchJson(`${BASE}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=55`,{retries:2}),
      fetchJson(`${BASE}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=5m&limit=3`,{retries:2}),
      fetchJson(`${BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,{retries:2}),
      fetchJson(`${BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,{retries:2})
    ]);
    const now=row.snapshot2,return4h=oldPx>0?(now/oldPx-1)*100:NaN,rs4h=Number.isFinite(return4h)&&state.context?return4h-state.context.btc:NaN;
    const liveOiQty=num(freshOi?.openInterest);
    const oi4=nearestOi4h(oiHist,refTime),deltaOi=oi4>0&&liveOiQty>0?(liveOiQty/oi4-1)*100:NaN;
    let buy=0,sell=0;
    if(Array.isArray(taker))for(const t of taker){buy+=num(t.buyVol)||0;sell+=num(t.sellVol)||0;}
    const takerRatio=sell>0?buy/sell:NaN;

    const p=freshPremium||premiumMap.get(symbol)||{};
    const fundingRate=num(p.lastFundingRate),mark=num(p.markPrice),index=num(p.indexPrice),nextFunding=Number(p.nextFundingTime)||NaN;
    const premiumPct=mark>0&&index>0?(mark/index-1)*100:NaN;
    const liveOiNotional=liveOiQty>0&&mark>0?liveOiQty*mark:NaN;
    const volumeOiRatio=liveOiNotional>0?row.quoteVolume/liveOiNotional:NaN;
    let intervalHours=NaN;
    if(state.fundingInfoLoaded){const fi=fundingInfoMap.get(symbol);intervalHours=fi?num(fi.fundingIntervalHours):8;}
    const fundingClock=Math.max(serverTime,Number(p.time)||0);
    const timeToFunding=Number.isFinite(nextFunding)?Math.max(0,nextFunding-fundingClock):NaN;
    const fundingProx=Number.isFinite(timeToFunding)&&intervalHours>0?timeToFunding/(intervalHours*3600000):NaN;
    const fundingExposure=Number.isFinite(timeToFunding)&&timeToFunding<=MAX_HOLD_MS;

    const [freshBook,freshDepth]=await Promise.all([
      fetchJson(`${BASE}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`,{retries:2}),
      fetchJson(`${BASE}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=50`,{retries:2})
    ]);
    const liveSpread=spreadPct(freshBook),mid=(num(freshBook?.bidPrice)+num(freshBook?.askPrice))/2,liveDepth=depthMetrics(freshDepth,mid).depth;

    const fundingExtreme=Number.isFinite(fundingRate)&&Number.isFinite(thresholds.fundingP90)&&fundingRate>0&&fundingRate>thresholds.fundingP90;
    const premiumExtreme=Number.isFinite(premiumPct)&&Number.isFinite(thresholds.premiumP90)&&premiumPct>0&&premiumPct>thresholds.premiumP90;
    const oiGrowing=Number.isFinite(deltaOi)&&deltaOi>0;
    const oiLarge=Number.isFinite(liveOiNotional)&&Number.isFinite(thresholds.oiNotionalP75)&&liveOiNotional>=thresholds.oiNotionalP75;
    const takerLongBias=Number.isFinite(takerRatio)&&takerRatio>1;
    const crowding=(fundingExtreme||premiumExtreme)&&oiLarge&&oiGrowing&&takerLongBias?'CAUTION':'NORMAL';

    const reasons=[];let result='SELECT';
    if(!Number.isFinite(return4h)||!Number.isFinite(rs4h)||!Number.isFinite(liveOiQty)||!Number.isFinite(liveOiNotional)||!Number.isFinite(volumeOiRatio)||!Number.isFinite(deltaOi)||!Number.isFinite(liveSpread)||!Number.isFinite(liveDepth)||!Number.isFinite(fundingRate)||!Number.isFinite(premiumPct)||!Number.isFinite(takerRatio)||!Number.isFinite(timeToFunding)||!Number.isFinite(fundingProx)){
      result='WAIT';reasons.push('essential detail missing');
    }
    if(result!=='WAIT'){
      if(Number.isFinite(thresholds.spreadP90)&&liveSpread>thresholds.spreadP90){result='WAIT';reasons.push('spread > profile p90');}
      if(Number.isFinite(thresholds.depthP10)&&liveDepth<thresholds.depthP10){result='WAIT';reasons.push('depth < profile p10');}
    }
    if(result==='SELECT'){
      const cautions=[];
      if(Number.isFinite(thresholds.spreadP75)&&liveSpread>thresholds.spreadP75)cautions.push('spread > p75');
      if(Number.isFinite(thresholds.depthP25)&&liveDepth<thresholds.depthP25)cautions.push('depth < p25');
      if(!(rs4h>0))cautions.push('RS4h ≤ 0');
      if(state.context?.result!=='UP')cautions.push(`market ${state.context?.result||'unknown'}`);
      if(!(takerRatio>=1))cautions.push('taker B/S < 1');
      if(crowding==='CAUTION')cautions.push('crowding caution');
      if(fundingExposure&&fundingExtreme)cautions.push('funding settlement + elevated positive funding');
      if(cautions.length){result='CAUTION';reasons.push(...cautions);}
      else reasons.push('all scanner checks aligned');
    }

    // Start Scan SELECT-only Entry Freshness Gate.
    // Existing WAIT/CAUTION/REJECT decisions are not touched and send no extra 15m request.
    let entryFreshness=null,entryImpulse=null;
    if(result==='SELECT'){
      entryFreshness=await analyzeEntryFreshness(symbol,now,serverTime);
      entryImpulse=entryFreshness?.impulse||null;
      const freshnessText=entryFreshnessReason(entryFreshness);
      if(entryFreshness?.status==='WAIT_EXTENDED'){
        result='WAIT';
        if(reasons.at(-1)==='all scanner checks aligned')reasons.pop();
        reasons.push(freshnessText);
      }else{
        reasons.push(freshnessText);
        // Elder Impulse is a censorship gate, not a BUY signal. It reuses the same completed 15m candles
        // already loaded by Entry Freshness, so it adds no Binance request to Start Scan.
        const impulseText=entryImpulseReason(entryImpulse);
        if(entryImpulse?.status==='BEARISH'){
          result='WAIT';
          const alignedIndex=reasons.indexOf('all scanner checks aligned');if(alignedIndex>=0)reasons.splice(alignedIndex,1);
          reasons.push(impulseText);
        }else reasons.push(impulseText);
      }
    }

    return {...row,oiQty:liveOiQty,oiNotional:liveOiNotional,volumeOiRatio,return4h,rs4h,deltaOi,takerRatio,fundingRate,intervalHours,nextFunding,timeToFunding,fundingProx,fundingExposure,premiumPct,liveSpread,liveDepth,crowding,entryFreshness,entryImpulse,result,reasons};
  }

  function momentumNotRun(){return {status:'OFF',ret1m:NaN,ret5m:NaN,ret15m:NaN,volumeRatio:NaN,reason:'Momentum Analysis disabled'};}

  function classifyMomentum(ret1m,ret5m,ret15m,volumeRatio){
    if(![ret1m,ret5m,ret15m,volumeRatio].every(Number.isFinite)) return 'UNAVAILABLE';
    if(ret1m>=3&&ret5m>=8&&ret15m>=15&&volumeRatio>=3) return 'EXPLOSIVE';
    if(ret1m>=2&&ret5m>=5&&ret15m>=8&&volumeRatio>=2) return 'STRONG';
    if(ret1m>=1&&ret5m>=2&&ret15m>0&&volumeRatio>=1.5) return 'WATCH';
    return 'NORMAL';
  }

  async function analyzeMomentumCandidate(row,referenceTime){
    // Exactly one additional Binance request per fast-pass candidate; all momentum metrics reuse it.
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(row.symbol)}&interval=1m&limit=30`,{retries:2,timeout:15000});
    if(!Array.isArray(raw)) return {status:'UNAVAILABLE',ret1m:NaN,ret5m:NaN,ret15m:NaN,volumeRatio:NaN,reason:'1m klines unavailable'};
    const closed=raw.map(klineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<referenceTime&&[c.close,c.volume].every(Number.isFinite));
    if(closed.length<25) return {status:'UNAVAILABLE',ret1m:NaN,ret5m:NaN,ret15m:NaN,volumeRatio:NaN,reason:`completed 1m candles ${closed.length}/25`};
    const now=num(row.snapshot2);
    const c1=closed.at(-1)?.close,c5=closed.at(-5)?.close,c15=closed.at(-15)?.close;
    const ret=(old)=>now>0&&old>0?(now/old-1)*100:NaN;
    const ret1m=ret(c1),ret5m=ret(c5),ret15m=ret(c15);
    const last5=closed.slice(-5).map(c=>c.volume),prev20=closed.slice(-25,-5).map(c=>c.volume);
    const prev20Avg=mean(prev20),last5Sum=last5.reduce((a,b)=>a+b,0);
    const volumeRatio=prev20Avg>0?last5Sum/(prev20Avg*5):NaN;
    const status=classifyMomentum(ret1m,ret5m,ret15m,volumeRatio);
    return {status,ret1m,ret5m,ret15m,volumeRatio,reason:status==='UNAVAILABLE'?'momentum inputs incomplete':'informational only; Result/V4.1 unchanged'};
  }

  function mean(values){
    const a=values.filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
  }

  function emaSeries(values,period){
    const out=new Array(values.length).fill(NaN);if(values.length<period)return out;
    let seed=0;for(let i=0;i<period;i++){if(!Number.isFinite(values[i]))return out;seed+=values[i];}
    let prev=seed/period;out[period-1]=prev;const k=2/(period+1);
    for(let i=period;i<values.length;i++){if(!Number.isFinite(values[i]))continue;prev=values[i]*k+prev*(1-k);out[i]=prev;}
    return out;
  }

  function atrSeries(candles,period=14){
    const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
    const out=new Array(candles.length).fill(NaN);if(tr.length<period)return out;
    let prev=mean(tr.slice(0,period));out[period-1]=prev;
    for(let i=period;i<tr.length;i++){prev=((prev*(period-1))+tr[i])/period;out[i]=prev;}
    return out;
  }

  function rsiSeries(closes,period=14){
    const out=new Array(closes.length).fill(NaN);if(closes.length<=period)return out;
    let gain=0,loss=0;
    for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)gain+=d;else loss-=d;}
    let avgGain=gain/period,avgLoss=loss/period;
    const calc=()=>avgLoss===0?(avgGain===0?50:100):avgGain===0?0:100-(100/(1+avgGain/avgLoss));out[period]=calc();
    for(let i=period+1;i<closes.length;i++){
      const d=closes[i]-closes[i-1],g=d>0?d:0,l=d<0?-d:0;
      avgGain=(avgGain*(period-1)+g)/period;avgLoss=(avgLoss*(period-1)+l)/period;out[i]=calc();
    }
    return out;
  }

  function macdSeries(closes){
    const fast=emaSeries(closes,12),slow=emaSeries(closes,26),dif=new Array(closes.length).fill(NaN),dea=new Array(closes.length).fill(NaN),hist=new Array(closes.length).fill(NaN);
    const start=25,difVals=[];for(let i=start;i<closes.length;i++){dif[i]=fast[i]-slow[i];difVals.push(dif[i]);}
    const signal=emaSeries(difVals,9);
    for(let j=0;j<difVals.length;j++){const i=start+j;if(Number.isFinite(signal[j])){dea[i]=signal[j];hist[i]=dif[i]-dea[i];}}
    return {dif,dea,hist};
  }

  function percentileRank(value,reference){
    const a=reference.filter(Number.isFinite);if(!Number.isFinite(value)||!a.length)return NaN;
    let less=0,equal=0;for(const x of a){if(x<value)less++;else if(x===value)equal++;}
    return 100*(less+0.5*equal)/a.length;
  }

  function klineToCandle(k){
    return {openTime:Number(k[0]),open:num(k[1]),high:num(k[2]),low:num(k[3]),close:num(k[4]),volume:num(k[5]),closeTime:Number(k[6]),quoteVolume:num(k[7])};
  }

  async function getClosedKlines(symbol,interval,serverTime){
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${V2_CONFIG.candleLimit+5}`,{retries:2,timeout:15000});
    if(!Array.isArray(raw))throw new Error(`${interval} klines unavailable`);
    const closed=raw.map(klineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<serverTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
    if(closed.length<V2_CONFIG.candleLimit)throw new Error(`${interval} closed candles ${closed.length}/${V2_CONFIG.candleLimit}`);
    return closed.slice(-V2_CONFIG.candleLimit);
  }

  function buildIndicators(candles){
    const closes=candles.map(c=>c.close),volumes=candles.map(c=>c.volume);
    return {closes,volumes,ema7:emaSeries(closes,7),ema25:emaSeries(closes,25),ema99:emaSeries(closes,99),rsi14:rsiSeries(closes,14),atr14:atrSeries(candles,14),macd:macdSeries(closes)};
  }

  function findSwings(candles,left=2,right=2){
    const highs=[],lows=[];
    for(let i=left;i<candles.length-right;i++){
      let sh=true,sl=true;
      for(let k=1;k<=left;k++){if(!(candles[i].high>candles[i-k].high))sh=false;if(!(candles[i].low<candles[i-k].low))sl=false;}
      for(let k=1;k<=right;k++){if(!(candles[i].high>candles[i+k].high))sh=false;if(!(candles[i].low<candles[i+k].low))sl=false;}
      if(sh)highs.push({index:i,price:candles[i].high});if(sl)lows.push({index:i,price:candles[i].low});
    }
    return {highs,lows};
  }

  function analyzeStep7(candles,ind){
    const t=candles.length-1,atr=ind.atr14[t],tol=V2_CONFIG.structureAtr*atr,{highs,lows}=findSwings(candles,V2_CONFIG.swingLeft,V2_CONFIG.swingRight);
    const lastH=highs.at(-1),prevH=highs.at(-2),lastL=lows.at(-1),prevL=lows.at(-2);
    const highStructure=!lastH||!prevH?'INSUFFICIENT':lastH.price>prevH.price+tol?'HH':lastH.price<prevH.price-tol?'LH':'NEUTRAL';
    const lowStructure=!lastL||!prevL?'INSUFFICIENT':lastL.price>prevL.price+tol?'HL':lastL.price<prevL.price-tol?'LL':'NEUTRAL';
    const ema25=ind.ema25[t],ema99=ind.ema99[t],delta=ema25-ind.ema25[t-V2_CONFIG.emaSlopeBars],slopeThreshold=V2_CONFIG.emaSlopeAtr*atr;
    const slope=delta>slopeThreshold?'UP':delta<-slopeThreshold?'DOWN':'FLAT';
    const up=highStructure==='HH'&&lowStructure==='HL'&&ema25>ema99&&slope==='UP';
    const down=highStructure==='LH'&&lowStructure==='LL'&&ema25<ema99&&slope==='DOWN';
    let regime='TRANSITION',direction='UNCLEAR',next='WAIT',reason='structure/EMA conditions mixed';
    if(up){regime='UPTREND';direction='LONG';next='PULLBACK';reason='HH + HL + EMA25>EMA99 + EMA25 slope UP';}
    else if(down){regime='DOWNTREND';direction='NO_LONG';next='BLOCK';reason='LH + LL + EMA25<EMA99 + EMA25 slope DOWN';}
    else{
      let above=0,below=0;for(let i=t-V2_CONFIG.rangeBars+1;i<=t;i++){if(candles[i].close>ind.ema25[i])above++;else if(candles[i].close<ind.ema25[i])below++;}
      const range=slope==='FLAT'&&Math.abs(ema25-ema99)<=V2_CONFIG.rangeEmaGapAtr*atr&&above>=V2_CONFIG.rangeMinEachSide&&below>=V2_CONFIG.rangeMinEachSide;
      if(range){regime='RANGE';direction='NEUTRAL';next='BREAKOUT';reason=`EMA flat/gap OK; last ${V2_CONFIG.rangeBars}: above=${above}, below=${below}`;}
    }
    if(regime==='UPTREND'&&lastL&&candles[t].close<lastL.price-tol){regime='TRANSITION';direction='UNCLEAR';next='WAIT';reason='UPTREND structure break below last confirmed Swing Low';}
    if(regime==='DOWNTREND'&&lastH&&candles[t].close>lastH.price+tol){regime='TRANSITION';direction='UNCLEAR';next='WAIT';reason='DOWNTREND structure break above last confirmed Swing High';}
    return {regime,direction,next,reason,highStructure,lowStructure,lastHigh:lastH?.price??NaN,previousHigh:prevH?.price??NaN,lastLow:lastL?.price??NaN,previousLow:prevL?.price??NaN,ema25,ema99,slope,atr};
  }

    function analyzeStep8(candles,ind,step7,eventTime,eventPrice){
    const t=candles.length-1;
    if(step7.regime==='DOWNTREND')return {status:'BLOCKED',setup:'NONE',reason:'Step 7 DOWNTREND — LONG blocked'};
    if(step7.regime==='TRANSITION')return {status:'WAIT',setup:'NONE',reason:'Step 7 TRANSITION'};
    if(!Number.isFinite(eventTime))return {status:'WAIT',setup:'NONE',reason:'Fast Event timestamp unavailable'};
    const firstPost=candles.findIndex(c=>Number.isFinite(c.openTime)&&c.openTime>eventTime);
    if(firstPost<0)return {status:'WAIT',setup:'NONE',reason:'waiting for first full 15m candle after Fast Event'};

    if(step7.regime==='UPTREND'){
      let setupIndex=-1,setupZoneLow=NaN,setupZoneHigh=NaN,setupEma25=NaN;
      for(let i=firstPost;i<=t;i++){
        const a=ind.atr14[i],e7=ind.ema7[i],e25=ind.ema25[i];if(![a,e7,e25].every(Number.isFinite))continue;
        const valueLow=Math.min(e7,e25)-V2_CONFIG.valueAtr*a,valueHigh=Math.max(e7,e25)+V2_CONFIG.valueAtr*a;
        let wasAbove=Number.isFinite(eventPrice)&&eventPrice>valueHigh;
        for(let j=Math.max(0,i-V2_CONFIG.pullbackLookback);j<i&&!wasAbove;j++){
          const aj=ind.atr14[j],e7j=ind.ema7[j],e25j=ind.ema25[j];if(![aj,e7j,e25j].every(Number.isFinite))continue;
          const vh=Math.max(e7j,e25j)+V2_CONFIG.valueAtr*aj;if(candles[j].close>vh)wasAbove=true;
        }
        const touches=candles[i].low<=valueHigh&&candles[i].high>=valueLow;
        const deepLimit=e25-V2_CONFIG.deepPullbackAtr*a,deep=candles[i].close<deepLimit;
        if(wasAbove&&touches&&!deep){setupIndex=i;setupZoneLow=valueLow;setupZoneHigh=valueHigh;setupEma25=e25;}
      }
      if(setupIndex<0){
        const a=ind.atr14[t],e25=ind.ema25[t],deepLimit=Number.isFinite(a)&&Number.isFinite(e25)?e25-V2_CONFIG.deepPullbackAtr*a:NaN;
        const deep=Number.isFinite(deepLimit)&&candles[t].close<deepLimit;
        return {status:'WAIT',setup:deep?'INVALID_PULLBACK':'NONE',reason:deep?'post-event 15m close below deep-pullback limit':'waiting for post-event 15m pullback into EMA7–EMA25 value area'};
      }
      for(let j=setupIndex+1;j<=t;j++){
        const a=ind.atr14[j],e25=ind.ema25[j];if(![a,e25].every(Number.isFinite))continue;
        if(candles[j].close<e25-V2_CONFIG.deepPullbackAtr*a)return {status:'WAIT',setup:'INVALID_PULLBACK',reason:'post-event pullback invalidated below EMA25 - 0.50 ATR15',entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr15:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex};
      }
      return {status:'PASS',setup:'PULLBACK_VALUE',reason:'post-event 15m pullback returned from above into EMA7–EMA25 value area',entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr15:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex};
    }

    // RANGE: breakout must itself occur on a full 15m candle that starts after the Fast Event.
    let breakout=null;
    for(let b=t;b>=Math.max(firstPost,V2_CONFIG.breakoutLookback);b--){
      const a=ind.atr14[b];if(!Number.isFinite(a)||!(candles[b].openTime>eventTime))continue;
      const rangeHigh=Math.max(...candles.slice(b-V2_CONFIG.breakoutLookback,b).map(c=>c.high));
      const volAvg=mean(candles.slice(b-V2_CONFIG.volumeSma,b).map(c=>c.volume));
      if(candles[b].close>rangeHigh+V2_CONFIG.breakoutAtr*a&&candles[b].volume>volAvg){breakout={index:b,rangeHigh,atrAtBreakout:a,volumeAvg:volAvg};break;}
    }
    if(!breakout)return {status:'WAIT',setup:'NONE',reason:'waiting for valid post-event 15m breakout with volume confirmation'};
    const retestLow=breakout.rangeHigh-V2_CONFIG.retestAtr*breakout.atrAtBreakout,retestHigh=breakout.rangeHigh+V2_CONFIG.retestAtr*breakout.atrAtBreakout;
    let retestIndex=-1,failed=false;
    const end=Math.min(t,breakout.index+V2_CONFIG.retestMaxBars);
    for(let j=breakout.index+1;j<=end;j++){
      if(candles[j].close<retestLow){failed=true;break;}
      const touch=candles[j].low<=retestHigh&&candles[j].high>=retestLow;
      if(touch&&candles[j].close>=breakout.rangeHigh){retestIndex=j;break;}
    }
    if(failed)return {status:'WAIT',setup:'FAILED_BREAKOUT',reason:'post-event retest closed below failure boundary',rangeHigh:breakout.rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr15:ind.atr14[t]};
    if(retestIndex<0){
      const age=t-breakout.index;
      return {status:'WAIT',setup:age<V2_CONFIG.retestMaxBars?'WAIT_RETEST':'FAILED_BREAKOUT',reason:age<V2_CONFIG.retestMaxBars?`post-event breakout valid; retest waiting (${age}/${V2_CONFIG.retestMaxBars})`:'post-event retest did not occur within 4×15m',rangeHigh:breakout.rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr15:ind.atr14[t]};
    }
    for(let j=retestIndex+1;j<=t;j++)if(candles[j].close<retestLow)return {status:'WAIT',setup:'FAILED_BREAKOUT',reason:'post-event breakout invalidated after retest',rangeHigh:breakout.rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr15:ind.atr14[t],setupTime:candles[retestIndex].closeTime,retestIndex};
    return {status:'PASS',setup:'BREAKOUT_RETEST',reason:'post-event 15m breakout + volume + retest held above range high',rangeHigh:breakout.rangeHigh,retestIndex,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr15:ind.atr14[t],setupTime:candles[retestIndex].closeTime,setupIndex:retestIndex};
  }

    function step9ChecksAt(candles,ind,i){
    const volSma=mean(candles.slice(i-V2_CONFIG.volumeSma,i).map(c=>c.volume));
    const volOk=candles[i].volume>volSma&&candles[i].volume>candles[i-1].volume;
    const emaOk=ind.ema7[i]>ind.ema25[i]&&ind.ema7[i]>ind.ema7[i-1]&&ind.ema25[i]>ind.ema25[i-1];
    const rsi=ind.rsi14[i],rsiOk=rsi>V2_CONFIG.rsiMin&&rsi<V2_CONFIG.rsiMax&&rsi>ind.rsi14[i-1];
    const dif=ind.macd.dif[i],dea=ind.macd.dea[i],hist=ind.macd.hist[i],histPrev=ind.macd.hist[i-1],macdOk=dif>dea&&hist>histPrev;
    const atr=ind.atr14[i],atrRef=ind.atr14.slice(Math.max(0,i-V2_CONFIG.atrPercentileLookback),i),atrPct=percentileRank(atr,atrRef),atrOk=atrPct>=V2_CONFIG.atrPercentileMin&&atrPct<=V2_CONFIG.atrPercentileMax;
    return {volume:{pass:volOk,current:candles[i].volume,sma20:volSma,previous:candles[i-1].volume},ema:{pass:emaOk,ema7:ind.ema7[i],ema25:ind.ema25[i]},rsi:{pass:rsiOk,value:rsi,rising:rsi>ind.rsi14[i-1]},macd:{pass:macdOk,dif,dea,hist,histRising:hist>histPrev},atr:{pass:atrOk,value:atr,percentile:atrPct}};
  }

  function analyzeStep9(candles,ind,step8){
    if(step8.status!=='PASS')return {status:'NOT_RUN',score:'0/5',reason:'Step 8 is not PASS',checks:{}};
    const t=candles.length-1,setupTime=Number(step8.setupTime);
    if(!Number.isFinite(setupTime))return {status:'WAIT',score:'0/5',reason:'Step 8 setup timestamp unavailable',checks:{}};
    const firstFresh=candles.findIndex(c=>Number.isFinite(c.openTime)&&c.openTime>setupTime);
    if(firstFresh<0)return {status:'WAIT',score:'0/5',reason:'waiting for first full 5m candle after post-event setup',checks:{}};
    let firstConfirmationIndex=-1;
    for(let i=Math.max(firstFresh,V2_CONFIG.volumeSma,26);i<=t;i++){
      const checks=step9ChecksAt(candles,ind,i);
      if(Object.values(checks).every(x=>x.pass)){firstConfirmationIndex=i;break;}
    }
    const checks=step9ChecksAt(candles,ind,t),passed=Object.values(checks).filter(x=>x.pass).length;
    const failed=Object.entries(checks).filter(([,x])=>!x.pass).map(([k])=>k.toUpperCase());
    const currentConfirmed=passed===5;
    const status=currentConfirmed&&firstConfirmationIndex>=0?'CONFIRMED':'WAIT';
    let reason;
    if(firstConfirmationIndex<0)reason=`waiting for first post-setup 5/5 confirmation; current ${passed}/5${failed.length?` failed: ${failed.join(', ')}`:''}`;
    else if(!currentConfirmed)reason=`post-setup confirmation existed, but current 5m is ${passed}/5; failed: ${failed.join(', ')}`;
    else reason='fresh post-setup VOL + EMA + RSI + MACD + ATR confirmed; current 5m still 5/5';
    return {status,score:`${passed}/5`,reason,checks,firstConfirmationIndex,firstConfirmationTime:firstConfirmationIndex>=0?candles[firstConfirmationIndex].closeTime:NaN};
  }

    function analyzeStep10(candles5,ind5,candles15,ind15,step8,step9){
    if(step8.status!=='PASS')return {status:'NOT_RUN',reason:'Step 8 is not PASS'};
    const t15=candles15.length-1,t=candles5.length-1,atr15=ind15.atr14[t15],current15Close=candles15[t15].close;
    if(step8.setup==='PULLBACK_VALUE'){
      const invalidLine=ind15.ema25[t15]-V2_CONFIG.deepPullbackAtr*atr15;
      if(current15Close<invalidLine)return {status:'INVALIDATED',reason:'pullback invalidated below EMA25 - 0.50 ATR15'};
    }else if(step8.setup==='BREAKOUT_RETEST'){
      if(current15Close<step8.entryZoneLow)return {status:'INVALIDATED',reason:'breakout/retest invalidated below retest zone'};
    }
    if(step9.status!=='CONFIRMED')return {status:'WAIT',reason:'Step 9 current confirmation is not 5/5'};
    const confirmationTime=Number(step9.firstConfirmationTime);
    if(!Number.isFinite(confirmationTime))return {status:'WAIT',reason:'fresh post-setup confirmation timestamp unavailable'};
    let trigger=null;
    for(let j=t;j>=Math.max(1,t-V2_CONFIG.triggerValidBars);j--){
      if(!(candles5[j].openTime>confirmationTime))continue;
      const atr5=ind5.atr14[j];
      if(candles5[j].close>candles5[j].open&&candles5[j].close>candles5[j-1].high+V2_CONFIG.triggerAtr5*atr5){trigger={index:j,ageBars:t-j,close:candles5[j].close,atr5};break;}
    }
    if(!trigger)return {status:'WAIT',reason:'no fresh LONG trigger after post-setup confirmation in last 10 minutes'};
    const currentClose=candles5[t].close,lower=step8.entryZoneLow,upper=step8.entryZoneHigh+V2_CONFIG.noChaseAtr15*atr15;
    if(currentClose>upper)return {status:'SKIP_CHASE',reason:`price above no-chase limit by ${fmt((currentClose-step8.entryZoneHigh)/atr15,2)} ATR15`,triggerAgeMin:trigger.ageBars*5};
    if(currentClose<lower)return {status:'WAIT',reason:'price below entry-zone lower boundary',triggerAgeMin:trigger.ageBars*5};
    return {status:'READY',reason:`fresh post-event sequence complete; valid trigger age ${trigger.ageBars*5}m; price inside allowed entry range`,triggerAgeMin:trigger.ageBars*5,triggerClose:trigger.close};
  }

  function v2NotRun(reason='V1 result is not SELECT'){
    return {final:'NOT_RUN',reason,step7:{regime:'—'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—'},step10:{status:'NOT_RUN'}};
  }

  async function analyzeChartCandidate(row,serverTime){
    if(row.result!=='SELECT')return {...row,chartAnalysis:v2NotRun()};
    try{
      const [c1h,c15,c5]=await Promise.all([getClosedKlines(row.symbol,'1h',serverTime),getClosedKlines(row.symbol,'15m',serverTime),getClosedKlines(row.symbol,'5m',serverTime)]);
      const i1h=buildIndicators(c1h),i15=buildIndicators(c15),i5=buildIndicators(c5);
      const step7=analyzeStep7(c1h,i1h);
      let step8,step9,step10,priceLocation=null,final='WAIT';
      if(step7.regime==='DOWNTREND'){
        step8={status:'BLOCKED',setup:'NONE',reason:'LONG blocked by Step 7'};step9={status:'NOT_RUN',score:'—',reason:'blocked'};step10={status:'NOT_RUN',reason:'blocked'};final='BLOCKED';
      }else if(step7.regime==='TRANSITION'){
        step8={status:'WAIT',setup:'NONE',reason:'Step 7 TRANSITION'};step9={status:'NOT_RUN',score:'—',reason:'Step 8 not PASS'};step10={status:'NOT_RUN',reason:'Step 8 not PASS'};final='WAIT';
      }else{
        step8=analyzeStep8(c15,i15,step7,row.fastEventTime,row.fastEventPrice);step9=analyzeStep9(c5,i5,step8);step10=analyzeStep10(c5,i5,c15,i15,step8,step9);
        if(step10.status==='READY'){
          priceLocation=computePriceLocation(c1h,c15,c5,i15,step7,step8,{horizonMin:240});
          final=priceLocation.model.ready&&priceLocation.verdict==='UNFAVORABLE'?'WAIT_LOCATION':'READY';
        }else final=step10.status==='SKIP_CHASE'?'SKIP_CHASE':'WAIT';
      }
      const reason=`7:${step7.reason} | 8:${step8.reason} | 9:${step9.reason} | 10:${step10.reason}${priceLocation?` | Location:${priceLocation.verdict}; Max=${priceFmt(priceLocation.maxExpected)} Min=${priceFmt(priceLocation.minExpected)} Asym=${fmt(priceLocation.asymmetry,2)} StatN=${priceLocation.model.n}`:''}`;
      const chartAnalysis={final,reason,step7,step8,step9,step10,priceLocation,asOf:serverTime};
      if(step10.status==='READY'&&priceLocation)registerPriceObservation(row,chartAnalysis,priceLocation);
      return {...row,chartAnalysis};
    }catch(e){
      if(e.name==='AbortError')throw e;
      log(`V4.2 ${row.symbol}: ${e.message}`);
      return {...row,chartAnalysis:{final:'WAIT',reason:`V4.2 data/analysis error: ${e.message}`,step7:{regime:'ERROR'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—'},step10:{status:'NOT_RUN'},priceLocation:null}};
    }
  }

  function v2Pill(status){
    const cls={READY:'ready',WAIT:'wait',WAIT_LOCATION:'wait_location',SKIP_CHASE:'skip',BLOCKED:'blocked',INVALIDATED:'invalidated',NOT_RUN:'notrun'}[status]||'wait';
    return `<span class="pill ${cls}">${htmlEscape(status||'—')}</span>`;
  }

  function formatDuration(ms){
    if(!Number.isFinite(ms))return '—';const total=Math.max(0,Math.round(ms/60000)),h=Math.floor(total/60),m=total%60;return `${h}h ${m}m`;
  }
  function resultPill(r){return `<span class="pill ${r.toLowerCase()}">${r}</span>`;}
  function momentumPill(m){const status=m?.status||'OFF';return `<span class="pill ${status.toLowerCase()}">${htmlEscape(status)}</span>`;}

  function sortCandidates(rows){
    const pr={SELECT:4,CAUTION:3,WAIT:2,REJECT:1};
    return rows.slice().sort((a,b)=>{
      let d=(pr[b.result]||0)-(pr[a.result]||0);if(d)return d;
      const ar=Math.round((Number.isFinite(a.rs4h)?a.rs4h:-999)*10),br=Math.round((Number.isFinite(b.rs4h)?b.rs4h:-999)*10);if(br!==ar)return br-ar;
      const aa=Math.round(a.activityScore||0),ba=Math.round(b.activityScore||0);if(ba!==aa)return ba-aa;
      const al=Math.round(a.liquidityScore||0),bl=Math.round(b.liquidityScore||0);if(bl!==al)return bl-al;
      const af=Math.round((a.fastChange||0)*10),bf=Math.round((b.fastChange||0)*10);if(bf!==af)return bf-af;
      return (b.onboardDate||0)-(a.onboardDate||0); // newer only after similar rounded conditions
    });
  }

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
  function metaYsHtml(v){if(v===true)return '<span class="ysMark true" title="YS True: supply/fiyat eşleşti ve Binance Spot USDT başlangıcı 2025+">✓</span>';if(v===false)return '<span class="ysMark false" title="YS False">✕</span>';return '<span class="ysMark unknown" title="YS için gerekli Total Supply / Spot fiyat / Binance başlangıç tarihi doğrulanamadı">—</span>';}

  async function metaFetchWithTimeout(url,ms=15000){
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),ms);const onAbort=()=>ctrl.abort();
    state.controller?.signal.addEventListener('abort',onAbort,{once:true});
    try{return await fetch(url,{method:'GET',mode:'cors',cache:'no-store',credentials:'omit',headers:{Accept:'application/json'},signal:ctrl.signal});}
    finally{clearTimeout(timer);state.controller?.signal.removeEventListener('abort',onAbort);}
  }
  async function metaSpotJson(path){
    let last;for(const base of META_SPOT_API_BASES){try{const r=await metaFetchWithTimeout(`${base}${path}`);if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Binance Spot REST unavailable');
  }
  async function metaProducts(){
    let last;for(const url of META_PRODUCT_ENDPOINTS){try{const r=await metaFetchWithTimeout(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(!Array.isArray(j?.data))throw new Error('product format');return j.data;}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Binance product data unavailable');
  }
  async function metaWeb3Search(keyword){
    let last;for(const endpoint of META_WEB3_SEARCH_ENDPOINTS){try{const qs=new URLSearchParams({keyword,chainIds:META_CHAIN_IDS,orderBy:'volume24h'});const r=await metaFetchWithTimeout(`${endpoint}?${qs}`,12000);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j?.code&&String(j.code)!=='000000')throw new Error(`Web3 ${j.code}`);return Array.isArray(j?.data)?j.data:[];}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    if(last)console.debug('V5 Web3 search unavailable',last);return [];
  }
  async function metaWeb3Dynamic(chainId,contractAddress){
    let last;for(const endpoint of META_WEB3_DYNAMIC_ENDPOINTS){try{const qs=new URLSearchParams({chainId:String(chainId),contractAddress:String(contractAddress)});const r=await metaFetchWithTimeout(`${endpoint}?${qs}`,12000);if(!r.ok)throw new Error(`HTTP ${r.status}`);const j=await r.json();if(j?.code&&String(j.code)!=='000000')throw new Error(`Web3 ${j.code}`);return j?.data||null;}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;last=e;}}
    throw last||new Error('Binance Web3 dynamic unavailable');
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
    if(settled[2].status==='fulfilled')products=settled[2].value;else log(`V5 metadata Binance supply products unavailable: ${settled[2].reason?.message||settled[2].reason}`);
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

    next=0;async function historyWorker(){while(true){const i=next++;if(i>=rows.length)return;const r=rows[i],m=r.gridMeta;if(!m?.spotSymbol)continue;try{const [firstDaily,monthly]=await Promise.all([metaSpotKlines(m.spotSymbol,'1d',0,1),metaSpotKlines(m.spotSymbol,'1M',0,1000)]);if(firstDaily.length){const t=metaToNumber(firstDaily[0]?.[0]);if(Number.isFinite(t))m.listingTime=t;}if(monthly.length){let hi=-Infinity,lo=Infinity;for(const k of monthly){const h=metaToNumber(k?.[2]),l=metaToNumber(k?.[3]);if(h>0&&h>hi)hi=h;if(l>0&&l<lo)lo=l;}if(Number.isFinite(hi))m.allTimeHigh=hi;if(Number.isFinite(lo))m.allTimeLow=lo;}}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;console.debug('V5 Binance history unavailable',r.symbol,e);}}}
    await Promise.all(Array.from({length:Math.min(META_HISTORY_CONCURRENCY,rows.length)},historyWorker));
    for(const r of rows){const m=r.gridMeta;m.ys=metaYsResult(m.totalSupply,m.spotPrice,m.listingTime);}
  }

  function scanRow(symbol){
    return [...document.querySelectorAll('#candidateBody tr[data-symbol]')].find(tr=>tr.dataset.symbol===symbol)||null;
  }

  function renderCandidates(rows,windowSec){
    const body=$('candidateBody');
    if(!rows.length){body.innerHTML='<tr><td colspan="21" class="empty">Aktif Fast Event adayı yok.</td></tr>';return;}
    body.innerHTML=rows.map((r,i)=>{
      const g=r.gridMeta||{};
      const age=metaFormatAge(g.listingTime),ageDate=metaFormatDate(g.listingTime);
      return `<tr data-symbol="${htmlEscape(r.symbol)}">
        <td>${i+1}</td>
        <td class="symbol"><button class="symbolBtn" data-action="decision-support" data-symbol="${htmlEscape(r.symbol)}" type="button" title="PriceLevel ve RiskLevel hesaplamak için tıkla">${htmlEscape(r.symbol)}</button></td>
        <td data-role="ys">${metaYsHtml(g.ys)}</td>
        <td>${resultPill(r.result)}</td>
        <td class="decisionCell na" data-role="price-level" title="Coin adına tıklanınca hesaplanır; selection'ı etkilemez.">—</td>
        <td class="decisionCell na" data-role="risk-level" title="Coin adına tıklanınca hesaplanır; selection'ı etkilemez.">—</td>
        <td><input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" placeholder="Entry Price" inputmode="decimal"></td>
        <td><input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" placeholder="Stop Price" inputmode="decimal"></td>
        <td class="num" data-role="current-price" title="USDⓈ-M Futures scan fiyatı">${htmlEscape(metaFormatPrice(r.snapshot2))}</td>
        <td><button class="followBtn" data-action="follow" data-symbol="${htmlEscape(r.symbol)}" type="button">Follow</button></td>
        <td class="monitorCell"><span class="monitorDot off" title="OFF" aria-label="OFF"></span></td>
        <td class="monitorReason"><span class="reasonText">Not following</span><div class="monitorTime"></div></td>
        <td class="liveChangeCell" data-role="live-change"></td>
        <td class="liveResultCell" data-role="live-result"></td>
        <td class="num" data-role="meta-volume" title="Binance Spot USDT quoteVolume">${htmlEscape(metaFormatVolume(g.volume24h))}</td>
        <td class="num" data-role="meta-total-supply">${htmlEscape(metaFormatSupply(g.totalSupply))}</td>
        <td class="num" data-role="meta-circ-supply">${htmlEscape(metaFormatSupply(g.circulatingSupply))}</td>
        <td class="metaAge" data-role="meta-age" title="${Number.isFinite(g.listingTime)?`İlk Binance Spot USDT günlük mum: ${htmlEscape(ageDate)}`:''}">${htmlEscape(age)}${Number.isFinite(g.listingTime)?`<small>${htmlEscape(ageDate)}</small>`:''}</td>
        <td class="num" data-role="meta-max">${htmlEscape(metaFormatPrice(g.allTimeHigh))}</td>
        <td class="num" data-role="meta-min">${htmlEscape(metaFormatPrice(g.allTimeLow))}</td>
        <td data-role="meta-hour">${htmlEscape(g.requestTime||'—')}</td>
      </tr>`;
    }).join('');
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
      const ageCell=tr.querySelector('[data-role="meta-age"]');if(ageCell){ageCell.title=Number.isFinite(g.listingTime)?`İlk Binance Spot USDT günlük mum: ${ageDate}`:'';ageCell.innerHTML=`${htmlEscape(age)}${Number.isFinite(g.listingTime)?`<small>${htmlEscape(ageDate)}</small>`:''}`;}
      const max=tr.querySelector('[data-role="meta-max"]');if(max)max.textContent=metaFormatPrice(g.allTimeHigh);
      const min=tr.querySelector('[data-role="meta-min"]');if(min)min.textContent=metaFormatPrice(g.allTimeLow);
      const hour=tr.querySelector('[data-role="meta-hour"]');if(hour)hour.textContent=g.requestTime||'—';
    }
  }
  function renderQueue(rows){
    const q=rows.filter(r=>r.result==='SELECT'),el=$('manualQueue');
    if(!q.length){el.innerHTML='<span class="empty">SELECT yok; otomatik 7–10 analizi çalışmadı.</span>';return;}
    el.innerHTML=q.map((r,i)=>{const c=r.chartAnalysis||v2NotRun('analysis pending');return `<span class="queueItem" title="${htmlEscape(c.reason||'')}"><b>${i+1}. ${htmlEscape(r.symbol)}</b> · 7 ${htmlEscape(c.step7?.regime||'—')} · 8 ${htmlEscape(c.step8?.setup||'—')} · 9 ${htmlEscape(c.step9?.score||'—')} · 10 ${htmlEscape(c.step10?.status||'—')} · Loc ${htmlEscape(c.priceLocation?.verdict||'—')} · Max ${priceFmt(c.priceLocation?.maxExpected)} · Min ${priceFmt(c.priceLocation?.minExpected)} · <b>${htmlEscape(c.final||'—')}</b></span>`;}).join('');
  }

    function updateSummary(rows,universeCount,fastCount,eventCount){
    $('sumUniverse').textContent=String(universeCount);$('sumFast').textContent=String(fastCount);$('sumEventWatch').textContent=String(eventCount);
    for(const [id,status] of [['sumSelect','SELECT'],['sumCaution','CAUTION'],['sumWait','WAIT'],['sumReject','REJECT']]) $(''+id).textContent=String(rows.filter(r=>r.result===status).length);
    const analyzed=rows.filter(r=>r.result==='SELECT'&&r.chartAnalysis&&r.chartAnalysis.final!=='NOT_RUN');
    $('sumV2Analyzed').textContent=String(analyzed.length);$('sumV2Ready').textContent=String(analyzed.filter(r=>r.chartAnalysis.final==='READY').length);
    $('sumV2Wait').textContent=String(analyzed.filter(r=>['WAIT','BLOCKED','WAIT_LOCATION'].includes(r.chartAnalysis.final)).length);$('sumV2Skip').textContent=String(analyzed.filter(r=>r.chartAnalysis.final==='SKIP_CHASE').length);
  }

  async function startScan(){
    if(state.running)return;
    const windowSec=num($('windowSec').value),minIncrease=num($('minIncrease').value),maxIncrease=num($('maxIncrease').value),riskBands=['all'],momentumEnabled=false;
    if(!(windowSec>=1&&windowSec<=300)){setStatus('X seconds 1–300 arasında olmalı.','bad');return;}
    if(!(minIncrease>0&&minIncrease<=100)){setStatus('Minimum increase 0–100% arasında pozitif olmalı.','bad');return;}
    if(!(maxIncrease>0&&maxIncrease<=100)){setStatus('Maximum increase 0–100% arasında pozitif olmalı.','bad');return;}
    if(maxIncrease<minIncrease){setStatus('Maximum Increase, Minimum Increase değerinden küçük olamaz.','bad');return;}
    if(!riskBands.length){setStatus('En az bir Risk Profile Activity Rank checkbox seçilmelidir.','bad');return;}

    document.dispatchEvent(new CustomEvent('cryptooffer:scan-start',{detail:{reason:'New Start Scan'}}));
    stopEntryFreshnessWarmup();
    state.running=true;state.controller=new AbortController();state.startedAt=Date.now();state.settings={windowSec,minIncrease,maxIncrease,riskBands,momentumAnalysis:momentumEnabled};resetUI();setButtons(true);
    try{
      let activity;
      const cacheAge=activityCacheAgeMs();
      if(state.activityCache&&cacheAge<ACTIVITY_CACHE_MS){
        const cachedActivity=state.activityCache.activity;
        setStatus(`Activity Rank cache doğrulanıyor (${formatCacheAge(cacheAge)} eski)…`,'info');
        progress(38,'Cache HIT + live USDT-M validation');
        const liveExchange=await getExchangeInfo();
        if(state.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
        const liveEligible=activeSymbols(liveExchange);
        const liveEligibleSet=new Set(liveEligible.map(s=>s.symbol));
        activity=cachedActivity.filter(r=>liveEligibleSet.has(r.symbol));
        if(!activity.length)throw new Error('Cached Activity Rank ile güncel Binance USDT-M crypto universe kesişimi boş.');
        state.activity=activity;
        $('sumActive').textContent=String(liveEligible.length);
        $('sumRanked').textContent=String(activity.length);
        const ageSec=Math.floor(cacheAge/1000);
        updateActivityCacheStatus();
        setStatus(`Activity Rank cache kullanılıyor (${formatCacheAge(cacheAge)} eski); ${activity.length}/${cachedActivity.length} symbol güncel Binance USDT-M crypto universe içinde doğrulandı.`,'info');
        progress(40,'Activity Rank cache HIT — live validated');
        log(`Activity Rank cache HIT: age=${ageSec}s / TTL=${ACTIVITY_CACHE_MS/60000}m; rank requests skipped. Live exchangeInfo validation kept ${activity.length}/${cachedActivity.length} cached symbols; current eligible crypto USDT-M contracts=${liveEligible.length}.`);
      }else{
        setStatus('Binance public REST verileri alınıyor…','info');progress(2,'Exchange + bulk market data');
        const [exchange,tickers,books]=await Promise.all([getExchangeInfo(),getBulk24(),getBulkBook()]);
        if(state.controller.signal.aborted)throw new DOMException('Aborted','AbortError');

        progress(5,'Building Binance Market Activity Rank');
        activity=await buildActivityRank(exchange,tickers,books);state.activity=activity;
        if(!activity.length)throw new Error('Activity Rank oluşturulamadı. Binance endpoint cevaplarını kontrol et.');
        const activeCount=activeSymbols(exchange).length;
        savePersistentActivityCache({createdAt:Date.now(),activeCount,activity});
        log(`Activity Rank cache refreshed and persisted: ${activity.length} ranked crypto contracts; TTL=${ACTIVITY_CACHE_MS/60000}m.`);
      }

      const universe=activity.filter(r=>rankMatchesRiskBands(r.activityRank,riskBands));
      $('sumUniverse').textContent=String(universe.length);
      $('sum301').textContent=String(activity.filter(r=>r.activityRank>=300).length);
      const rank300Count=activity.filter(r=>r.activityRank>=300).length;
      log(`Risk Profile bands ${riskBandsLabel(riskBands)}: universe=${universe.length}; Rank 300+ available=${rank300Count}`);
      if(!universe.length)throw new Error('Seçili Risk Profile checkbox kombinasyonu için universe boş.');

      progress(42,'Snapshot #1');
      const snap1=await getBulkPrices();const snap1Map=new Map(snap1.map(x=>[x.symbol,{price:num(x.price),time:Number(x.time)||Date.now()}]));const snapshot1Wall=performance.now();
      setStatus(`Snapshot #1 alındı. ${windowSec} saniye bekleniyor…`,'info');
      const snapshotDeadline=performance.now()+windowSec*1000;
      while(true){
        if(state.controller.signal.aborted)throw new DOMException('Aborted','AbortError');
        const remaining=snapshotDeadline-performance.now();
        if(remaining<=0) break;
        const elapsed=windowSec*1000-remaining;
        progress(42+8*clamp(elapsed/(windowSec*1000),0,1),`Snapshot #2 in ${(remaining/1000).toFixed(1)}s`);
        await sleep(Math.min(250,remaining));
      }
      progress(50,'Snapshot #2');
      const snap2=await getBulkPrices();const snap2Map=new Map(snap2.map(x=>[x.symbol,{price:num(x.price),time:Number(x.time)||Date.now()}]));state.snapshotElapsedMs=performance.now()-snapshot1Wall;
      const refTime=Math.max(0,...snap2.map(x=>Number(x.time)||0))||Date.now();

      const profileRows=universe.map(r=>{
        const a=snap1Map.get(r.symbol),b=snap2Map.get(r.symbol);const fast=a?.price>0&&b?.price>0?(b.price/a.price-1)*100:NaN;
        return {...r,snapshot1:a?.price,snapshot2:b?.price,currentFastChange:fast,fastChange:fast,fastEventTime:Number(b?.time)||refTime,fastEventPrice:b?.price};
      });
      const fastPass=profileRows.filter(r=>Number.isFinite(r.currentFastChange)&&r.currentFastChange>=minIncrease&&r.currentFastChange<=maxIncrease);
      $('sumFast').textContent=String(fastPass.length);log(`Fast Event detector: ${fastPass.length}/${profileRows.length} new events passed ${minIncrease}% ≤ Δ${windowSec}s ≤ ${maxIncrease}% (actual snapshot gap ${state.snapshotElapsedMs.toFixed(0)} ms)`);

      const registration=registerFastEvents(fastPass,refTime);
      const profileMap=new Map(profileRows.map(r=>[r.symbol,r]));
      const analysisCandidates=[];
      for(const e of state.eventWatch.values()){
        const current=profileMap.get(e.symbol);if(!current)continue;
        const age=refTime-Number(e.eventTime);if(!(age>=0&&age<=FAST_EVENT_TTL_MS))continue;
        const sameConfig=Number(e.windowSec)===windowSec&&Number(e.minIncrease)===minIncrease&&Number(e.maxIncrease)===maxIncrease;
        if(!sameConfig)continue;
        analysisCandidates.push({...current,fastChange:Number(e.fastChange),fastEventTime:Number(e.eventTime),fastEventPrice:Number(e.eventPrice),fastEventWindowSec:Number(e.windowSec),eventAgeMs:age});
      }
      $('sumEventWatch').textContent=String(analysisCandidates.length);
      log(`Fast Event watch: ${registration.added} new, ${registration.refreshed} refreshed by a new spike, ${analysisCandidates.length} active events matching current Fast Scan settings and Risk Profile; TTL=${FAST_EVENT_TTL_MS/3600000}h.`);

      if(!analysisCandidates.length){
        clearMarketContext('Aktif Fast Event yok; General Crypto Context bu scan için hesaplanmadı.');
        log('General Crypto Context skipped: no active Fast Event candidates; panel cleared and no context kline requests sent.');
        state.results=[];renderCandidates([],windowSec);renderQueue([]);updateSummary([],universe.length,fastPass.length,0);progress(100,'Completed — no active events');
        setStatus(`Scan tamamlandı. Yeni Fast Event: ${fastPass.length}; aktif event watchlist boş.`,'warn');return;
      }

      // Required SELECT inputs only. Funding/Premium is started while General Crypto Context is being calculated.
      // Optional Momentum, Price Learning completion, V4.2 7–10 and V5 metadata are deliberately kept off the SELECT critical path.
      progress(54,'General Crypto Context + Funding/Premium');
      const fundingPromise=loadPremiumFunding();
      state.context=await computeMarketContext(activity,snap2Map,refTime);

      progress(60,'Funding / Premium context');
      const [{premiumMap,fundingInfoMap},detailServerTime]=await Promise.all([fundingPromise,getServerTime()]);
      const profilePremium=universe.map(r=>premiumMap.get(r.symbol)).filter(Boolean);
      const positiveFunding=profilePremium.map(p=>num(p.lastFundingRate)).filter(x=>Number.isFinite(x)&&x>0);
      const positivePremium=profilePremium.map(p=>{const m=num(p.markPrice),ix=num(p.indexPrice);return m>0&&ix>0?(m/ix-1)*100:NaN}).filter(x=>Number.isFinite(x)&&x>0);
      const spreadVals=universe.map(r=>r.spreadPct),depthVals=universe.map(r=>r.depth);
      const thresholds={
        spreadP75:percentile(spreadVals,.75),spreadP90:percentile(spreadVals,.90),depthP25:percentile(depthVals,.25),depthP10:percentile(depthVals,.10),
        fundingP90:percentile(positiveFunding,.90),premiumP90:percentile(positivePremium,.90),oiNotionalP75:percentile(universe.map(r=>r.oiNotional),.75)
      };
      state.thresholds=thresholds;

      progress(64,'Detailed CryptoFlow 5–6 + Entry Freshness');
      const detailed=await mapLimit(analysisCandidates,DETAIL_CONCURRENCY,async r=>candidateDetails(r,refTime,detailServerTime,premiumMap,fundingInfoMap,thresholds),{
        pauseMs:0,onProgress:(d,n)=>progress(64+26*d/n,`Candidate details ${d}/${n}`)
      });
      let rows=detailed.filter(Boolean).map(r=>({...r,momentumAnalysis:momentumNotRun()}));

      progress(92,'Final operational recheck');
      const [exchange2,finalServerTime]=await Promise.all([getExchangeInfo(),getServerTime()]);
      const statusMap=new Map((exchange2.symbols||[]).map(x=>[x.symbol,x]));
      rows=rows.map(r=>{
        const s=statusMap.get(r.symbol);
        if(!s||s.status!=='TRADING'||s.contractType!=='PERPETUAL'||s.underlyingType!=='COIN'||s.quoteAsset!=='USDT'||s.marginAsset!=='USDT') return {...r,result:'REJECT',reasons:['final operational status failed']};
        const delivery=Number(s.deliveryDate);
        if(Number.isFinite(delivery)&&delivery>0&&delivery<=finalServerTime+MAX_HOLD_MS) return {...r,result:'REJECT',reasons:['delivery/delisting within max 4h holding window']};
        return r;
      });

      // Coin selection is final here. Render it immediately; nothing below is allowed to change Result.
      rows=rows.filter(Boolean).map(r=>({...r,decisionTime:finalServerTime}));
      rows=sortCandidates(rows);state.results=rows;
      renderCandidates(rows,windowSec);renderQueue(rows);updateSummary(rows,universe.length,fastPass.length,analysisCandidates.length);updateLearningStatus();
      const selectSec=((Date.now()-state.startedAt)/1000).toFixed(1);
      progress(93,'SELECT ready — background analyses running');
      setStatus(`Coin selection hazır: ${rows.length} detaylı aday • SELECT ${rows.filter(r=>r.result==='SELECT').length} • ${selectSec}s. 7–10, Momentum ve V5 metadata paralel tamamlanıyor.`,'good');
      log(`SELECT ready. requests=${state.requestCount}, errors=${state.errors.length}, duration=${selectSec}s`);

      // Non-selection work starts only after Result is fixed. Rules are unchanged; only scheduling is parallelized.
      const priceLearningPromise=completePriceLearning(refTime);
      const momentumPromise=momentumEnabled
        ? mapLimit(analysisCandidates,DETAIL_CONCURRENCY,async r=>({symbol:r.symbol,momentum:await analyzeMomentumCandidate(r,refTime)}),{pauseMs:0})
        : Promise.resolve([]);
      const chartPromise=(async()=>{
        await priceLearningPromise; // preserves the original rule: due learning is completed before V4.2 Price Location.
        return await mapLimit(rows,2,async r=>analyzeChartCandidate(r,finalServerTime),{pauseMs:0,onProgress:(d,n)=>progress(93+5*d/n,`V4.2 chart + location ${d}/${n}`)});
      })();
      const metadataPromise=enrichV5GridMetadata(rows);

      const [momentumRows,chartRows]=await Promise.all([momentumPromise,chartPromise,metadataPromise]).then(([m,c])=>[m,c]);
      const momentumMap=new Map((momentumRows||[]).filter(Boolean).map(x=>[x.symbol,x.momentum]));
      for(const r of rows)r.momentumAnalysis=momentumEnabled?(momentumMap.get(r.symbol)||{status:'UNAVAILABLE',ret1m:NaN,ret5m:NaN,ret15m:NaN,volumeRatio:NaN,reason:'momentum result missing'}):momentumNotRun();
      if(momentumEnabled)log(`Momentum Analysis ON: ${momentumMap.size}/${analysisCandidates.length} active-event candidates analyzed; one 1m-kline request per candidate.`);else log('Momentum Analysis OFF: no momentum kline requests sent.');

      const chartMap=new Map((chartRows||[]).filter(Boolean).map(r=>[r.symbol,r.chartAnalysis]));
      for(const r of rows)if(chartMap.has(r.symbol))r.chartAnalysis=chartMap.get(r.symbol);
      updateCandidateMomentumUI(rows);updateV5MetadataUI(rows);renderQueue(rows);updateSummary(rows,universe.length,fastPass.length,analysisCandidates.length);updateLearningStatus();
      progress(100,'Completed');
      const sec=((Date.now()-state.startedAt)/1000).toFixed(1),ready=rows.filter(r=>r.chartAnalysis?.final==='READY').length,waitLoc=rows.filter(r=>r.chartAnalysis?.final==='WAIT_LOCATION').length;setStatus(`Scan tamamlandı: ${rows.length} detaylı aday • V4.2 READY ${ready} • WAIT_LOCATION ${waitLoc} • ${state.requestCount} API request • ${sec}s. SELECT coinlerde 7–10 otomatik analiz edildi.`,'good');
      log(`Completed. requests=${state.requestCount}, errors=${state.errors.length}, duration=${sec}s`);
      const freshnessWarmSymbols=rows.filter(r=>r.entryFreshness?.needsModel||r.entryFreshness?.refreshNeeded).map(r=>r.symbol);
      if(freshnessWarmSymbols.length)setTimeout(()=>warmEntryFreshnessModels(freshnessWarmSymbols),0);
    }catch(e){
      if(e.name==='AbortError'){setStatus('Scan kullanıcı tarafından iptal edildi.','warn');progress(0,'Cancelled');log('Cancelled.');}
      else{setStatus(`Scan failed: ${e.message}`,'bad');progress(0,'Failed');log(`FATAL: ${e.stack||e.message}`);}
    }finally{
      state.running=false;setButtons(false);
    }
  }

  function exportCSV(){
    if(!state.results.length)return;
    const cols=['rank','symbol','decisionTime','fastEventTime','result','v42Result','locationVerdict','maxExpectedPrice','minExpectedPrice','locationAsymmetry','statSampleN','structuralInvalidation','step7Regime','step8Setup','step9Confirmation','step10Entry','activityRank','activityScore','fastChange','momentum','momentum1m','momentum5m','momentum15m','momentumVolumeRatio','return4h','rs4h','quoteVolume','oiQty','oiNotional','volumeOiRatio','deltaOi','takerRatio','fundingRate','intervalHours','timeToFunding','fundingProx','fundingExposure','premiumPct','liveSpread','liveDepth','crowding','reasons','v2Reason'];
    const lines=[cols.join(',')];
    state.results.forEach((r,i)=>{
      const c=r.chartAnalysis||v2NotRun(),m=r.momentumAnalysis||momentumNotRun(),l=c.priceLocation||{};const vals=[i+1,r.symbol,Number.isFinite(Number(r.decisionTime))?new Date(Number(r.decisionTime)).toISOString():'',Number.isFinite(Number(r.fastEventTime))?new Date(Number(r.fastEventTime)).toISOString():'',r.result,c.final,l.verdict,l.maxExpected,l.minExpected,l.asymmetry,l.model?.n,l.structuralInvalidation,c.step7?.regime,c.step8?.setup,c.step9?.status==='CONFIRMED'?c.step9.score+' CONFIRMED':c.step9?.score,c.step10?.status,r.activityRank,r.activityScore,r.fastChange,m.status,m.ret1m,m.ret5m,m.ret15m,m.volumeRatio,r.return4h,r.rs4h,r.quoteVolume,r.oiQty,r.oiNotional,r.volumeOiRatio,r.deltaOi,r.takerRatio,r.fundingRate,r.intervalHours,r.timeToFunding,r.fundingProx,r.fundingExposure,r.premiumPct,r.liveSpread,r.liveDepth,r.crowding,r.reasons.join('; '),c.reason];
      lines.push(vals.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','));
    });
    downloadBlob(lines.join('\n'),'cryptooffer_v11_candidates.csv','text/csv;charset=utf-8');
  }
  function exportJSON(){
    if(!state.results.length)return;
    const data={version:'CryptoOffer V11 — Coin Selection + Position Monitor',createdAt:new Date().toISOString(),settings:state.settings,snapshotElapsedMs:state.snapshotElapsedMs,context:state.context,thresholds:state.thresholds,priceLearning:{completed:state.priceLearning.filter(x=>x.completed).length,pending:state.priceLearning.filter(x=>!x.completed).length},results:state.results,requestCount:state.requestCount,errors:state.errors};
    downloadBlob(JSON.stringify(data,null,2),'cryptooffer_v11_scan.json','application/json');
  }
  function downloadBlob(text,name,type){
    const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('startBtn').addEventListener('click',startScan);
  $('cancelBtn').addEventListener('click',()=>{if(state.controller)state.controller.abort();});
  $('refreshRankBtn').addEventListener('click',()=>{
    if(state.running)return;
    clearActivityRankCache();
    setStatus('Activity Rank cache temizlendi. Sonraki Start Scan güncel Activity Rank hesaplayacak.','info');
    log('Activity Rank cache manually cleared; next scan will rebuild it from live Binance data.');
  });
  $('clearEventsBtn').addEventListener('click',()=>{
    if(state.running)return;
    clearFastEventWatch();
    setStatus('Fast Event watchlist temizlendi. Yeni sequence yalnız bundan sonraki Fast Event’lerden başlayacak.','info');
    log('Fast Event watch manually cleared.');
  });
  $('csvBtn').addEventListener('click',exportCSV);
  $('jsonBtn').addEventListener('click',exportJSON);

  loadPersistentActivityCache();
  loadFastEventWatch();
  loadPriceLearning();
  loadEntryFreshnessCache();


  window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V13.4',modules:{}};
  window.CryptoFlowScanner.version='V13.4';
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.startScan={config:V2_CONFIG,priceConfig:PRICE_CONFIG,state};
})();
