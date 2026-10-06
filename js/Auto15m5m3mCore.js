(() => {
'use strict';

// HEADLESS RUNTIME PORTS. No DOM/UI dependency is permitted in this file.
let runtime={
  settingsProvider:()=>({}), persistence:null, universeProvider:null,
  followGateway:null, btcImpactGateway:null, eventSink:()=>{},
  streamService:null, watchService:null
};
let marketDataStore=null;
const storage={
  getItem:key=>runtime.persistence?.getItem?.(key)??null,
  setItem:(key,value)=>runtime.persistence?.setItem?.(key,value),
  removeItem:key=>runtime.persistence?.removeItem?.(key)
};
function emit(type,payload={}){try{runtime.eventSink?.({type,source:SCAN_SOURCE,time:Date.now(),...payload});}catch(_){}}
// Headless presentation ports: these emit state changes only; they never touch DOM/UI.
function log(message){emit('log',{message:String(message??'')});}
function setStatus(text,className='info'){emit('status',{text:String(text??''),className});}
function progress(value,text=''){emit('progress',{value:Number(value)||0,text:String(text??'')});}
function resetUI(){emit('reset');}
function setButtons(running){emit('controls',{running:!!running});}
function configureRuntime(ports={}){
  runtime={...runtime,...ports};
  if(!runtime.streamService)throw new Error('Auto15m5m3mCore requires streamService');
  if(!runtime.watchService)throw new Error('Auto15m5m3mCore requires watchService');
  if(typeof runtime.universeProvider!=='function')throw new Error('Auto15m5m3mCore requires universeProvider');
  marketDataStore=runtime.streamService.store;
  state.watchStates=runtime.watchService.states;
  hydratePersistentState();
  return api;
}

  // VARIANT: primary trend 15m -> setup 5m -> confirmation 3m. No timeframe above 15m is used by this variant.

  // ================================================================
  // AUTO 15m/5m/3m ENTRY ENGINE
  // Owns: 15m/5m/3m Start Scan, candidate selection, chart/location analysis,
  // metadata enrichment, scan caches, summaries and scan exports.
  // Does NOT call Risk Management or Follow functions.
  // ================================================================

  const BASE='https://fapi.binance.com';
  const SCAN_SOURCE='Auto 15m-5m-3m Scan';
  const SCAN_BUTTON_ID='auto15m5m3mScanBtn';
  const SCAN_TIMEFRAMES=Object.freeze({trend:'15m',setup:'5m',confirm:'3m'});
  const AUTO153_BUILD='2026-10-06-selectfix-diag-2';
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
  const ACTIVITY_CACHE_VERSION=2;
  const FAST_EVENT_TTL_MS=MAX_HOLD_MS;
  const FAST_EVENT_CACHE_KEY='CryptoOfferV4.1.FastEventWatch.v1';
  const FAST_EVENT_CACHE_VERSION=1;
  const PRICE_LEARNING_KEY='CryptoOfferV4.2.PriceLearning.153.v1';
  const PRICE_LEARNING_VERSION=1;
  const PRICE_CONFIG=Object.freeze({minStatSamples:30,levelMergeAtr:0.20,completionPerScan:12,completionConcurrency:3,breakoutVolumeSma:20});

  // Start Scan / SELECT-only Entry Freshness Gate.
  // Fast path uses only recent completed 15m candles. Historical analogs are built
  // asynchronously after the scan and cached per symbol so Start Scan is not blocked.
  const ENTRY_FRESHNESS_CONFIG=Object.freeze({
    recentLimit:150,recentMinBars:35,historyLimit:1500,forwardBars:16,minSamples:30,neighbors:30,
    cacheKey:'CryptoOfferV13.EntryFreshnessModel.153.v2',cacheVersion:1,cacheRefreshMs:6*60*60*1000,
    cacheHardMaxAgeMs:7*24*60*60*1000,cacheMaxSymbols:16,warmPauseMs:250
  });

  const entryFreshnessModelCache=new Map();
  const entryFreshnessRecentCache=new Map();

  const V2_CONFIG=Object.freeze({
    candleLimit:300,swingLeft:2,swingRight:2,structureAtr:0.10,emaSlopeBars:3,emaSlopeAtr:0.05,
    rangeEmaGapAtr:0.50,rangeBars:10,rangeMinEachSide:3,valueAtr:0.15,pullbackLookback:5,deepPullbackAtr:0.50,
    breakoutLookback:20,breakoutAtr:0.10,retestAtr:0.20,retestMaxBars:4,volumeSma:20,rsiPeriod:14,rsiMin:50,rsiMax:70,
    atrPeriod:14,atrPercentileLookback:100,atrPercentileMin:30,atrPercentileMax:80,triggerAtr5:0.05,noChaseAtrPrimary:0.50,triggerValidBars:2
  });

  // 15m/5m/3m hierarchy:
  // 15m = primary structure/trend, 5m = setup, 3m = confirmation + live timing.
  // Closed candles own EMA/MACD/RSI/ATR/setup logic; current candles are timing gates only.
  const LIVE_CANDLE_CONFIG=Object.freeze({neutralAtr:0.10,strongDownAtrPrimary:0.25});

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



  // =====================================================================
  // AUTO 15m/5m/3m RUNTIME CONFIGURATION
  // The 15m/5m/3m selection functions below are copied unchanged from the
  // supplied StartScan15m5m3m.js. This layer changes only data transport,
  // scheduling, Watch hand-off and Follow slot orchestration.
  // =====================================================================
  const AUTO_DEFAULTS=Object.freeze({
    scanIntervalSeconds:5,
    maxOpenPositions:2,
    positionUsdtAmount:100,
    leverage:5,
    allowDuplicateSymbolPosition:false,
    pauseScanWhenPositionLimitReached:true,
    resumeScanAfterPositionExit:true,
    autoFollowOnSelect:true,
    entryConfirmationCount:2,
    historyWorkers:4,
    historyWorkerPauseMs:1800,
    historyBootstrapLimit:330,
    minReadyToStart:24,
    watchSampleMs:1000,
    watchMinRisePct:0
  });

  function getAutoSettings(){
    const supplied=runtime.settingsProvider?.()||{};const x=supplied&&typeof supplied==='object'?supplied:{};
    const int=(v,d,min,max)=>{const n=Math.trunc(Number(v));return Number.isFinite(n)?Math.max(min,Math.min(max,n)):d;};
    const pos=(v,d)=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:d;};
    return Object.freeze({
      scanIntervalSeconds:int(x.scanIntervalSeconds,AUTO_DEFAULTS.scanIntervalSeconds,1,60),
      maxOpenPositions:int(x.maxOpenPositions,AUTO_DEFAULTS.maxOpenPositions,1,20),
      positionUsdtAmount:pos(x.positionUsdtAmount,AUTO_DEFAULTS.positionUsdtAmount),
      leverage:int(x.leverage,AUTO_DEFAULTS.leverage,1,125),
      allowDuplicateSymbolPosition:x.allowDuplicateSymbolPosition===true,
      pauseScanWhenPositionLimitReached:x.pauseScanWhenPositionLimitReached!==false,
      resumeScanAfterPositionExit:x.resumeScanAfterPositionExit!==false,
      autoFollowOnSelect:x.autoFollowOnSelect!==false,
      entryConfirmationCount:int(x.entryConfirmationCount,AUTO_DEFAULTS.entryConfirmationCount,1,12),
      historyWorkers:int(x.auto15m5m3mHistoryWorkers,AUTO_DEFAULTS.historyWorkers,1,8),
      historyWorkerPauseMs:int(x.auto15m5m3mHistoryWorkerPauseMs,AUTO_DEFAULTS.historyWorkerPauseMs,500,10000),
      historyBootstrapLimit:int(x.auto15m5m3mHistoryBootstrapLimit,AUTO_DEFAULTS.historyBootstrapLimit,305,500),
      minReadyToStart:int(x.auto15m5m3mMinReadyToStart,AUTO_DEFAULTS.minReadyToStart,1,100),
      watchSampleMs:int(x.auto15m5m3mWatchSampleMs,AUTO_DEFAULTS.watchSampleMs,250,10000),
      watchMinRisePct:Math.max(0,Number(x.auto15m5m3mWatchMinRisePct)||AUTO_DEFAULTS.watchMinRisePct)
    });
  }

  // Market transport is supplied by BinanceStreamService.
  function startHybridStreams(universe){runtime.streamService.start(universe,['3m','5m','15m']);}
  function stopHybridStreams(){runtime.streamService.stop();}

  const state={running:false,cycleRunning:false,controller:null,startedAt:0,requestCount:0,errors:[],results:[],activity:[],context:null,settings:null,thresholds:null,snapshotElapsedMs:null,fundingInfoLoaded:false,activityCache:null,eventWatch:new Map(),priceLearning:[],gateDiagnostics:null,scanSource:SCAN_SOURCE,scanTimeframes:SCAN_TIMEFRAMES,session:null,loopTimer:null,watchTimer:null,historyPromise:null,historyStop:false,historyReady:new Set(),historyFailed:new Set(),historyAttempts:0,watchRows:new Map(),watchStates:new Map(),greenQueue:[],startingFollow:new Set(),autoFollowSymbols:new Set(),premiumCache:null,serverOffsetMs:0,cycleNo:0};
  let baseDropDiagnostics=new Map();
  function emptyGateDiagnostics(){return {fastEvents:0,liquidityDrop:0,oiDrop:0,dataDrop:0,operationalDrop:0,entryAnalyzed:0,entryError:0,oneHourBlock:0,oneHourTransition:0,freshnessElder:0,setup15m:0,confirm5m:0,triggerZone:0,rr:0,softCaution:0,select:0,confirm5mDetail:{timing:0,score0:0,score1:0,score2:0,score3:0,weakClosedVolume:0,failEma:0,failRsi:0,failMacd:0,failAtr:0,threeOfFourEma:0,threeOfFourMacd:0}};}
  function resetBaseDropDiagnostics(){baseDropDiagnostics=new Map();state.gateDiagnostics=emptyGateDiagnostics();renderGateDiagnostics();}
  function recordBaseDrop(reason,count=1){baseDropDiagnostics.set(reason,(baseDropDiagnostics.get(reason)||0)+count);}
  function renderGateDiagnostics(){emit('gate-diagnostics',{diagnostics:state.gateDiagnostics||emptyGateDiagnostics()});}
  function classifyEntryPrimaryGate(row){
    const c=row?.chartAnalysis;
    if(!c||c.final==='NOT_RUN')return 'entryError';
    if(c.step7?.regime==='ERROR')return 'entryError';
    if(c.step7?.regime==='DOWNTREND')return 'oneHourBlock';
    const fresh=c.entryFreshness,imp=c.entryImpulse;
    if(!fresh||fresh.status==='UNAVAILABLE'||fresh.status==='CALIBRATING'||!imp||imp.status==='UNAVAILABLE'||imp.status==='BEARISH')return 'freshnessElder';
    const s8=c.step8||{};
    if(s8.status!=='PASS')return 'setup15m';
    const s9=c.step9||{};
    if(s9.status!=='CONFIRMED')return 'confirm5m';
    const s10=c.step10||{};
    if(s10.status!=='READY')return 'triggerZone';
    if(c.liveDirection15m?.blocksSelect||c.liveDirection5m?.blocksSelect)return 'triggerZone';
    if(c.liveDirection3m?.blocksSelect)return 'triggerZone';
    const loc=c.priceLocation;
    const structuralKnown=!!loc&&(loc.structuralAsymmetry===Infinity||Number.isFinite(loc.structuralAsymmetry));
    if(!structuralKnown||(Number.isFinite(loc.structuralAsymmetry)&&loc.structuralAsymmetry<1))return 'rr';
    if(row.result==='SELECT')return 'select';
    if(row.result==='CAUTION')return 'softCaution';
    return 'entryError';
  }
  function finalizeGateDiagnostics(analyzedRows){
    const g=state.gateDiagnostics||emptyGateDiagnostics();
    const validRows=(analyzedRows||[]).filter(Boolean);
    g.entryAnalyzed=validRows.length;
    // 15m TRANSITION is informational, not an exclusive blocking gate.
    // A TRANSITION row continues through 5m setup -> 3m confirmation -> trigger -> R/R.
    g.oneHourTransition=validRows.filter(row=>row?.chartAnalysis?.step7?.regime==='TRANSITION').length;
    for(const k of ['entryError','oneHourBlock','freshnessElder','setup15m','confirm5m','triggerZone','rr','softCaution','select'])g[k]=0;
    g.confirm5mDetail={timing:0,score0:0,score1:0,score2:0,score3:0,weakClosedVolume:0,failEma:0,failRsi:0,failMacd:0,failAtr:0,threeOfFourEma:0,threeOfFourMacd:0};
    for(const row of validRows){
      const k=classifyEntryPrimaryGate(row);g[k]=(g[k]||0)+1;
      if(k==='confirm5m'){
        const s9=row?.chartAnalysis?.step9||{},d=g.confirm5mDetail,checks=s9.checks||{};
        const reason=String(s9.reason||'').toLowerCase();
        const timing=!Object.keys(checks).length&&(reason.includes('not ready')||reason.includes('started before')||reason.includes('timestamp unavailable')||reason.includes('not pass'));
        if(timing||s9.timingPending)d.timing++;
        const passed=Number(s9.passed);
        if(!(timing||s9.timingPending)&&Number.isFinite(passed)){
          if(passed<=0)d.score0++;else if(passed===1)d.score1++;else if(passed===2)d.score2++;else if(passed===3)d.score3++;
        }
        if(checks.volume&&checks.volume.pass===false)d.weakClosedVolume++;
                if(checks.rsi&&checks.rsi.pass===false)d.failRsi++;
        if(checks.macd&&checks.macd.pass===false)d.failMacd++;
        if(checks.atr&&checks.atr.pass===false)d.failAtr++;
        if(passed>=2&&checks.macd?.pass===false)d.threeOfFourMacd++;
      }
    }
    state.gateDiagnostics=g;renderGateDiagnostics();
    const d=g.confirm5mDetail;
    log(`Gate Diagnostics: Fast ${g.fastEvents} | Liquidity ${g.liquidityDrop} | OI ${g.oiDrop} | Data ${g.dataDrop} | Operational ${g.operationalDrop} | Entry ${g.entryAnalyzed} | EntryError ${g.entryError} | 5mTrendBlock ${g.oneHourBlock} | 5mTransition(info) ${g.oneHourTransition} | Fresh/Elder ${g.freshnessElder} | 3mSetup ${g.setup15m} | 1mConfirm ${g.confirm5m} [timing ${d.timing}; 1/3 ${d.score1}; 2/3 ${d.score2}; closedVOLweak ${d.weakClosedVolume}; fail R/M/A ${d.failRsi}/${d.failMacd}/${d.failAtr}] | Trigger/Zone ${g.triggerZone} | R/R ${g.rr} | Soft ${g.softCaution} | SELECT ${g.select}`);
  }

  function activityCacheAgeMs(){
    return state.activityCache?Date.now()-state.activityCache.createdAt:Infinity;
  }


  function updateActivityCacheStatus(){emit('activity-cache',{cache:state.activityCache,ageMs:activityCacheAgeMs()});}

  function validActivityCacheObject(x){
    return !!x&&x.version===ACTIVITY_CACHE_VERSION&&Number.isFinite(Number(x.createdAt))&&Number.isFinite(Number(x.activeCount))&&Array.isArray(x.activity)&&x.activity.length>0&&x.activity.every(r=>r&&typeof r.symbol==='string'&&Number.isFinite(Number(r.activityRank))&&Number.isFinite(Number(r.activityScore)));
  }

  function loadPersistentActivityCache(){
    try{
      const raw=storage.getItem(ACTIVITY_CACHE_KEY);
      if(!raw){updateActivityCacheStatus();return;}
      const parsed=JSON.parse(raw);
      if(!validActivityCacheObject(parsed)){storage.removeItem(ACTIVITY_CACHE_KEY);updateActivityCacheStatus();return;}
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
      storage.setItem(ACTIVITY_CACHE_KEY,JSON.stringify({version:ACTIVITY_CACHE_VERSION,...cache}));
    }catch(e){
      log(`Persistent Activity Rank cache save failed; memory cache remains active: ${e.message||e}`);
    }
    updateActivityCacheStatus();
  }


  function priceFmt(x){
    if(!Number.isFinite(x))return '—';
    const a=Math.abs(x),d=a>=1000?2:a>=1?4:a>=0.01?6:8;
    return x.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
  }

  function updateLearningStatus(){emit('learning-status',{completed:state.priceLearning.filter(x=>x.completed).length,pending:state.priceLearning.filter(x=>!x.completed).length});}

  function validLearningObservation(x){
    return !!x&&typeof x.id==='string'&&typeof x.symbol==='string'&&Number.isFinite(Number(x.entryTime))&&Number.isFinite(Number(x.entryPrice))&&Number(x.entryPrice)>0;
  }

  function loadPriceLearning(){
    state.priceLearning=[];
    try{
      const raw=storage.getItem(PRICE_LEARNING_KEY);if(!raw){updateLearningStatus();return;}
      const parsed=JSON.parse(raw);
      if(parsed?.version!==PRICE_LEARNING_VERSION||!Array.isArray(parsed.observations)){storage.removeItem(PRICE_LEARNING_KEY);updateLearningStatus();return;}
      state.priceLearning=parsed.observations.filter(validLearningObservation);
    }catch(e){log(`Price learning load failed: ${e.message||e}`);state.priceLearning=[];}
    updateLearningStatus();
  }

  function savePriceLearning(){
    try{storage.setItem(PRICE_LEARNING_KEY,JSON.stringify({version:PRICE_LEARNING_VERSION,observations:state.priceLearning}));}
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

  function registerPriceObservation(row,chart,location){
    if(chart?.step10?.status!=='READY'||!Number.isFinite(location?.currentPrice)||!Number.isFinite(location?.currentTime))return;
    const id=`${row.symbol}|${Number(row.fastEventTime)||0}|${Number(chart.step8?.setupTime)||0}|${Number(chart.step9?.firstConfirmationTime)||0}`;
    if(state.priceLearning.some(x=>x.id===id))return;
    state.priceLearning.push({id,symbol:row.symbol,createdAt:Date.now(),entryTime:location.currentTime,entryPrice:location.currentPrice,regime:chart.step7?.regime||'—',setup:chart.step8?.setup||'—',atr5:location.atr5,fastChange:row.fastChange,activityRank:row.activityRank,context:state.context?.result||'—',completed:false});
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


  function buildStructuralLevels(c5,c3,i5,step7,step8,currentPrice){
    const t5=c5.length-1,atr5=i5.atr14[t5];
    const h5=findSwings(c5,V2_CONFIG.swingLeft,V2_CONFIG.swingRight),h3=findSwings(c3,V2_CONFIG.swingLeft,V2_CONFIG.swingRight);
    const resist=[],support=[];
    for(const x of h5.highs.slice(-8))resist.push({price:x.price,weight:3,source:'15m Swing High'});
    for(const x of h5.lows.slice(-8))support.push({price:x.price,weight:3,source:'15m Swing Low'});
    for(const x of h3.highs.slice(-10))resist.push({price:x.price,weight:2,source:'5m Swing High'});
    for(const x of h3.lows.slice(-10))support.push({price:x.price,weight:2,source:'5m Swing Low'});
    if(step7?.regime==='RANGE'&&c5.length>=V2_CONFIG.breakoutLookback){
      const recent=c5.slice(-V2_CONFIG.breakoutLookback),rh=Math.max(...recent.map(c=>c.high)),rl=Math.min(...recent.map(c=>c.low));
      resist.push({price:rh,weight:2.5,source:'15m Range Upper'});support.push({price:rl,weight:2.5,source:'15m Range Lower'});
    }
    if(step8?.setup==='PULLBACK_VALUE'){
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'5m Value Low'});
      if(Number.isFinite(step8.ema25))support.push({price:step8.ema25,weight:2,source:'5m EMA25'});
    }
    if(step8?.setup==='BREAKOUT_RETEST'){
      if(Number.isFinite(step8.rangeHigh))support.push({price:step8.rangeHigh,weight:3,source:'5m Breakout/Retest Level'});
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'5m Retest Low'});
    }
    const rc=clusterPriceLevels(resist,atr5).filter(x=>x.price>currentPrice).sort((a,b)=>a.price-b.price);
    const sc=clusterPriceLevels(support,atr5).filter(x=>x.price<currentPrice).sort((a,b)=>b.price-a.price);
    return {atr5,resistance:rc[0]||null,support:sc[0]||null,resistanceClusters:rc,supportClusters:sc};
  }

  function structuralInvalidation(step8,i3,c3){
    const t=c3.length-1,atr=i3.atr14[t];
    if(step8?.setup==='PULLBACK_VALUE'&&Number.isFinite(indSafe(i3.ema25,t))&&Number.isFinite(atr))return i3.ema25[t]-V2_CONFIG.deepPullbackAtr*atr;
    if(step8?.setup==='BREAKOUT_RETEST'&&Number.isFinite(step8.entryZoneLow))return step8.entryZoneLow;
    return NaN;
  }
  function indSafe(a,i){return Array.isArray(a)?a[i]:NaN;}

function computePriceLocation(c5,c3,c1,i5,i3,step7,step8,{horizonMin=240,currentPriceOverride=NaN,currentTimeOverride=NaN}={}){
  const t1=c1.length-1,currentPrice=Number.isFinite(currentPriceOverride)&&currentPriceOverride>0?currentPriceOverride:c1[t1].close,currentTime=Number.isFinite(currentTimeOverride)?currentTimeOverride:c1[t1].closeTime;
  const structural=buildStructuralLevels(c5,c3,i5,step7,step8,currentPrice),atr5=structural.atr5;
  const model=getStatModel(step7?.regime,step8?.setup,horizonMin);
  const r=structural.resistance?.price??NaN,s=structural.support?.price??NaN;
  const invalidation=structuralInvalidation(step8,i3,c3);
  const structuralRiskFloor=Number.isFinite(invalidation)&&invalidation<currentPrice?invalidation:(Number.isFinite(s)&&s<currentPrice?s:NaN);

  const structuralDownsideAtr=Number.isFinite(structuralRiskFloor)&&Number.isFinite(atr5)&&atr5>0?(currentPrice-structuralRiskFloor)/atr5:NaN;
  const openUpside=!Number.isFinite(r)&&Number.isFinite(structuralDownsideAtr)&&structuralDownsideAtr>0;
  const structuralUpsideAtr=openUpside?Infinity:(Number.isFinite(r)&&Number.isFinite(atr5)&&atr5>0?(r-currentPrice)/atr5:NaN);
  const structuralAsymmetry=openUpside?Infinity:(Number.isFinite(structuralUpsideAtr)&&Number.isFinite(structuralDownsideAtr)&&structuralDownsideAtr>0?structuralUpsideAtr/structuralDownsideAtr:NaN);

  const statUpper=model.ready&&Number.isFinite(model.mfePct)?currentPrice*(1+model.mfePct/100):NaN;
  const statLower=model.ready&&Number.isFinite(model.maePct)?currentPrice*(1-model.maePct/100):NaN;
  const historicalUpsideAtr=Number.isFinite(statUpper)&&Number.isFinite(atr5)&&atr5>0?(statUpper-currentPrice)/atr5:NaN;
  const historicalDownsideAtr=Number.isFinite(statLower)&&Number.isFinite(atr5)&&atr5>0?(currentPrice-statLower)/atr5:NaN;
  const historicalAsymmetry=Number.isFinite(historicalUpsideAtr)&&Number.isFinite(historicalDownsideAtr)&&historicalDownsideAtr>0?historicalUpsideAtr/historicalDownsideAtr:NaN;

  const maxExpected=Number.isFinite(r)&&Number.isFinite(statUpper)?Math.min(r,statUpper):Number.isFinite(r)?r:statUpper;
  const minExpected=Number.isFinite(structuralRiskFloor)&&Number.isFinite(statLower)?Math.min(structuralRiskFloor,statLower):Number.isFinite(structuralRiskFloor)?structuralRiskFloor:statLower;

  let verdict='INSUFFICIENT';
  if(structuralAsymmetry===Infinity||Number.isFinite(structuralAsymmetry)){
    if(Number.isFinite(structuralAsymmetry)&&structuralAsymmetry<0.75)verdict='UNFAVORABLE';
    else if(Number.isFinite(structuralAsymmetry)&&structuralAsymmetry<1)verdict='CAUTION';
    else if(model.ready&&Number.isFinite(historicalAsymmetry)&&historicalAsymmetry<1)verdict='CAUTION';
    else verdict=openUpside?'OPEN_UPSIDE':'FAVORABLE';
  }

  return {
    currentPrice,currentTime,atr5,
    nearestResistance:r,nearestResistanceSources:structural.resistance?.sources||[],
    nearestSupport:s,nearestSupportSources:structural.support?.sources||[],
    structuralInvalidation:invalidation,structuralRiskFloor,openUpside,
    structuralUpsideAtr,structuralDownsideAtr,structuralAsymmetry,
    statUpper,statLower,historicalUpsideAtr,historicalDownsideAtr,historicalAsymmetry,
    maxExpected,minExpected,upsideAtr:structuralUpsideAtr,downsideAtr:structuralDownsideAtr,asymmetry:structuralAsymmetry,
    verdict,model,horizonMin:model.horizonMin
  };
}

  async function fetchJson(url,{retries=3,timeout=15000,essential=false}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      if(state.controller?.signal.aborted) (()=>{const e=new Error('Aborted');e.name='AbortError';throw e;})();
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

  async function getExchangeInfo(){return fetchJson(`${BASE}/fapi/v1/exchangeInfo`,{essential:true});}
  async function getBulk24(){return fetchJson(`${BASE}/fapi/v1/ticker/24hr`,{essential:true});}
  async function getBulkBook(){return fetchJson(`${BASE}/fapi/v1/ticker/bookTicker`,{essential:true});}
  async function getServerTime(){const x=await fetchJson(`${BASE}/fapi/v1/time`,{essential:true});return Number(x.serverTime);}

  function activeSymbols(exchange){
    return (exchange.symbols||[]).filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.underlyingType==='COIN'&&s.quoteAsset==='USDT'&&s.marginAsset==='USDT');
  }

  async function buildActivityRank(exchange,tickers,books){
    const syms=activeSymbols(exchange);
    const tickerMap=new Map((tickers||[]).map(x=>[x.symbol,x]));
    const bookMap=new Map((books||[]).map(x=>[x.symbol,x]));
    emit('active-count',{count:syms.length});
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
      // OI remains a real candidate gate later; it is simply no longer requested for all ~500 symbols.
      r.activityScore=.6153846154*r.volumeScore+.3846153846*r.liquidityScore;
    }
    good.sort((a,b)=>{
      const as=Math.round(a.activityScore*10),bs=Math.round(b.activityScore*10);
      if(bs!==as) return bs-as;
      return b.onboardDate-a.onboardDate; // new coin only when score is tied at 0.1-point resolution
    });
    good.forEach((r,i)=>r.activityRank=i+1);
    emit('ranked-count',{count:good.length});
    if(good.length<syms.length) log(`Bulk Activity Rank complete: ${good.length}/${syms.length}; incomplete bulk rows excluded.`);
    log(`Activity Rank V14.2 bulk-only: 0 symbol-specific OI/depth requests for ${good.length} ranked contracts.`);
    progress(40,'Activity Rank bulk-only complete');
    return good;
  }

  // 4h market-context helpers removed: this variant does not fetch or gate on 4h price context.

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

  function shortOiMetrics(hist,liveOiQty,refTime){
    const rows=(Array.isArray(hist)?hist:[])
      .map(x=>({timestamp:Number(x?.timestamp),oi:num(x?.sumOpenInterest)}))
      .filter(x=>Number.isFinite(x.timestamp)&&x.oi>0)
      .sort((a,b)=>a.timestamp-b.timestamp);
    if(!(liveOiQty>0)||rows.length<4)return {delta5:NaN,delta15:NaN,p10_5m:NaN,severeDrop:false,bothDown:false,status:'UNAVAILABLE'};
    const nearest=target=>{
      let best=null,dist=Infinity;
      for(const x of rows){const d=Math.abs(x.timestamp-target);if(d<dist){best=x;dist=d;}}
      return best;
    };
    const five=nearest(refTime-5*60*1000),fifteen=nearest(refTime-15*60*1000);
    const delta5=five?.oi>0?(liveOiQty/five.oi-1)*100:NaN;
    const delta15=fifteen?.oi>0?(liveOiQty/fifteen.oi-1)*100:NaN;
    const changes=[];
    for(let i=1;i<rows.length;i++)if(rows[i-1].oi>0&&rows[i].oi>0)changes.push((rows[i].oi/rows[i-1].oi-1)*100);
    const p10_5m=percentile(changes,.10),medianAbs5m=median(changes.map(x=>Math.abs(x)));
    // P10 supplies the lower-tail location; 3× the coin's own typical absolute 15m OI move
    // prevents a tiny first negative print from being mislabeled as "severe" after a one-sided rising history.
    const severeThreshold=Number.isFinite(p10_5m)&&Number.isFinite(medianAbs5m)?Math.min(p10_5m,-3*medianAbs5m):p10_5m;
    const severeDrop=Number.isFinite(delta5)&&delta5<0&&Number.isFinite(severeThreshold)&&delta5<=severeThreshold;
    const bothDown=Number.isFinite(delta5)&&Number.isFinite(delta15)&&delta5<0&&delta15<0;
    const status=severeDrop?'SEVERE_DOWN':bothDown?'DOWN':(Number.isFinite(delta5)&&Number.isFinite(delta15)?'OK':'UNAVAILABLE');
    return {delta5,delta15,p10_5m,medianAbs5m,severeThreshold,severeDrop,bothDown,status};
  }


  async function analyzeFastMoveContext(symbol,refTime,serverTime){
    try{
      // 3m data is used only for fast-volume context. 4h price reference is intentionally disabled.
      // 70 bars are enough for the existing 20-bar fast-volume reference without carrying a 4h dependency.
      const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=3m&limit=70`,{retries:2,timeout:15000});
      if(!Array.isArray(raw))return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:'3m history unavailable'}};
      const candles=raw.map(klineToCandle).filter(c=>[c.openTime,c.closeTime,c.close,c.quoteVolume].every(Number.isFinite));
      const closed=candles.filter(c=>c.closeTime<serverTime);
      if(closed.length<20)return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:`completed 3m volume candles ${closed.length}/20`}};
      const reference=closed.slice(-20).map(c=>c.quoteVolume).filter(x=>Number.isFinite(x)&&x>=0);
      if(reference.length<20)return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:'3m quote-volume reference incomplete'}};
      const live=candles.find(c=>c.openTime<=serverTime&&c.closeTime>=serverTime)||null;
      let projected=NaN;
      if(live&&Number.isFinite(live.quoteVolume)){
        const elapsed=clamp((serverTime-live.openTime)/60000,.20,1);
        projected=live.quoteVolume/elapsed;
      }else projected=closed.at(-1)?.quoteVolume;
      const avg=mean(reference),p25=percentile(reference,.25),rank=percentileRank(projected,reference),ratio=avg>0?projected/avg:NaN;
      if(![projected,p25,rank,ratio].every(Number.isFinite))return {fastVolume:{status:'UNAVAILABLE',ratio,rank,projectedQuoteVolume:projected,p25,reason:'3m fast-volume context incomplete'}};
      const weak=projected<p25;
      return {fastVolume:{status:weak?'WEAK':'OK',ratio,rank,projectedQuoteVolume:projected,p25,reason:weak?'projected current 3m quote volume < own recent P25':'fast volume supported by own recent distribution'}};
    }catch(e){
      if(e.name==='AbortError')throw e;
      return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:e.message||String(e)}};
    }
  }

  // 1h/15m trend helpers are not used in the 15m/5m/3m variant.

  function entryValueExtensionFeature(candles,ind,index,priceOverride=NaN){
    const atr=ind.atr14[index],e7=ind.ema7[index],e25=ind.ema25[index];
    const price=Number.isFinite(priceOverride)?priceOverride:candles[index]?.close;
    if(![atr,e7,e25,price].every(Number.isFinite)||!(atr>0)||!(price>0))return null;
    const valueUpper=Math.max(e7,e25)+V2_CONFIG.valueAtr*atr;
    return {valueExtension:Math.max(0,(price-valueUpper)/atr),valueUpper,atr,price,e7,e25};
  }

  function entryFreshnessFeature(candles,ind,index,hlPrice,priceOverride=NaN){
    const base=entryValueExtensionFeature(candles,ind,index,priceOverride);
    if(!base||!Number.isFinite(hlPrice)||!(hlPrice>0))return null;
    return {...base,hlExtension:(base.price-hlPrice)/base.atr};
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
      // Keep selected forward windows independent inside the cached history.
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
      const raw=storage.getItem(ENTRY_FRESHNESS_CONFIG.cacheKey);if(!raw)return;
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
      storage.setItem(ENTRY_FRESHNESS_CONFIG.cacheKey,JSON.stringify({version:ENTRY_FRESHNESS_CONFIG.cacheVersion,models:compactModels}));
      const keep=new Set(models.map(m=>m.symbol));for(const key of [...entryFreshnessModelCache.keys()])if(!keep.has(key))entryFreshnessModelCache.delete(key);
    }catch(e){log(`Entry Freshness cache save failed: ${e.message||e}`);}
  }

  function entryFreshnessCachedModel(symbol){
    const m=entryFreshnessModelCache.get(symbol);if(!m)return null;
    const age=Date.now()-Number(m.createdAt);
    if(!Number.isFinite(age)||age<0||age>ENTRY_FRESHNESS_CONFIG.cacheHardMaxAgeMs){entryFreshnessModelCache.delete(symbol);saveEntryFreshnessCache();return null;}
    return {...m,age,refreshNeeded:age>ENTRY_FRESHNESS_CONFIG.cacheRefreshMs};
  }


  function entryImpulseReason(x){
    if(!x||x.status==='UNAVAILABLE')return `15m Elder Impulse UNAVAILABLE — ${x?.reason||'unknown'}`;
    if(x.status==='BEARISH')return '15m Elder Impulse BEARISH — EMA13 slope DOWN + MACD-H slope DOWN';
    if(x.status==='BULLISH')return '15m Elder Impulse BULLISH — EMA13 slope UP + MACD-H slope UP';
    return '15m Elder Impulse NEUTRAL — EMA13 / MACD-H slopes mixed';
  }

async function ensureEntryFreshnessModel(symbol,serverTime){
  const cached=entryFreshnessCachedModel(symbol);
  if(cached&&!cached.refreshNeeded)return cached;
  try{
    const cfg=ENTRY_FRESHNESS_CONFIG;
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=${cfg.historyLimit}`,{retries:2,timeout:15000});
    if(!Array.isArray(raw))return cached||null;
    const candles=raw.map(klineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<serverTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
    if(candles.length<cfg.recentMinBars)return cached||null;
    const ind=buildIndicators(candles),samples=entryFreshnessHistoricalSamples(candles,ind);
    if(!samples.length)return cached||null;
    entryFreshnessModelCache.set(symbol,{symbol,createdAt:Date.now(),samples});
    saveEntryFreshnessCache();
    return entryFreshnessCachedModel(symbol);
  }catch(e){
    if(e.name==='AbortError')throw e;
    log(`Entry Freshness in-scan calibration failed ${symbol}: ${e.message||e}`);
    return cached||null;
  }
}

async function analyzeEntryFreshnessFromData(symbol,currentPrice,serverTime,candles,ind){
  const cfg=ENTRY_FRESHNESS_CONFIG;
  try{
    if(!Array.isArray(candles)||candles.length<cfg.recentMinBars||!ind){
      return {status:'UNAVAILABLE',ready:false,n:0,impulse:{status:'UNAVAILABLE',reason:'recent 15m history unavailable'},reason:`recent 15m history ${Array.isArray(candles)?candles.length:0}/${cfg.recentMinBars}`};
    }
    const recent={candles,ind,hl:activeConfirmedHL(candles,ind,candles.length-1)};
    const impulse=analyze15mElderImpulse(recent);
    const t=candles.length-1,hl=recent.hl;
    const value=entryValueExtensionFeature(candles,ind,t,currentPrice);
    if(!value)return {status:'UNAVAILABLE',ready:false,n:0,impulse,reason:'15m freshness inputs incomplete'};
    const current=hl?entryFreshnessFeature(candles,ind,t,hl.price,currentPrice):null;
    const hlPrice=hl?.price??NaN,hlExtension=current?.hlExtension??NaN;

    if(value.valueExtension<=V2_CONFIG.noChaseAtrPrimary){
      return {status:'FRESH',ready:true,n:0,impulse,hlPrice,hlExtension,valueExtension:value.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,
        reason:value.valueExtension<=0?'price is inside/at 15m value zone':`15m value extension ${value.valueExtension.toFixed(2)} ATR <= ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR limit${hl?'':' (no active HL required)'}`};
    }

    if(!hl||!current){
      return {status:'WAIT_EXTENDED',ready:false,n:0,impulse,needsModel:false,refreshNeeded:false,hlPrice,hlExtension,valueExtension:value.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`15m value extension ${value.valueExtension.toFixed(2)} ATR > ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR and no active confirmed HL exists for analog matching`};
    }

    const cached=await ensureEntryFreshnessModel(symbol,serverTime);
    if(!cached){
      return {status:'WAIT_EXTENDED',ready:false,n:0,impulse,needsModel:false,refreshNeeded:false,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`15m value extension ${current.valueExtension.toFixed(2)} ATR; historical model unavailable in this scan`};
    }

    const neighbors=selectIndependentFreshnessNeighbors(cached.samples,current,hl.time),n=neighbors.length;
    if(n<cfg.minSamples){
      return {status:'WAIT_EXTENDED',ready:false,n,impulse,needsModel:false,refreshNeeded:false,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`15m value extension ${current.valueExtension.toFixed(2)} ATR; independent analogs ${n}/${cfg.minSamples}`};
    }
    const medianMfeAtr=median(neighbors.map(x=>x.mfeAtr)),medianMaeAtr=median(neighbors.map(x=>x.maeAtr));
    const asymmetry=medianMaeAtr>0?medianMfeAtr/medianMaeAtr:(medianMfeAtr>0?Infinity:1);
    const status=Number.isFinite(asymmetry)&&asymmetry<1?'WAIT_EXTENDED':'FAVORABLE';
    return {status,ready:status==='FAVORABLE',n,impulse,needsModel:false,refreshNeeded:false,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
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
    if(x.status==='WAIT_EXTENDED')return Number.isFinite(x.medianMfeAtr)&&Number.isFinite(x.medianMaeAtr)
      ?`Entry Freshness WAIT_EXTENDED — 15m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`
      :`Entry Freshness WAIT_EXTENDED — ${x.reason||`ValueExt ${v} ATR`}`;
    if(x.status==='FAVORABLE')return `Entry Freshness FAVORABLE — 15m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`;
    if(x.status==='FRESH')return `Entry Freshness FRESH — ${x.reason||`ValueExt ${v} ATR`}${Number.isFinite(x.hlExtension)?`, HLext ${h} ATR`:''}`;
    if(x.status==='CALIBRATING')return `Entry Freshness CALIBRATING — ${x.reason}`;
    if(x.status==='NO_ACTIVE_HL')return 'Entry Freshness CALIBRATING — no active confirmed 15m HL';
    return `Entry Freshness UNAVAILABLE — ${x.reason||'unknown'}`;
  }

async function candidateDetails(row,refTime,serverTime,premiumMap,fundingInfoMap,thresholds,bookMap){
  const symbol=row.symbol;
  // Bulk bookTicker and bulk premiumIndex are shared across all scan candidates.
  // Only symbol-specific data that has no useful bulk equivalent is requested here.
  const liveBook=bookMap?.get(symbol)||null;
  const liveSpread=spreadPct(liveBook),mid=(num(liveBook?.bidPrice)+num(liveBook?.askPrice))/2;
  const decisionPrice=Number.isFinite(mid)&&mid>0?mid:row.snapshot2;
  if(!Number.isFinite(liveSpread)||!(decisionPrice>0)){recordBaseDrop('bulk book/spread unavailable');return null;}
  if(Number.isFinite(thresholds.spreadP90)&&liveSpread>thresholds.spreadP90){recordBaseDrop('spread > p90');return null;}

  const p=premiumMap.get(symbol)||{};
  const fundingRate=num(p.lastFundingRate),mark=num(p.markPrice),index=num(p.indexPrice),nextFunding=Number(p.nextFundingTime)||NaN;
  const premiumPct=mark>0&&index>0?(mark/index-1)*100:NaN;
  let intervalHours=NaN;
  if(state.fundingInfoLoaded){const fi=fundingInfoMap.get(symbol);intervalHours=fi?num(fi.fundingIntervalHours):8;}
  const fundingClock=Math.max(serverTime,Number(p.time)||0);
  const timeToFunding=Number.isFinite(nextFunding)?Math.max(0,nextFunding-fundingClock):NaN;
  const fundingProx=Number.isFinite(timeToFunding)&&intervalHours>0?timeToFunding/(intervalHours*3600000):NaN;
  const fundingExposure=Number.isFinite(timeToFunding)&&timeToFunding<=MAX_HOLD_MS;
  if(![fundingRate,premiumPct,timeToFunding,fundingProx].every(Number.isFinite)){recordBaseDrop('funding/premium timing unavailable');return null;}

  // Stage 1: three requests only. These can hard-fail the candidate before Taker + Depth are requested.
  const [moveContext,oiHist,freshOi]=await Promise.all([
    analyzeFastMoveContext(symbol,refTime,serverTime),
    fetchJson(`${BASE}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=15m&limit=55`,{retries:2}),
    fetchJson(`${BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,{retries:2})
  ]);

  const fastVolume=moveContext?.fastVolume;
  const liveOiQty=num(freshOi?.openInterest);
  const oiShort=shortOiMetrics(oiHist,liveOiQty,refTime);
  const liveOiNotional=liveOiQty>0&&mark>0?liveOiQty*mark:NaN;
  const volumeOiRatio=liveOiNotional>0?row.quoteVolume/liveOiNotional:NaN;

  const stage1Fields={liveOiQty,liveOiNotional,volumeOiRatio,deltaOi5:oiShort.delta5,deltaOi15:oiShort.delta15,oi5P10:oiShort.p10_5m};
  const missingStage1=Object.entries(stage1Fields).filter(([,v])=>!Number.isFinite(v)).map(([k])=>k);
  if(missingStage1.length){recordBaseDrop(`detail data unavailable: ${missingStage1.slice(0,3).join(',')}`);return null;}
  if(fastVolume?.status==='UNAVAILABLE'){recordBaseDrop('fast volume unavailable');return null;}
  if(oiShort.severeDrop){recordBaseDrop('severe OI 15m drop');return null;}

  // Stage 2 only for candidates that survived the hard Stage-1 gates.
  const [taker,freshDepth]=await Promise.all([
    fetchJson(`${BASE}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=15m&limit=3`,{retries:2}),
    fetchJson(`${BASE}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=50`,{retries:2})
  ]);
  let buy=0,sell=0;
  if(Array.isArray(taker))for(const t of taker){buy+=num(t.buyVol)||0;sell+=num(t.sellVol)||0;}
  const takerRatio=sell>0?buy/sell:NaN;
  if(!Number.isFinite(takerRatio)){recordBaseDrop('taker B/S unavailable');return null;}
  const liveDepth=depthMetrics(freshDepth,decisionPrice).depth;
  if(!Number.isFinite(liveDepth)){recordBaseDrop('depth unavailable');return null;}
  const fundingExtreme=Number.isFinite(thresholds.fundingP90)&&fundingRate>0&&fundingRate>thresholds.fundingP90;

  // Real 10bps depth and OI-notional percentiles are finalized AFTER all surviving
  // Fast Event candidates have been measured. This preserves the gates without
  // paying two heavy requests for every symbol in the full universe.
  const reasons=[],cautions=[];
  if(Number.isFinite(thresholds.spreadP75)&&liveSpread>thresholds.spreadP75)cautions.push('spread > p75');
  if(oiShort.bothDown)cautions.push(`OI 15m/15m both DOWN (${pct(oiShort.delta5)} / ${pct(oiShort.delta15)})`);
  if(fastVolume?.status==='WEAK')cautions.push(`fast volume weak (rank ${fmt(fastVolume.rank,0)}p, ratio ${fmt(fastVolume.ratio,2)}x)`);
  if(!(takerRatio>=1))cautions.push('taker B/S < 1');
  if(fundingExposure&&fundingExtreme)cautions.push('funding settlement + elevated positive funding');

  reasons.push(...cautions);
  const marketContext=state.context?.result;
  if(marketContext)reasons.push(`market ${marketContext} context (info only)`);
  reasons.push(`OI 15m ${pct(oiShort.delta5)} / 15m ${pct(oiShort.delta15)}`);
  reasons.push(`fast volume ${fastVolume.status} — rank ${fmt(fastVolume.rank,0)}p, ratio ${fmt(fastVolume.ratio,2)}x`);

  const result=cautions.length>=2?'CAUTION':'SELECT';
  return {
    ...row,decisionPrice,
    oiQty:liveOiQty,oiNotional:liveOiNotional,volumeOiRatio,
    deltaOi5:oiShort.delta5,deltaOi15:oiShort.delta15,oi5P10:oiShort.p10_5m,oi5SevereThreshold:oiShort.severeThreshold,oiShortStatus:oiShort.status,
    fastVolumeStatus:fastVolume?.status||'UNAVAILABLE',fastVolumeRatio:fastVolume?.ratio??NaN,fastVolumeRank:fastVolume?.rank??NaN,
    takerRatio,fundingRate,intervalHours,nextFunding,timeToFunding,fundingProx,fundingExposure,premiumPct,liveSpread,liveDepth,crowding:'PENDING',
    baseResult:result,result,reasons,baseCautions:cautions.slice()
  };
}

function applyFastCandidateProfileThresholds(rows,thresholds){
  const source=(Array.isArray(rows)?rows:[]).filter(Boolean);
  if(!source.length)return [];
  const depthVals=source.map(r=>r.liveDepth).filter(Number.isFinite);
  const oiVals=source.map(r=>r.oiNotional).filter(Number.isFinite);
  thresholds.depthP25=percentile(depthVals,.25);
  thresholds.depthP10=percentile(depthVals,.10);
  thresholds.oiNotionalP75=percentile(oiVals,.75);
  log(`Fast-candidate profile: depth n=${depthVals.length} P10=${money(thresholds.depthP10)} P25=${money(thresholds.depthP25)}; OI-notional n=${oiVals.length} P75=${money(thresholds.oiNotionalP75)}.`);

  const out=[];
  for(const r of source){
    if(Number.isFinite(thresholds.depthP10)&&Number.isFinite(r.liveDepth)&&r.liveDepth<thresholds.depthP10){recordBaseDrop('depth < fast-candidate p10');continue;}
    const cautions=Array.isArray(r.baseCautions)?r.baseCautions.slice():[];
    if(Number.isFinite(thresholds.depthP25)&&Number.isFinite(r.liveDepth)&&r.liveDepth<thresholds.depthP25)cautions.push('depth < fast-candidate p25');
    const fundingExtreme=Number.isFinite(thresholds.fundingP90)&&r.fundingRate>0&&r.fundingRate>thresholds.fundingP90;
    const premiumExtreme=Number.isFinite(thresholds.premiumP90)&&r.premiumPct>0&&r.premiumPct>thresholds.premiumP90;
    const oiLarge=Number.isFinite(thresholds.oiNotionalP75)&&Number.isFinite(r.oiNotional)&&r.oiNotional>=thresholds.oiNotionalP75;
    const crowding=(fundingExtreme||premiumExtreme)&&oiLarge&&r.deltaOi15>0&&r.takerRatio>1?'CAUTION':'NORMAL';
    if(crowding==='CAUTION')cautions.push('crowding caution');
    const unique=[...new Set(cautions)];
    const added=unique.filter(x=>!(r.baseCautions||[]).includes(x));
    const reasons=[...(r.reasons||[]),...added];
    const result=unique.length>=2?'CAUTION':'SELECT';
    out.push({...r,crowding,baseCautions:unique,baseResult:result,result,reasons});
  }
  return out;
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

  async function getKlineSnapshot(symbol,interval,serverTime){
    return marketDataStore.getSnapshot(symbol,interval,serverTime);
  }

  function analyzeLiveCandleDirection(currentCandle,closedCandles,currentPrice,atr,interval){
    const live=!!currentCandle;
    const candle=currentCandle||closedCandles?.at(-1)||null;
    if(!candle||!(candle.open>0)||!(atr>0))return {interval,status:'UNAVAILABLE',source:live?'LIVE':'CLOSED',bodyAtr:NaN,bodyPct:NaN,open:NaN,price:NaN,blocksSelect:false};
    const px=live&&Number.isFinite(currentPrice)&&currentPrice>0?currentPrice:candle.close;
    if(!(px>0))return {interval,status:'UNAVAILABLE',source:live?'LIVE':'CLOSED',bodyAtr:NaN,bodyPct:NaN,open:candle.open,price:px,blocksSelect:false};
    const body=px-candle.open,bodyAtr=body/atr,bodyPct=(px/candle.open-1)*100;
    let status='FLAT';
    if(bodyAtr>=LIVE_CANDLE_CONFIG.neutralAtr)status='UP';
    else if(interval==='15m'&&bodyAtr<=-LIVE_CANDLE_CONFIG.strongDownAtrPrimary)status='STRONG_DOWN';
    else if(bodyAtr<=-LIVE_CANDLE_CONFIG.neutralAtr)status='DOWN';
    const blocksSelect=interval==='15m'?status==='STRONG_DOWN':(interval==='5m'||interval==='3m')?(status==='DOWN'||status==='STRONG_DOWN'):false;
    return {interval,status,source:live?'LIVE':'CLOSED',bodyAtr,bodyPct,open:candle.open,price:px,blocksSelect};
  }

  function liveDirectionReason(x){
    if(!x||x.status==='UNAVAILABLE')return `${x?.interval||'—'} direction UNAVAILABLE`;
    return `${x.interval} ${x.source} ${x.status} (${pct(x.bodyPct)}, ${x.bodyAtr>=0?'+':''}${fmt(x.bodyAtr,2)} ATR)`;
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


function analyzeStep8(candles,ind,step7,eventStartTime,eventTime,eventPrice){
  const t=candles.length-1;
  if(step7.regime==='DOWNTREND')return {status:'BLOCKED',setup:'NONE',reason:'Step 7 15m DOWNTREND — LONG blocked'};

  // Entry-timing rule: the 5m setup must already exist when the Fast Event starts
  // and it may be at most triggerValidBars completed 5m bars old.
  const maxSetupAgeMs=V2_CONFIG.triggerValidBars*3*60*1000;
  const timingFor=setupTime=>{
    const st=Number(setupTime),ev=Number(eventStartTime);
    if(!Number.isFinite(ev))return {ok:false,kind:'NO_EVENT_START',reason:'Fast Event start time unavailable'};
    if(!Number.isFinite(st))return {ok:false,kind:'NO_SETUP_TIME',reason:'5m setup time unavailable'};
    if(st>ev)return {ok:false,kind:'POST_EVENT',ageMs:st-ev,reason:'5m setup formed after Fast Event start'};
    const ageMs=ev-st;
    if(ageMs>maxSetupAgeMs)return {ok:false,kind:'STALE',ageMs,reason:`5m setup stale: ${Math.round(ageMs/60000)}m old > ${V2_CONFIG.triggerValidBars}×5m`};
    return {ok:true,kind:'VALID',ageMs,reason:`5m setup timing valid: ${Math.round(ageMs/60000)}m old`};
  };

  const pullbackSetup=()=>{
    let setupIndex=-1,setupZoneLow=NaN,setupZoneHigh=NaN,setupEma25=NaN,setupTiming=null,lastTimingReject=null;
    const scanStart=Math.max(1,t-V2_CONFIG.pullbackLookback+1);
    for(let i=scanStart;i<=t;i++){
      const a=ind.atr14[i],e7=ind.ema7[i],e25=ind.ema25[i];if(![a,e7,e25].every(Number.isFinite))continue;
      const valueLow=Math.min(e7,e25)-V2_CONFIG.valueAtr*a,valueHigh=Math.max(e7,e25)+V2_CONFIG.valueAtr*a;
      let wasAbove=false;
      for(let j=Math.max(0,i-V2_CONFIG.pullbackLookback);j<i&&!wasAbove;j++){
        const aj=ind.atr14[j],e7j=ind.ema7[j],e25j=ind.ema25[j];if(![aj,e7j,e25j].every(Number.isFinite))continue;
        const vh=Math.max(e7j,e25j)+V2_CONFIG.valueAtr*aj;if(candles[j].close>vh)wasAbove=true;
      }
      const touches=candles[i].low<=valueHigh&&candles[i].high>=valueLow;
      const deepLimit=e25-V2_CONFIG.deepPullbackAtr*a,deep=candles[i].close<deepLimit;
      if(wasAbove&&touches&&!deep){
        const timing=timingFor(candles[i].closeTime);
        if(!timing.ok){lastTimingReject={timing,setupTime:candles[i].closeTime};continue;}
        setupIndex=i;setupZoneLow=valueLow;setupZoneHigh=valueHigh;setupEma25=e25;setupTiming=timing;
      }
    }
    if(setupIndex<0){
      const a=ind.atr14[t],e25=ind.ema25[t],deepLimit=Number.isFinite(a)&&Number.isFinite(e25)?e25-V2_CONFIG.deepPullbackAtr*a:NaN;
      const deep=Number.isFinite(deepLimit)&&candles[t].close<deepLimit;
      if(deep)return {status:'INVALIDATED',setup:'INVALID_PULLBACK',reason:'current 5m close below deep-pullback limit'};
      if(lastTimingReject)return {status:'WAIT',setup:lastTimingReject.timing.kind==='STALE'?'STALE_SETUP':'TIMING_WAIT',reason:lastTimingReject.timing.reason,setupTime:lastTimingReject.setupTime,setupAgeMs:lastTimingReject.timing.ageMs,maxSetupAgeMs};
      return {status:'WAIT',setup:'NONE',reason:'no valid recent 5m pullback into EMA7–EMA25 value area'};
    }
    for(let j=setupIndex+1;j<=t;j++){
      const a=ind.atr14[j],e25=ind.ema25[j];if(![a,e25].every(Number.isFinite))continue;
      if(candles[j].close<e25-V2_CONFIG.deepPullbackAtr*a)return {status:'INVALIDATED',setup:'INVALID_PULLBACK',reason:'pullback invalidated below EMA25 - 0.50 ATR3',entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr3:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex,setupAgeMs:setupTiming?.ageMs,maxSetupAgeMs};
    }
    return {status:'PASS',setup:'PULLBACK_VALUE',reason:`valid recent 5m pullback; ${setupTiming?.reason||'setup timing valid'}`,entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr3:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex,setupAgeMs:setupTiming?.ageMs,maxSetupAgeMs};
  };

  const breakoutSetup=()=>{
    let pending=null,failed=null,lastTimingReject=null;
    const firstBreak=Math.max(V2_CONFIG.breakoutLookback,t-(V2_CONFIG.breakoutLookback+V2_CONFIG.retestMaxBars+4));
    for(let b=t;b>=firstBreak;b--){
      const a=ind.atr14[b];if(!Number.isFinite(a))continue;
      const rangeHigh=Math.max(...candles.slice(b-V2_CONFIG.breakoutLookback,b).map(c=>c.high));
      const volAvg=mean(candles.slice(b-V2_CONFIG.volumeSma,b).map(c=>c.volume));
      if(!(candles[b].close>rangeHigh+V2_CONFIG.breakoutAtr*a&&candles[b].volume>volAvg))continue;
      const retestLow=rangeHigh-V2_CONFIG.retestAtr*a,retestHigh=rangeHigh+V2_CONFIG.retestAtr*a;
      let retestIndex=-1,invalid=false;
      const end=Math.min(t,b+V2_CONFIG.retestMaxBars);
      for(let j=b+1;j<=end;j++){
        if(candles[j].close<retestLow){invalid=true;break;}
        const touch=candles[j].low<=retestHigh&&candles[j].high>=retestLow;
        if(touch&&candles[j].close>=rangeHigh){retestIndex=j;break;}
      }
      if(invalid){failed={status:'INVALIDATED',setup:'FAILED_BREAKOUT',reason:'recent breakout retest closed below failure boundary',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t]};continue;}
      if(retestIndex<0){
        pending={status:'WAIT',setup:'WAIT_RETEST',reason:'recent 5m breakout valid; retest not completed within current window',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t]};
        continue;
      }
      let broke=false;
      for(let j=retestIndex+1;j<=t;j++)if(candles[j].close<retestLow){broke=true;break;}
      if(broke){failed={status:'INVALIDATED',setup:'FAILED_BREAKOUT',reason:'breakout/retest invalidated after retest',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t],setupTime:candles[retestIndex].closeTime,retestIndex};continue;}
      const timing=timingFor(candles[retestIndex].closeTime);
      if(!timing.ok){lastTimingReject={timing,setupTime:candles[retestIndex].closeTime};continue;}
      return {status:'PASS',setup:'BREAKOUT_RETEST',reason:`valid recent 5m breakout + volume + retest; ${timing.reason}`,rangeHigh,retestIndex,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t],setupTime:candles[retestIndex].closeTime,setupIndex:retestIndex,setupAgeMs:timing.ageMs,maxSetupAgeMs};
    }
    if(pending)return pending;
    if(failed)return failed;
    if(lastTimingReject)return {status:'WAIT',setup:lastTimingReject.timing.kind==='STALE'?'STALE_SETUP':'TIMING_WAIT',reason:lastTimingReject.timing.reason,setupTime:lastTimingReject.setupTime,setupAgeMs:lastTimingReject.timing.ageMs,maxSetupAgeMs};
    return {status:'WAIT',setup:'NONE',reason:'no valid recent 5m breakout + volume + retest setup'};
  };

  if(step7.regime==='UPTREND')return pullbackSetup();
  if(step7.regime==='RANGE')return breakoutSetup();

  const p=pullbackSetup(),b=breakoutSetup(),passes=[p,b].filter(x=>x.status==='PASS');
  if(passes.length){
    const chosen=passes.sort((a,b)=>Number(b.setupTime||0)-Number(a.setupTime||0))[0];
    return {...chosen,transition:true,reason:`15m TRANSITION; ${chosen.reason}`};
  }
  if(p.status==='INVALIDATED'&&b.status==='INVALIDATED')return {status:'INVALIDATED',setup:'NONE',reason:`15m TRANSITION; both setup families invalidated (${p.setup}, ${b.setup})`};
  const timingWait=[p,b].find(x=>x.setup==='STALE_SETUP'||x.setup==='TIMING_WAIT');
  if(timingWait)return {...timingWait,transition:true,reason:`15m TRANSITION; ${timingWait.reason}`};
  return {status:'WAIT',setup:'NONE',transition:true,reason:'15m TRANSITION; no valid current 5m setup'};
}

function step9ChecksAt(candles,ind,i){
  const volSma=mean(candles.slice(i-V2_CONFIG.volumeSma,i).map(c=>c.volume));
  const volOk=candles[i].volume>volSma&&candles[i].volume>candles[i-1].volume;
  const rsi=ind.rsi14[i],rsiOk=rsi>V2_CONFIG.rsiMin&&rsi<V2_CONFIG.rsiMax&&rsi>ind.rsi14[i-1];
  const dif=ind.macd.dif[i],dea=ind.macd.dea[i],hist=ind.macd.hist[i],histPrev=ind.macd.hist[i-1];
  const histRising=hist>histPrev,macdOk=dif>dea||histRising;
  const atr=ind.atr14[i],atrRef=ind.atr14.slice(Math.max(0,i-V2_CONFIG.atrPercentileLookback),i),atrPct=percentileRank(atr,atrRef);
  const atrOk=atrPct>=V2_CONFIG.atrPercentileMin;
  return {
    volume:{pass:volOk,required:false,current:candles[i].volume,sma20:volSma,previous:candles[i-1].volume},
    rsi:{pass:rsiOk,required:false,value:rsi,rising:rsi>ind.rsi14[i-1]},
    macd:{pass:macdOk,required:false,dif,dea,hist,histRising},
    atr:{pass:atrOk,required:false,value:atr,percentile:atrPct}
  };
}


function analyzeStep9(candles,ind,step8){
  if(step8.status!=='PASS')return {status:'NOT_RUN',score:'0/3',passed:0,mandatoryPassed:false,timingPending:false,reason:'Step 8 is not PASS',checks:{}};
  const t=candles.length-1;
  // Use the latest fully closed 3m candle without waiting for a post-Fast-Event close,
  // but it must belong to the setup lifecycle: confirmation close >= 5m setup close.
  if(t<1)return {status:'WAIT',score:'—',passed:NaN,mandatoryPassed:false,timingPending:false,reason:'completed 3m candle unavailable',checks:{}};
  const setupTime=Number(step8.setupTime),confirmationTime=Number(candles[t]?.closeTime);
  if(Number.isFinite(setupTime)&&Number.isFinite(confirmationTime)&&confirmationTime<setupTime){
    return {status:'WAIT',score:'—',passed:NaN,mandatoryPassed:false,timingPending:true,reason:'latest completed 3m candle predates the 5m setup',checks:{},firstConfirmationIndex:-1,firstConfirmationTime:NaN};
  }
  const checks=step9ChecksAt(candles,ind,t);
  const qualityKeys=['rsi','macd','atr'];
  const passed=qualityKeys.filter(k=>checks[k]?.pass).length;
  const failed=qualityKeys.filter(k=>!checks[k]?.pass).map(k=>k.toUpperCase());
  // Same confirmation rule as StartScan: any 1 of RSI / MACD / ATR is sufficient.
  const confirmed=passed>=1;
  const status=confirmed?'CONFIRMED':'WAIT';
  const volumeNote=checks.volume?.pass?'closed-3m VOL supportive':'closed-3m VOL weak (info only)';
  const reason=confirmed
    ?`current completed 3m ${passed}/3 confirmed; at least 1 of RSI/MACD/ATR PASS; ${volumeNote}`
    :`current completed 3m 0/3; RSI/MACD/ATR all failed; CAUTION; ${volumeNote}`;
  return {status,score:`${passed}/3`,passed,mandatoryPassed:true,supportPassed:confirmed,timingPending:false,reason,checks,firstConfirmationIndex:confirmed?t:-1,firstConfirmationTime:confirmed?candles[t].closeTime:NaN};
}


function analyzeStep10(candles1,ind1,candles3,ind3,step8,step9,currentPrice,entryFreshness){
  if(step8.status!=='PASS')return {status:'NOT_RUN',reason:'Step 8 is not PASS'};
  const t3=candles3.length-1,t1=candles1.length-1,atr3=ind3.atr14[t3],current3Close=candles3[t3].close;
  if(step8.setup==='PULLBACK_VALUE'){
    const invalidLine=ind3.ema25[t3]-V2_CONFIG.deepPullbackAtr*atr3;
    if(current3Close<invalidLine)return {status:'INVALIDATED',reason:'5m pullback invalidated below EMA25 - 0.50 ATR3'};
  }else if(step8.setup==='BREAKOUT_RETEST'){
    if(current3Close<step8.entryZoneLow)return {status:'INVALIDATED',reason:'5m breakout/retest invalidated below retest zone'};
  }
  if(step9.status!=='CONFIRMED')return {status:'WAIT',reason:'current completed 3m confirmation is not valid (at least 1 of RSI/MACD/ATR must PASS)'};
  const px=Number.isFinite(currentPrice)&&currentPrice>0?currentPrice:candles1[t1].close;
  const lower=step8.entryZoneLow;
  if(px<lower)return {status:'WAIT',reason:'Fast Event price is below 5m entry-zone lower boundary',currentPrice:px};

  // Same no-chase rule, now anchored to the primary 15m structure.
  const valueExtension=Number(entryFreshness?.valueExtension);
  if(!Number.isFinite(valueExtension))return {status:'WAIT',reason:'15m no-chase value extension unavailable',currentPrice:px,valueExtension};
  if(valueExtension>V2_CONFIG.noChaseAtrPrimary){
    return {status:'TOO_LATE',reason:`entry too late: 15m value extension ${valueExtension.toFixed(2)} ATR > ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR no-chase limit`,currentPrice:px,valueExtension};
  }

  const extensionAtr=Number.isFinite(atr3)&&atr3>0&&Number.isFinite(step8.entryZoneHigh)
    ?(px-step8.entryZoneHigh)/atr3:NaN;
  return {status:'READY',reason:`15m trend + fresh 5m setup + latest-closed 3m ${step9.score} + Fast Event trigger + 15m no-chase ${valueExtension.toFixed(2)} ATR`,currentPrice:px,extensionAtr,valueExtension};
}

function softWarningCategory(text){
  const x=String(text||'').toLowerCase();
  if(x.includes('spread')||x.includes('depth'))return 'liquidity';
  if(x.includes('oi 15m/15m')||x.includes('taker b/s'))return 'flow';
  if(x.includes('funding')||x.includes('crowding')||x.includes('premium'))return 'positioning';
  if(x.includes('fast volume'))return 'participation';
  if(x.includes('historical r/r'))return 'history';
  if(x.includes('extension')||x.includes('chase'))return 'extension';
  if(x.includes('15m transition'))return 'trend-transition';
  return x||'other';
}

function finalizeEntryDecision(row,chart,finalSpread=NaN){
  const coreCautions=[],softWarnings=[],drops=[];

  // Auxiliary market-quality warnings are informational only.
  // They remain visible in Reason but never demote SELECT to CAUTION.
  for(const x of (Array.isArray(row.baseCautions)?row.baseCautions:[]))softWarnings.push(x);
  if(Number.isFinite(state.thresholds?.spreadP75)&&Number.isFinite(finalSpread)&&finalSpread>state.thresholds.spreadP75){
    softWarnings.push('spread > p75');
  }

  if(chart.step7?.regime==='DOWNTREND')drops.push('15m DOWNTREND');
  // 15m TRANSITION is informational only; it does not affect SELECT/CAUTION.

  const freshness=chart.entryFreshness;
  if(!freshness||freshness.status==='UNAVAILABLE'||freshness.status==='CALIBRATING')drops.push('15m freshness unavailable');
  // Current no-chase timing is enforced as a hard Entry gate in Step 10.

  const impulse=chart.entryImpulse;
  if(!impulse||impulse.status==='UNAVAILABLE')drops.push('15m Elder unavailable');
  else if(impulse.status==='BEARISH')drops.push('15m Elder BEARISH');

  const s8=chart.step8||{};
  if(s8.status==='INVALIDATED'||s8.status==='BLOCKED')drops.push(s8.reason||'5m setup invalid');
  else if(s8.status!=='PASS')coreCautions.push(s8.reason||'5m setup not ready');

  if(s8.status==='PASS'){
    const passed=Number(chart.step9?.passed);
    if(chart.step9?.status!=='CONFIRMED'){
      // 3m confirmation is an Entry-Ready gate, not a structural invalidation gate.
      // Any non-confirmed 3m state stays visible as CAUTION; only explicit hard-fail
      // conditions elsewhere are allowed to remove the candidate from the Response.
      if(chart.step9?.timingPending){
        coreCautions.push(chart.step9?.reason||'3m candle not ready');
      }else if(Number.isFinite(passed)){
        coreCautions.push(`${chart.step9.score} not Entry Ready — no RSI/MACD/ATR confirmation component passed`);
      }else{
        coreCautions.push(chart.step9?.reason||'3m confirmation not ready');
      }
    }
  }

  if(s8.status==='PASS'&&chart.step9?.status==='CONFIRMED'){
    if(chart.step10?.status==='INVALIDATED')drops.push(chart.step10.reason||'setup invalidated');
    else if(chart.step10?.status==='TOO_LATE'||chart.step10?.status==='SKIP_CHASE')coreCautions.push(chart.step10.reason||'entry too late');
    else if(chart.step10?.status!=='READY')coreCautions.push(chart.step10?.reason||'entry trigger/zone not ready');
  }

  // Live direction is an entry-timing gate, never a structural invalidation.
  // 15m primary: only a strong downside body blocks SELECT. A mild 15m DOWN stays valid.
  // 5m setup: a clear downside body blocks SELECT. FLAT/UP remain valid.
  const live5=chart.liveDirection15m,live3=chart.liveDirection5m;
  if(live5?.blocksSelect)coreCautions.push(`live 15m STRONG_DOWN (${live5.bodyAtr>=0?'+':''}${fmt(live5.bodyAtr,2)} ATR)`);
  else if(live5?.status==='DOWN')softWarnings.push(`live 15m mild DOWN (${live5.bodyAtr>=0?'+':''}${fmt(live5.bodyAtr,2)} ATR)`);
  if(live3?.blocksSelect)coreCautions.push(`live 5m DOWN (${live3.bodyAtr>=0?'+':''}${fmt(live3.bodyAtr,2)} ATR)`);

  // Independent 3m entry-timing gate: DOWN can demote SELECT to CAUTION only.
  // It never creates DROP and does not modify the existing 3m confirmation state.
  const live1=chart.liveDirection3m;
  if(live1?.blocksSelect)coreCautions.push(`live 3m DOWN (${live1.bodyAtr>=0?'+':''}${fmt(live1.bodyAtr,2)} ATR1)`);

  const loc=chart.priceLocation;
  if(chart.step10?.status==='READY'){
    const structuralKnown=!!loc&&(loc.structuralAsymmetry===Infinity||Number.isFinite(loc.structuralAsymmetry));
    if(!structuralKnown)coreCautions.push('structural R/R unavailable');
    else if(Number.isFinite(loc.structuralAsymmetry)&&loc.structuralAsymmetry<0.75)drops.push(`structural R/R ${fmt(loc.structuralAsymmetry,2)} < 0.75`);
    else if(Number.isFinite(loc.structuralAsymmetry)&&loc.structuralAsymmetry<1)coreCautions.push(`structural R/R ${fmt(loc.structuralAsymmetry,2)} = CAUTION (0.75-0.99)`);
    if(loc?.model?.ready&&Number.isFinite(loc.historicalAsymmetry)&&loc.historicalAsymmetry<1){
      softWarnings.push(`historical R/R ${fmt(loc.historicalAsymmetry,2)} < 1`);
    }
  }

  const uniqueSoft=[...new Set(softWarnings)];
  const uniqueCore=[...new Set(coreCautions)];
  const uniqueDrops=[...new Set(drops)];
  const softCategories=[...new Set(uniqueSoft.map(softWarningCategory))];
  if(uniqueDrops.length)return {result:'DROP',cautions:[...uniqueCore,...uniqueSoft],coreCautions:uniqueCore,softWarnings:uniqueSoft,softCategories,drops:uniqueDrops};
  if(uniqueCore.length)return {result:'CAUTION',cautions:[...uniqueCore,...uniqueSoft],coreCautions:uniqueCore,softWarnings:uniqueSoft,softCategories,drops:uniqueDrops};
  // V14.19: soft-warning count never changes Result. Hard drops and core cautions
  // decide eligibility; soft warnings remain informational in Reason only.
  return {result:'SELECT',cautions:[],coreCautions:uniqueCore,softWarnings:uniqueSoft,softCategories,drops:uniqueDrops};
}


async function analyzeChartCandidate(row,serverTime,finalBookMap){
  try{
    const [s5,s3,s1]=await Promise.all([
      getKlineSnapshot(row.symbol,'15m',serverTime),
      getKlineSnapshot(row.symbol,'5m',serverTime),
      getKlineSnapshot(row.symbol,'3m',serverTime)
    ]);
    const c5=s5.closed,c3=s3.closed,c1=s1.closed;
    const finalBook=finalBookMap?.get(row.symbol)||null;
    const finalSpread=spreadPct(finalBook),finalBid=num(finalBook?.bidPrice),finalAsk=num(finalBook?.askPrice);
    const currentPrice=finalBid>0&&finalAsk>0?(finalBid+finalAsk)/2:row.decisionPrice;
    if(Number.isFinite(state.thresholds?.spreadP90)&&Number.isFinite(finalSpread)&&finalSpread>state.thresholds.spreadP90){
      return {...row,decisionPrice:currentPrice,liveSpread:finalSpread,result:'DROP',reasons:[...(row.reasons||[]),'entry drop: final spread > profile p90'],chartAnalysis:{final:'DROP',reason:'final spread > profile p90',step7:{regime:'NOT_RUN'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—',passed:0},step10:{status:'NOT_RUN'},priceLocation:null,entryFreshness:null,entryImpulse:null}};
    }

    const i5=buildIndicators(c5),i3=buildIndicators(c3),i1=buildIndicators(c1);
    const liveDirection15m=analyzeLiveCandleDirection(s5.current,c5,currentPrice,i5.atr14.at(-1),'15m');
    const liveDirection5m=analyzeLiveCandleDirection(s3.current,c3,currentPrice,i3.atr14.at(-1),'5m');
    const liveDirection3m=analyzeLiveCandleDirection(s1.current,c1,currentPrice,i1.atr14.at(-1),'3m');

    // New hierarchy: 15m primary structure -> 5m setup -> 3m confirmation.
    const step7=analyzeStep7(c5,i5);
    const entryFreshness=await analyzeEntryFreshnessFromData(row.symbol,currentPrice,serverTime,c5,i5);
    const entryImpulse=entryFreshness?.impulse||analyze15mElderImpulse({candles:c5,ind:i5,hl:null});
    const step8=analyzeStep8(c3,i3,step7,row.fastEventStartTime,row.fastEventTime,row.fastEventPrice);
    const step9=analyzeStep9(c1,i1,step8);
    const step10=analyzeStep10(c1,i1,c3,i3,step8,step9,currentPrice,entryFreshness);
    const priceLocation=step10.status==='READY'?computePriceLocation(c5,c3,c1,i5,i3,step7,step8,{horizonMin:240,currentPriceOverride:currentPrice,currentTimeOverride:serverTime}):null;
    const provisional={step7,step8,step9,step10,priceLocation,entryFreshness,entryImpulse,liveDirection15m,liveDirection5m,liveDirection3m};
    const decision=finalizeEntryDecision(row,provisional,finalSpread);
    const final=decision.result;
    const reason=`7(15m):${step7.reason} | Fresh:${entryFreshnessReason(entryFreshness)} | Elder:${entryImpulseReason(entryImpulse)} | 8(5m):${step8.reason} | 9(3m):${step9.reason} | 10:${step10.reason} | Live:${liveDirectionReason(liveDirection15m)}; ${liveDirectionReason(liveDirection5m)}; ${liveDirectionReason(liveDirection3m)}${priceLocation?` | Location:${priceLocation.verdict}; StructuralAsym=${priceLocation.structuralAsymmetry===Infinity?'OPEN':fmt(priceLocation.structuralAsymmetry,2)}; HistAsym=${fmt(priceLocation.historicalAsymmetry,2)}; StatN=${priceLocation.model.n}`:''}`;
    const chartAnalysis={final,reason,step7,step8,step9,step10,priceLocation,entryFreshness,entryImpulse,liveDirection15m,liveDirection5m,liveDirection3m,decision,asOf:serverTime};
    const reasons=[...(row.reasons||[]),...decision.drops.map(x=>`entry drop: ${x}`),...decision.coreCautions.map(x=>`entry caution: ${x}`),...decision.softWarnings.map(x=>`entry info: ${x}`),reason];
    const out={...row,decisionPrice:currentPrice,liveSpread:finalSpread,result:decision.result,reasons,chartAnalysis,entryFreshness,entryImpulse,trend15mRegime:step7.regime,trend15mReason:step7.reason};
    if(decision.result==='SELECT'&&step10.status==='READY'&&priceLocation)registerPriceObservation(out,chartAnalysis,priceLocation);
    return out;
  }catch(e){
    if(e.name==='AbortError')throw e;
    return {...row,result:'DROP',reasons:[...(row.reasons||[]),`entry drop: data/analysis error ${e.message}`],chartAnalysis:{final:'DROP',reason:`entry data/analysis error: ${e.message}`,step7:{regime:'ERROR'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—',passed:0},step10:{status:'NOT_RUN'},priceLocation:null,entryFreshness:null,entryImpulse:null}};
  }
}

  function sortCandidates(rows){
    const pr={SELECT:2,CAUTION:1};
    return rows.slice().sort((a,b)=>{
      let d=(pr[b.result]||0)-(pr[a.result]||0);if(d)return d;
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
    if(state.controller?.signal.aborted)(()=>{const e=new Error('Aborted');e.name='AbortError';throw e;})();

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


  function updateSummary(rows,universeCount,fastCount,eventCount){emit('summary',{rows:rows||[],universeCount,fastCount,eventCount});}


function logEntryDecisionDiagnostics(rows){
  const list=(rows||[]).filter(Boolean),dropCounts=new Map(),cautionCounts=new Map();
  for(const r of list){
    for(const x of r.chartAnalysis?.decision?.drops||[])dropCounts.set(x,(dropCounts.get(x)||0)+1);
    for(const x of r.chartAnalysis?.decision?.coreCautions||[])cautionCounts.set(x,(cautionCounts.get(x)||0)+1);
    for(const x of r.chartAnalysis?.decision?.softWarnings||[])cautionCounts.set(`soft: ${x}`,(cautionCounts.get(`soft: ${x}`)||0)+1);
  }
  const top=m=>[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`${v}× ${k}`).join(' | ');
  if(dropCounts.size)log(`Entry hard-fail gates: ${top(dropCounts)}`);
  if(cautionCounts.size)log(`Entry CAUTION gates: ${top(cautionCounts)}`);
}


  // =====================================================================
  // AUTO HISTORY BOOTSTRAP + LIVE CYCLE
  // =====================================================================
  function currentServerTime(){return Date.now()+Number(state.serverOffsetMs||0);}
  function followApi(){return runtime.followGateway||null;}
  function activeFollowSymbols(){const api=followApi();if(typeof api?.getActiveSymbols==='function')return new Set((api.getActiveSymbols()||[]).map(s=>String(s||'').trim().toUpperCase()).filter(Boolean));const out=new Set();for(const s of state.autoFollowSymbols)if(api?.isFollowing?.(s))out.add(s);return out;}
  function usedSlots(){const active=activeFollowSymbols();let n=active.size;for(const s of state.startingFollow)if(!active.has(s))n++;return n;}
  function activeCapacity(){return Math.max(0,getAutoSettings().maxOpenPositions-usedSlots());}
  function slotsText(){const c=getAutoSettings();return `${usedSlots()}/${c.maxOpenPositions}`;}

  async function bootstrapHistorySymbol(row,serverTime){
    const symbol=row.symbol,cfg=getAutoSettings(),limit=cfg.historyBootstrapLimit;
    const intervals=['3m','5m','15m'];
    const raws=await Promise.all(intervals.map(interval=>fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,{retries:3,timeout:18000,essential:false})));
    for(let i=0;i<intervals.length;i++){
      const raw=raws[i];if(!Array.isArray(raw))throw new Error(`${intervals[i]} history unavailable`);
      const candles=raw.map(klineToCandle).filter(c=>Number.isFinite(c.openTime)&&Number.isFinite(c.closeTime)&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
      if(!marketDataStore.seedInterval(symbol,intervals[i],candles,serverTime))throw new Error(`${intervals[i]} closed history < ${V2_CONFIG.candleLimit}`);
    }
    return true;
  }

  async function runHistoryQueue(universe){
    const cfg=getAutoSettings(),rows=[...(universe||[])];let cursor=0,done=0;
    state.historyStop=false;state.historyAttempts=0;state.historyReady.clear();state.historyFailed.clear();
    log(`HISTORY QUEUE START: ${rows.length} symbols • ${cfg.historyWorkers} workers • native 3m+5m+15m REST (${cfg.historyBootstrapLimit} each) • ${cfg.historyWorkerPauseMs}ms/worker pacing.`);
    async function worker(){
      while(state.running&&!state.historyStop){
        const i=cursor++;if(i>=rows.length)return;const row=rows[i];state.historyAttempts++;
        try{await bootstrapHistorySymbol(row,currentServerTime());state.historyReady.add(row.symbol);}
        catch(e){if(e.name==='AbortError')return;state.historyFailed.add(row.symbol);log(`History ${row.symbol}: ${e.message||e}`);}
        done++;
        if(done<=4||done%20===0||done===rows.length)log(`HISTORY QUEUE: ready ${state.historyReady.size}/${rows.length} • pending ${Math.max(0,rows.length-done)} • attempts ${state.historyAttempts} • hard-fail ${state.historyFailed.size} • REST total ${state.requestCount}`);
        if(cfg.historyWorkerPauseMs)await sleep(cfg.historyWorkerPauseMs);
      }
    }
    await Promise.all(Array.from({length:Math.min(cfg.historyWorkers,Math.max(1,rows.length))},worker));
    log(`HISTORY QUEUE END: ready ${state.historyReady.size}/${rows.length} • failed ${state.historyFailed.size} • REST total ${state.requestCount}.`);
  }

  async function waitForMinimumHistory(universe){
    const target=Math.min(universe.length,getAutoSettings().minReadyToStart);const started=Date.now();
    while(state.running&&state.historyReady.size<target){
      if(state.historyPromise&&state.historyReady.size+state.historyFailed.size>=universe.length)break;
      progress(8,`History warming ${state.historyReady.size}/${universe.length}`);setStatus(`Auto15m5m3m history hazırlanıyor: ${state.historyReady.size}/${universe.length} hazır…`,'info');
      await sleep(500);
      if(Date.now()-started>120000&&state.historyReady.size>0)break;
    }
    if(!state.historyReady.size)throw new Error('15m/5m/3m geçmiş veri bootstrap henüz hiçbir coin için hazır değil.');
    log(`LIVE ENGINE START: history-ready ${state.historyReady.size}/${universe.length}; remaining symbols join automatically without restarting scan.`);
  }

  async function waitForWebSocketLive(universe){
    const target=Math.min(Math.max(3,getAutoSettings().minReadyToStart),Math.max(1,universe.length));
    const started=Date.now();
    while(state.running){
      const h=marketDataStore.health(universe,['3m','5m','15m']);
      const ready=Math.min(h.m3,h.m5,h.m15,h.book);
      if(ready>=target){
        log(`WEBSOCKET LIVE: 3m ${h.m3}/${h.total} • 5m ${h.m5}/${h.total} • 15m ${h.m15}/${h.total} • book ${h.book}/${h.total}.`);
        return;
      }
      progress(9,`WebSocket warming ${ready}/${target}`);
      setStatus(`Auto15m5m3m WebSocket hazırlanıyor: 3m ${h.m3} • 5m ${h.m5} • 15m ${h.m15} • book ${h.book}…`,'info');
      await sleep(500);
      if(Date.now()-started>20000){
        throw new Error(`Binance WebSocket canlı veri alınamadı: 3m ${h.m3}, 5m ${h.m5}, 15m ${h.m15}, book ${h.book}.`);
      }
    }
  }

  async function prepareAutoSession(){
    const allowedCoins=await runtime.universeProvider();
    if(!(allowedCoins instanceof Set))throw new Error('universeProvider must return Set of allowed symbols.');
    log(`Auto15m5m3m: selector=original 15m-5m-3m unchanged • AllowedCoins=${allowedCoins.size}.`);

    let activity,exchange,initialBooks=[];const cacheAge=activityCacheAgeMs();
    if(state.activityCache&&cacheAge<ACTIVITY_CACHE_MS){
      exchange=await getExchangeInfo();const liveEligible=activeSymbols(exchange),liveSet=new Set(liveEligible.map(s=>s.symbol));activity=state.activityCache.activity.filter(r=>liveSet.has(r.symbol));
      if(!activity.length)throw new Error('Cached Activity Rank ile live universe kesişimi boş.');state.activity=activity;updateActivityCacheStatus();
      initialBooks=await getBulkBook();
    }else{
      const [ex,tickers,books]=await Promise.all([getExchangeInfo(),getBulk24(),getBulkBook()]);exchange=ex;initialBooks=books;activity=await buildActivityRank(exchange,tickers,books);state.activity=activity;if(!activity.length)throw new Error('Activity Rank oluşturulamadı.');savePersistentActivityCache({createdAt:Date.now(),activeCount:activeSymbols(exchange).length,activity});
    }
    marketDataStore.seedBooks(initialBooks);
    // Keep the manual scanner's Activity Rank universe. AllowedCoins remains a final eligibility gate.
    const universe=activity;
    emit('universe',{count:universe.length,rank301:activity.filter(r=>r.activityRank>=300).length,fast:'WS',eventWatch:universe.length});
    const serverTime=await getServerTime();state.serverOffsetMs=serverTime-Date.now();
    startHybridStreams(universe);await sleep(500);
    state.historyPromise=runHistoryQueue(universe).catch(e=>{if(e.name!=='AbortError')log(`History queue fatal: ${e.message||e}`);});
    await Promise.all([waitForMinimumHistory(universe),waitForWebSocketLive(universe)]);
    emit('context-clear',{message:'Auto15m5m3m: 15m/5m/3m + bookTicker WebSocket canlı; 4h context disabled.'});
    return {universe,allowedCoins,statusMap:new Map((exchange.symbols||[]).map(x=>[x.symbol,x])),preparedAt:Date.now()};
  }

  async function loadAutoPremiumFunding(){const t=Date.now();if(state.premiumCache&&t-state.premiumCache.loadedAt<60000)return state.premiumCache;const x=await loadPremiumFunding();state.premiumCache={...x,loadedAt:t};return state.premiumCache;}

  function operationallyValid(row,cycleTime){const sym=state.session?.statusMap?.get(row.symbol);if(!sym||sym.status!=='TRADING'||sym.contractType!=='PERPETUAL'||sym.underlyingType!=='COIN'||sym.quoteAsset!=='USDT'||sym.marginAsset!=='USDT')return false;const delivery=Number(sym.deliveryDate);return !(Number.isFinite(delivery)&&delivery>0&&delivery<=cycleTime+MAX_HOLD_MS);}

  function watchStateFor(symbol,row=null){const w=runtime.watchService.add(symbol);if(row)state.watchRows.set(symbol,{...row,scanSource:SCAN_SOURCE,scanTimeframes:{...SCAN_TIMEFRAMES},autoWatchStatus:w.status,autoWatchReason:w.reason,btcImpact15m5m3m:w.btcImpact||null});return w;}
  function removeWatch(symbol){runtime.watchService.remove(symbol);state.watchRows.delete(symbol);state.greenQueue=state.greenQueue.filter(x=>x!==symbol);}
  function updateWatchRowsFromStates(){for(const [symbol,row] of state.watchRows){const w=state.watchStates.get(symbol);if(w)state.watchRows.set(symbol,{...row,autoWatchStatus:w.status,autoWatchReason:w.reason,btcImpact15m5m3m:w.btcImpact||null});}}

  function reconcileWatchPool(finalSelects){
    const eligible=new Map((finalSelects||[]).map(r=>[r.symbol,r]));const active=activeFollowSymbols();
    for(const symbol of [...state.watchStates.keys()])if(!eligible.has(symbol)&&!active.has(symbol))removeWatch(symbol);
    for(const row of finalSelects||[]){if(active.has(row.symbol)&&!getAutoSettings().allowDuplicateSymbolPosition)continue;watchStateFor(row.symbol,row);}
    updateWatchRowsFromStates();
  }
  function evaluateWatchSymbol(symbol,referenceTime){return runtime.watchService.evaluate(symbol,referenceTime);}

  async function checkBtcImpactBeforeFollow(symbol,w){
    const btcApi=runtime.btcImpactGateway;
    if(!w)return false;
    if(!btcApi?.analyze){
      w.confirmed=false;w.confirmCount=0;w.status='WAIT';w.btcImpactError='BTCImpact15m5m3m.js unavailable';
      w.reason='BTC WAIT • BTCImpact15m5m3m.js yüklenmedi; otomatik LONG açılmadı.';
      return false;
    }
    try{
      const result=await btcApi.analyze(symbol);
      w.btcImpact=result;w.btcImpactError=null;w.btcCheckedAt=Date.now();
      const summary=btcApi.summaryText?.(result)||`BTC ${result?.level||'NEUTRAL'}`;
      if(result?.entryDecision==='WAIT'){
        w.confirmed=false;w.confirmCount=0;w.status='WAIT';
        w.reason=`BTC WAIT • ${summary}`;
        log(`BTC GATE ${symbol}: WAIT • ${summary}`);
        return false;
      }
      w.reason=`${w.reason} • BTC ALLOW • ${summary}`;
      const row=state.watchRows.get(symbol);if(row)state.watchRows.set(symbol,{...row,btcImpact15m5m3m:result});
      log(`BTC GATE ${symbol}: ALLOW • ${summary}`);
      return true;
    }catch(e){
      w.confirmed=false;w.confirmCount=0;w.status='WAIT';w.btcImpactError=String(e?.message||e);w.btcCheckedAt=Date.now();
      w.reason=`BTC WAIT • etki verisi alınamadı: ${e?.message||e}`;
      log(`BTC GATE ${symbol}: WAIT • ${e?.message||e}`);
      return false;
    }
  }

  async function startFollowFor(symbol){
    if(activeCapacity()<=0||state.startingFollow.has(symbol))return false;const api=followApi();if(!api)return false;if(api.isFollowing?.(symbol)){state.autoFollowSymbols.add(symbol);removeWatch(symbol);return true;}
    const w=state.watchStates.get(symbol);renderAutoGrid();const prepared=typeof api.prepareInputs==='function'?api.prepareInputs(symbol,w?.latestPrice):true;if(prepared===false){if(w){w.status='ARMED';w.reason='GREEN hazır; Follow satırı/Entry/Stop bekleniyor.';}return false;}
    state.startingFollow.add(symbol);try{let started=false;if(typeof api.startFollow==='function')started=(await api.startFollow(symbol))===true||!!api.isFollowing?.(symbol);if(started){state.autoFollowSymbols.add(symbol);removeWatch(symbol);log(`AUTO FOLLOW ${symbol}: GREEN + BTC ALLOW → Follow başladı • slots ${slotsText()}.`);return true;}if(w){w.status='ARMED';w.reason='GREEN hazır; Follow başlatılamadı, tekrar denenecek.';}return false;}finally{state.startingFollow.delete(symbol);}
  }

  async function drainGreenQueue(){
    if(!getAutoSettings().autoFollowOnSelect)return;
    while(state.running&&state.greenQueue.length&&activeCapacity()>0){
      const symbol=state.greenQueue.shift(),w=state.watchStates.get(symbol);
      if(!w||!w.confirmed||!['GREEN','ARMED'].includes(w.status))continue;
      w.status='GREEN';
      const btcAllowed=await checkBtcImpactBeforeFollow(symbol,w);
      if(!btcAllowed){renderAutoGrid();continue;}
      const ok=await startFollowFor(symbol);
      if(!ok&&state.watchStates.has(symbol)){w.status='ARMED';state.greenQueue.unshift(symbol);break;}
    }
  }

  function renderAutoGrid(){updateWatchRowsFromStates();state.results=[...state.watchRows.values()].filter(r=>r?.result==='SELECT');emit('results',{rows:state.results,watchStates:runtime.watchService.values()});}

  async function watchTick(){if(!state.running)return;const t=currentServerTime();for(const symbol of state.watchStates.keys())evaluateWatchSymbol(symbol,t);renderAutoGrid();await drainGreenQueue();updateAutoStatus();}
  function startWatchTimer(){if(state.watchTimer)clearInterval(state.watchTimer);state.watchTimer=setInterval(()=>{void watchTick();},1000);}
  function stopWatchTimer(){if(state.watchTimer)clearInterval(state.watchTimer);state.watchTimer=null;}

  function updateAutoStatus(){
    if(!state.running)return;const cfg=getAutoSettings(),watch=state.watchStates.size,green=[...state.watchStates.values()].filter(x=>x.status==='GREEN'||x.status==='ARMED').length;
    if(cfg.pauseScanWhenPositionLimitReached&&activeCapacity()<=0)setStatus(`Auto15m5m3m PAUSED • slots ${slotsText()} • Follow EXIT bekleniyor.`,'good');
    else if(watch)setStatus(`Auto15m5m3m: SELECT ${watch} • Watch giriş zamanını bekliyor${green?` • GREEN/ARMED ${green}`:''} • confirm ${cfg.entryConfirmationCount}x • slots ${slotsText()}.`,'good');
    else{
      const d=state.lastCycleDiagnostics||null,g=state.gateDiagnostics||null;
      let gate='';
      if(g){
        const gates=[['15mDown',Number(g.oneHourBlock)||0],['Fresh/Elder',Number(g.freshnessElder)||0],['5mSetup',Number(g.setup15m)||0],['3mConfirm',Number(g.confirm5m)||0],['Trigger',Number(g.triggerZone)||0],['R/R',Number(g.rr)||0],['Soft',Number(g.softCaution)||0],['Error',Number(g.entryError)||0]].sort((a,b)=>b[1]-a[1]);
        if(gates[0]?.[1]>0)gate=` • topGate ${gates[0][0]}=${gates[0][1]}`;
      }
      const funnel=d?` • ready ${d.ready}/${d.universe} • analyzed ${d.analyzed} • rawSELECT ${d.rawChartSelects} • allowed ${d.allowedChartSelects}/${d.allowedCoins} • detail ${d.detail} • profile ${d.profile} • final ${d.final}${d.baseDrop?` • drop ${d.baseDrop}`:''}`:'';
      setStatus(`Auto15m5m3m LIVE • SELECT yok • slots ${slotsText()} • ${cfg.scanIntervalSeconds}s cycle${funnel}${gate}.`,'info');
    }
  }

  async function evaluateAutoCycle(){
    if(!state.running||state.cycleRunning||!state.session)return;const cfg=getAutoSettings();if(cfg.pauseScanWhenPositionLimitReached&&activeCapacity()<=0){updateAutoStatus();return;}
    state.cycleRunning=true;state.cycleNo++;const cycleNo=state.cycleNo,cycleStart=Date.now(),cycleTime=currentServerTime();resetBaseDropDiagnostics();
    try{
      const universe=state.session.universe,ready=universe.filter(r=>state.historyReady.has(r.symbol)&&marketDataStore.isReady(r.symbol,['3m','5m','15m']));const active=activeFollowSymbols();const candidates=ready.filter(r=>cfg.allowDuplicateSymbolPosition||!active.has(r.symbol));const bookMap=marketDataStore.bookMap(universe);
      const health=marketDataStore.health(universe,['3m','5m','15m']);log(`──────── CYCLE #${cycleNo} ────────`);log(`Universe ${universe.length} • history-ready ${ready.length} • pending ${Math.max(0,universe.length-state.historyReady.size-state.historyFailed.size)} • candidates ${candidates.length} • reserved ${slotsText()} • interval ${cfg.scanIntervalSeconds}s • REST total ${state.requestCount}`);log(`WS health: 3m ${health.m3}/${health.total} • 5m ${health.m5}/${health.total} • 15m ${health.m15}/${health.total} • book ${health.book}/${health.total}`);
      if(!candidates.length){reconcileWatchPool([]);renderAutoGrid();updateAutoStatus();return;}
      state.thresholds={spreadP75:NaN,spreadP90:NaN,depthP25:NaN,depthP10:NaN,fundingP90:NaN,premiumP90:NaN,oiNotionalP75:NaN};
      const chartInput=candidates.map(r=>{const b=bookMap.get(r.symbol),bid=num(b?.bidPrice),ask=num(b?.askPrice),px=bid>0&&ask>0?(bid+ask)/2:r.price;return {...r,snapshot1:px,snapshot2:px,currentFastChange:0,fastChange:0,fastEventStartTime:cycleTime,fastEventTime:cycleTime,fastEventPrice:px,fastEventWindowSec:0,eventAgeMs:0,decisionPrice:px};}).filter(r=>Number.isFinite(r.snapshot2)&&r.snapshot2>0);
      progress(20,`Auto15m5m3m 15m→5m→3m ${chartInput.length}`);
      const analyzed=await mapLimit(chartInput,4,r=>analyzeChartCandidate(r,cycleTime,bookMap),{pauseMs:0,onProgress:(d,n)=>progress(20+45*d/Math.max(1,n),`15m→5m→3m ${d}/${n}`)});const valid=analyzed.filter(Boolean);finalizeGateDiagnostics(valid);logEntryDecisionDiagnostics(valid);
      const rawChartSelects=valid.filter(r=>r.result==='SELECT');
      let chartSelects=rawChartSelects.filter(r=>state.session.allowedCoins.has(r.symbol));
      log(`PRIMARY GATE: analyzed ${valid.length} • raw ChartSELECT ${rawChartSelects.length} • AllowedCoins SELECT ${chartSelects.length}/${state.session.allowedCoins.size}.`);
      let finalSelects=[],spreadEligibleCount=0,detailCount=0,profileCount=0;
      if(chartSelects.length){
        progress(68,'FINAL safety');const {premiumMap,fundingInfoMap}=await loadAutoPremiumFunding();const profilePremium=universe.map(r=>premiumMap.get(r.symbol)).filter(Boolean);const positiveFunding=profilePremium.map(p=>num(p.lastFundingRate)).filter(x=>Number.isFinite(x)&&x>0);const positivePremium=profilePremium.map(p=>{const m=num(p.markPrice),ix=num(p.indexPrice);return m>0&&ix>0?(m/ix-1)*100:NaN;}).filter(x=>Number.isFinite(x)&&x>0);const spreadVals=universe.map(r=>spreadPct(bookMap.get(r.symbol))).filter(Number.isFinite);const thresholds={spreadP75:percentile(spreadVals,.75),spreadP90:percentile(spreadVals,.90),depthP25:NaN,depthP10:NaN,fundingP90:percentile(positiveFunding,.90),premiumP90:percentile(positivePremium,.90),oiNotionalP75:NaN};state.thresholds=thresholds;
        const spreadEligible=chartSelects.filter(r=>{const sp=spreadPct(bookMap.get(r.symbol));return Number.isFinite(sp)&&(!Number.isFinite(thresholds.spreadP90)||sp<=thresholds.spreadP90);});spreadEligibleCount=spreadEligible.length;
        const detailed=await mapLimit(spreadEligible,DETAIL_CONCURRENCY,r=>candidateDetails(r,cycleTime,cycleTime,premiumMap,fundingInfoMap,thresholds,bookMap),{pauseMs:0,onProgress:(d,n)=>progress(68+22*d/Math.max(1,n),`FINAL safety ${d}/${n}`)});detailCount=detailed.filter(Boolean).length;
        const safety=applyFastCandidateProfileThresholds(detailed.filter(Boolean),thresholds);profileCount=safety.length;
        finalSelects=safety.map(r=>{const chart=r.chartAnalysis;if(!chart)return null;const decision=finalizeEntryDecision(r,chart,r.liveSpread),final=decision.result;return {...r,result:final,decisionTime:cycleTime,scanSource:SCAN_SOURCE,scanTimeframes:{...SCAN_TIMEFRAMES},chartAnalysis:{...chart,final,decision},reasons:[...new Set([...(r.reasons||[]),...decision.drops.map(x=>`entry drop: ${x}`),...decision.coreCautions.map(x=>`entry caution: ${x}`),...decision.softWarnings.map(x=>`entry info: ${x}`)])]};}).filter(r=>r?.result==='SELECT'&&operationallyValid(r,cycleTime));
        log(`BASE SAFETY: chart SELECT ${chartSelects.length} → spread eligible ${spreadEligibleCount} → detail ${detailCount} → profile ${profileCount} → WATCH-ELIGIBLE ${finalSelects.length}`);
      }
      const topDrop=[...baseDropDiagnostics.entries()].sort((a,b)=>b[1]-a[1])[0]||null;
      state.lastCycleDiagnostics={universe:universe.length,ready:ready.length,candidates:candidates.length,analyzed:valid.length,rawChartSelects:rawChartSelects.length,allowedChartSelects:chartSelects.length,allowedCoins:state.session.allowedCoins.size,spreadEligible:spreadEligibleCount,detail:detailCount,profile:profileCount,final:finalSelects.length,baseDrop:topDrop?`${topDrop[1]}× ${topDrop[0]}`:''};
      emit('cycle-diagnostics',{diagnostics:state.lastCycleDiagnostics,gates:state.gateDiagnostics});
      finalSelects=sortCandidates(finalSelects);reconcileWatchPool(finalSelects);if(finalSelects.length)await enrichV5GridMetadata(finalSelects);for(const r of finalSelects){const existing=state.watchRows.get(r.symbol);if(existing)state.watchRows.set(r.symbol,{...existing,...r});}
      renderAutoGrid();await drainGreenQueue();updateSummary([...state.watchRows.values()],universe.length,ready.length,ready.length);progress(100,'Live cycle completed');updateAutoStatus();
      log(`CYCLE #${cycleNo} RESULT: WATCH-ELIGIBLE ${finalSelects.length} • Watch pool ${state.watchStates.size} • slots ${slotsText()} • scan-ready ${ready.length}/${universe.length} • REST total ${state.requestCount} • duration ${((Date.now()-cycleStart)/1000).toFixed(2)}s`);
    }catch(e){if(e.name==='AbortError')throw e;state.errors.push({time:Date.now(),message:e.message||String(e)});log(`Auto cycle error: ${e.stack||e.message}`);setStatus(`Auto15m5m3m cycle error: ${e.message}`,'warn');}
    finally{state.cycleRunning=false;}
  }

  function scheduleNextAutoCycle(delayMs=null){if(!state.running)return;if(state.loopTimer)clearTimeout(state.loopTimer);const ms=delayMs==null?getAutoSettings().scanIntervalSeconds*1000:Math.max(0,delayMs);state.loopTimer=setTimeout(async()=>{state.loopTimer=null;if(!state.running)return;try{await evaluateAutoCycle();}catch(e){if(e.name!=='AbortError')log(`Auto scheduler: ${e.message||e}`);}finally{scheduleNextAutoCycle();}},ms);}

  function hydratePersistentState(){
    loadPersistentActivityCache();
    loadPriceLearning();
    loadEntryFreshnessCache();
  }

  function resetScanState(){
    state.errors=[];
    state.results=[];
    state.activity=[];
    state.context=null;
    state.thresholds=null;
    state.snapshotElapsedMs=null;
    state.requestCount=0;
    state.fundingInfoLoaded=false;
    resetBaseDropDiagnostics();
  }

  async function startScan(){
    if(state.running)return;emit('scan-start',{reason:SCAN_SOURCE});
    state.running=true;state.cycleRunning=false;state.controller=new AbortController();state.startedAt=Date.now();state.settings={...getAutoSettings(),scanSettingsUsed:false};state.session=null;state.watchRows.clear();state.watchStates.clear();state.greenQueue=[];state.startingFollow.clear();state.premiumCache=null;state.cycleNo=0;resetScanState();resetUI();setButtons(true);
    try{log(`Auto15m5m3m BUILD ${AUTO153_BUILD}`);setStatus('Auto15m5m3m başlatılıyor: REST bootstrap + WebSocket 15m/5m/3m/bookTicker…','info');state.session=await prepareAutoSession();if(state.controller.signal.aborted)(()=>{const e=new Error('Aborted');e.name='AbortError';throw e;})();setStatus('Auto15m5m3m LIVE başladı.','good');startWatchTimer();await evaluateAutoCycle();scheduleNextAutoCycle();log('PRICE LEARNING background REST: OFF (selection algorithm unaffected).');}
    catch(e){if(e.name==='AbortError'){setStatus('Auto15m5m3m kullanıcı tarafından durduruldu.','warn');progress(0,'Cancelled');}else{setStatus(`Auto15m5m3m failed: ${e.message}`,'bad');progress(0,'Failed');log(`FATAL: ${e.stack||e.message}`);}stopAutoRuntime();}
  }

  function stopAutoRuntime(){if(state.loopTimer)clearTimeout(state.loopTimer);state.loopTimer=null;stopWatchTimer();state.historyStop=true;stopHybridStreams();state.running=false;state.cycleRunning=false;state.session=null;setButtons(false);}
  async function runStandaloneScan(){if(state.running)return;await startScan();}
  function cancelStandaloneScan(){if(state.controller)state.controller.abort();stopAutoRuntime();setStatus('Auto15m5m3m durduruldu. Aktif Follow görevleri etkilenmedi.','warn');}

  function onFollowComplete(symbol){symbol=String(symbol||'').trim().toUpperCase();if(!symbol)return;const was=state.autoFollowSymbols.delete(symbol);if(was)log(`Follow complete ${symbol}: Auto15m5m3m slot released.`);if(state.running&&getAutoSettings().resumeScanAfterPositionExit){void drainGreenQueue().finally(()=>{if(state.running&&activeCapacity()>0)void evaluateAutoCycle();});}}

  const api={configure:configureRuntime,start:runStandaloneScan,scan:runStandaloneScan,cancel:cancelStandaloneScan,stop:cancelStandaloneScan,onFollowComplete,evaluateCycle:evaluateAutoCycle,get running(){return state.running;},state,source:SCAN_SOURCE,timeframes:SCAN_TIMEFRAMES,build:AUTO153_BUILD,get settings(){return getAutoSettings();},get watchedSymbols(){return runtime.watchService?.symbols?.()||[];},get activeFollowSymbols(){return [...activeFollowSymbols()];},get openSlots(){return activeCapacity();}};
  globalThis.Auto15m5m3mCore=api;
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
})();
