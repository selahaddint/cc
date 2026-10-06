(() => {
'use strict';

// HEADLESS RUNTIME PORTS. No DOM/UI dependency is permitted in this file.
let runtime={settingsProvider:()=>({}),persistence:null,universeProvider:null,followGateway:null,btcImpactGateway:null,eventSink:()=>{},streamService:null,watchService:null};
let marketDataStore=null;
const storage={getItem:key=>runtime.persistence?.getItem?.(key)??null,setItem:(key,value)=>runtime.persistence?.setItem?.(key,value),removeItem:key=>runtime.persistence?.removeItem?.(key)};
function emit(type,payload={}){try{runtime.eventSink?.({type,source:SCAN_SOURCE,time:Date.now(),...payload});}catch(_){}}
function configureRuntime(ports={}){runtime={...runtime,...ports};if(!runtime.streamService)throw new Error('Auto3m1mCore requires streamService');if(!runtime.watchService)throw new Error('Auto3m1mCore requires watchService');if(typeof runtime.universeProvider!=='function')throw new Error('Auto3m1mCore requires universeProvider');marketDataStore=runtime.streamService.store;state.watchStates=runtime.watchService.states;hydratePersistentState();return api;}


  // VARIANT: primary trend 3m -> setup 1m -> later 1m confirmation.
  // IMPORTANT: Sec / MinY% / MaxY% and the Fast Event prefilter are NOT used by this scanner.

  // ================================================================
  // AUTO 3m/1m ENTRY ENGINE — Fix6 progressive history queue
  // Owns: 3m/1m Start Scan, candidate selection, chart/location analysis,
  // metadata enrichment, scan caches, summaries and scan exports.
  // Emits follow-request events; actual Follow/UI integration remains outside the domain engine.
  // ================================================================

  const BASE='https://fapi.binance.com';
  const SCAN_SOURCE='Auto 3m-1m Scan';
  const SCAN_BUTTON_ID='auto3m1mScanBtn';
  const SCAN_TIMEFRAMES=Object.freeze({trend:'3m',setup:'1m',confirm:'1m'});
  const AUTO31_BUILD='2026-10-06-diagfix-1';
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
  const AUTO_WATCH_MAX_MS=6*60*1000;
  const ACTIVITY_CONCURRENCY=10;
  const ACTIVITY_PAUSE_MS=0;
  const DETAIL_CONCURRENCY=4;
  const ACTIVITY_CACHE_MS=30*60*1000;
  const ACTIVITY_CACHE_KEY='CryptoOfferV3.ActivityRankCache.v1';
  const ACTIVITY_CACHE_VERSION=2;
  const PRICE_LEARNING_KEY='CryptoOfferV4.2.PriceLearning.31.v1';
  const PRICE_LEARNING_VERSION=1;
  const PRICE_CONFIG=Object.freeze({minStatSamples:30,levelMergeAtr:0.20,completionPerScan:12,completionConcurrency:3,breakoutVolumeSma:20});

  // Start Scan / SELECT-only Entry Freshness Gate.
  // Fast path uses only recent completed 3m candles. Historical analogs are built
  // asynchronously after the scan and cached per symbol so Start Scan is not blocked.
  const ENTRY_FRESHNESS_CONFIG=Object.freeze({
    recentLimit:250,recentMinBars:60,historyLimit:1500,forwardBars:27,minSamples:30,neighbors:30,
    cacheKey:'CryptoOfferAuto3m1m.EntryFreshnessModel.31.v1',cacheVersion:1,cacheRefreshMs:6*60*60*1000,
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

  // 3m/1m hierarchy:
  // 3m = primary structure/trend, 1m = setup, then a later closed 1m candle = confirmation + live timing.
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
  // AUTO 3m/1m RUNTIME CONFIGURATION
  // C# migration boundary: this block maps naturally to ApiSettings.cs.
  // ApiSettings.js is intentionally behavior-only; NEVER place API keys here.
  // =====================================================================
  const AUTO_DEFAULTS=Object.freeze({
    scanIntervalSeconds:5,
    maxOpenPositions:2,
    positionUsdtAmount:100,
    leverage:5,
    entryConfirmationCount:2,
    maxSignalAgeSeconds:75,
    allowDuplicateSymbolPosition:false,
    pauseScanWhenPositionLimitReached:true,
    resumeScanAfterPositionExit:true,
    autoFollowOnSelect:true,
    watchSampleMs:1000,
    watchMinRisePct:0,
    // Infrastructure only: does NOT change 3m/1m selection rules.
    // History is prepared gradually so the live engine never floods REST.
    historyBootstrapIntervalMs:1500,
    historyBootstrapMinReady:40,
    historyBootstrapMaxAttempts:3,
    historyBootstrapWorkers:4
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
      entryConfirmationCount:int(x.entryConfirmationCount,AUTO_DEFAULTS.entryConfirmationCount,1,12),
      maxSignalAgeSeconds:int(x.maxSignalAgeSeconds,AUTO_DEFAULTS.maxSignalAgeSeconds,5,300),
      allowDuplicateSymbolPosition:x.allowDuplicateSymbolPosition===true,
      pauseScanWhenPositionLimitReached:x.pauseScanWhenPositionLimitReached!==false,
      resumeScanAfterPositionExit:x.resumeScanAfterPositionExit!==false,
      autoFollowOnSelect:x.autoFollowOnSelect!==false,
      watchSampleMs:int(x.auto3m1mWatchSampleMs,AUTO_DEFAULTS.watchSampleMs,250,10000),
      watchMinRisePct:Math.max(0,Number(x.auto3m1mWatchMinRisePct)||AUTO_DEFAULTS.watchMinRisePct),
      historyBootstrapIntervalMs:int(x.historyBootstrapIntervalMs,AUTO_DEFAULTS.historyBootstrapIntervalMs,500,30000),
      historyBootstrapMinReady:int(x.historyBootstrapMinReady,AUTO_DEFAULTS.historyBootstrapMinReady,1,200),
      historyBootstrapMaxAttempts:int(x.historyBootstrapMaxAttempts,AUTO_DEFAULTS.historyBootstrapMaxAttempts,1,10),
      historyBootstrapWorkers:int(x.historyBootstrapWorkers,AUTO_DEFAULTS.historyBootstrapWorkers,1,8)
    });
  }

  // Market transport is supplied by BinanceStreamService.
  function startHybridStreams(universe){runtime.streamService.start(universe,['1m','3m']);}
  function stopHybridStreams(){runtime.streamService.stop();}
  function readyCount31(rows){return runtime.streamService.store.readySymbols(rows,['1m','3m']).length;}


  async function bootstrapOneSymbolHistory(row){
    const symbol=row?.symbol;
    if(!symbol)throw new Error('bootstrap symbol missing');
    if(marketDataStore.isReady(symbol,['1m','3m']))return true;

    // Fix8 DATA-ONLY CHANGE:
    // The selection engine requires 300 closed candles on BOTH 1m and 3m.
    // Pull each native timeframe directly from Binance with <500 limit.
    // This preserves the exact 3m/1m algorithm input while avoiding the heavier
    // 1000×1m request previously used only to derive 3m locally.
    const serverTime=currentServerTime();
    const historyLimit=V2_CONFIG.candleLimit+30; // 330

    const [raw1,raw3]=await Promise.all([
      fetchJson(
        `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${historyLimit}`,
        {retries:0,timeout:15000,essential:false}
      ),
      fetchJson(
        `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=3m&limit=${historyLimit}`,
        {retries:0,timeout:15000,essential:false}
      )
    ]);

    if(!Array.isArray(raw1)||!Array.isArray(raw3)){
      const blocked=Math.max(0,(Number(state.rateLimitBlockedUntil)||0)-Date.now());
      if(blocked>0){
        const e=new Error(`REST rate-limit pause ${Math.ceil(blocked/1000)}s`);
        e.rateLimit=true;e.retryDelayMs=blocked;e.status=state.lastRateLimitStatus||429;throw e;
      }
      throw new Error(`history bootstrap unavailable: 1m=${Array.isArray(raw1)?'OK':'NA'} 3m=${Array.isArray(raw3)?'OK':'NA'}`);
    }

    const parse=(raw)=>raw.map(klineToCandle).filter(c=>
      Number.isFinite(c.openTime)&&Number.isFinite(c.closeTime)&&
      [c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)
    );

    const all1=parse(raw1),all3=parse(raw3);
    const closed1=all1.filter(c=>c.closeTime<serverTime);
    const closed3=all3.filter(c=>c.closeTime<serverTime);
    const current1=all1.find(c=>c.openTime<=serverTime&&c.closeTime>=serverTime)||null;
    const current3=all3.find(c=>c.openTime<=serverTime&&c.closeTime>=serverTime)||null;

    if(closed1.length<V2_CONFIG.candleLimit)throw new Error(`1m history ${closed1.length}/${V2_CONFIG.candleLimit}`);
    if(closed3.length<V2_CONFIG.candleLimit)throw new Error(`3m history ${closed3.length}/${V2_CONFIG.candleLimit}`);

    marketDataStore.seedInterval(symbol,'1m',all1,serverTime);
    marketDataStore.seedInterval(symbol,'3m',all3,serverTime);
    return marketDataStore.isReady(symbol,['1m','3m']);
  }

  function historyBootstrapSnapshot(universe){
    const hb=state.historyBootstrap||{};
    const ready=readyCount31(universe);
    return {
      ready,
      pending:Math.max(0,(universe?.length||0)-ready),
      total:universe?.length||0,
      attempted:Number(hb.attempted)||0,
      succeeded:Number(hb.succeeded)||0,
      failed:Number(hb.failed)||0,
      running:hb.running===true,
      completed:hb.completed===true
    };
  }

  function startHistoryBootstrapQueue(universe){
    const rows=Array.isArray(universe)?universe.slice():[];
    const cfg=getAutoSettings();
    const hb={
      running:true,completed:false,attempted:0,succeeded:0,failed:0,
      attempts:new Map(),failures:[],startedAt:Date.now(),
      workers:cfg.historyBootstrapWorkers
    };
    state.historyBootstrap=hb;

    // DATA-LOADING ONLY. Activity-rank order and every SELECT rule remain unchanged.
    void (async()=>{
      const queue=rows.slice();
      const queueLock={}; // synchronous Array.shift() is sufficient in JS event loop.

      autoDiag(
        `HISTORY QUEUE START: ${queue.length} symbols • ${cfg.historyBootstrapWorkers} workers • `+
        `native 1m+3m REST (330 each) • ${cfg.historyBootstrapIntervalMs}ms/worker pacing.`
      );

      async function worker(workerId){
        while(state.running&&!state.controller?.signal.aborted){
          const row=queue.shift();
          if(!row)break;

          const symbol=row?.symbol;
          if(!symbol)continue;
          if(marketDataStore.isReady(symbol,['1m','3m']))continue;

          const blockedFor=Math.max(0,(Number(state.rateLimitBlockedUntil)||0)-Date.now());
          if(blockedFor>0){
            queue.unshift(row);
            autoDiag(
              `HISTORY QUEUE PAUSE W${workerId}: HTTP ${state.lastRateLimitStatus||429} • `+
              `${Math.ceil(blockedFor/1000)}s • ready ${readyCount31(rows)}/${rows.length}`
            );
            await sleep(Math.min(blockedFor+750,60000));
            continue;
          }

          // Proactive soft-throttle if Binance exposes the used-weight response header.
          const weightFresh=Date.now()-(Number(state.usedWeightObservedAt)||0)<15000;
          if(weightFresh&&Number(state.usedWeight1m)>=1400){
            await sleep(5000);
          }else if(weightFresh&&Number(state.usedWeight1m)>=1000){
            await sleep(2000);
          }

          const attempt=(hb.attempts.get(symbol)||0)+1;
          hb.attempts.set(symbol,attempt);
          hb.attempted++;

          try{
            const ok=await bootstrapOneSymbolHistory(row);
            if(ok)hb.succeeded++;
            else throw new Error('history not ready after bootstrap');
          }catch(e){
            if(e.name==='AbortError')break;
            if(e?.rateLimit){
              queue.unshift(row);
            }else if(attempt<cfg.historyBootstrapMaxAttempts){
              queue.push(row);
            }else{
              hb.failed++;
              if(hb.failures.length<30)hb.failures.push(`${symbol}: ${e.message||e}`);
            }
          }

          const snap=historyBootstrapSnapshot(rows);
          progress(
            8+22*snap.ready/Math.max(1,snap.total),
            `History queue • ready ${snap.ready}/${snap.total} • pending ${snap.pending}`
          );

          if(
            hb.attempted<=cfg.historyBootstrapWorkers ||
            hb.attempted%20===0 ||
            snap.ready===cfg.historyBootstrapMinReady ||
            snap.ready===snap.total
          ){
            const weight=Number.isFinite(state.usedWeight1m)?` • usedWeight1m ${state.usedWeight1m}`:'';
            autoDiag(
              `HISTORY QUEUE: ready ${snap.ready}/${snap.total} • pending ${snap.pending} • `+
              `attempts ${hb.attempted} • hard-fail ${hb.failed} • REST total ${state.requestCount}${weight}`
            );
          }

          if(state.running&&!state.controller?.signal.aborted){
            await sleep(cfg.historyBootstrapIntervalMs);
          }
        }
      }

      await Promise.all(
        Array.from({length:cfg.historyBootstrapWorkers},(_,i)=>worker(i+1))
      );

      hb.running=false;hb.completed=true;
      const snap=historyBootstrapSnapshot(rows);
      const elapsed=((Date.now()-hb.startedAt)/1000).toFixed(1);
      autoDiag(
        `HISTORY QUEUE COMPLETE: ready ${snap.ready}/${snap.total} • hard-fail ${hb.failed} • `+
        `REST total ${state.requestCount} • ${elapsed}s`+
        `${hb.failures.length?` • examples: ${hb.failures.slice(0,6).join(' || ')}`:''}`
      );
    })();

    return hb;
  }

  async function waitForMinimumHistoryReady(universe){
    const cfg=getAutoSettings();
    const target=Math.min(cfg.historyBootstrapMinReady,Math.max(1,universe.length));
    const started=Date.now();
    const timeoutMs=Math.max(120000,target*cfg.historyBootstrapIntervalMs*4);

    while(state.running&&!state.controller?.signal.aborted){
      const ready=readyCount31(universe);
      if(ready>=target)return ready;

      // If the queue completed early because all remaining symbols hard-failed,
      // allow the scanner to start with whatever valid history exists.
      if(state.historyBootstrap?.completed&&ready>0)return ready;
      if(Date.now()-started>timeoutMs){
        if(ready>0)return ready;
        throw new Error(`History queue minimum readiness timeout: ${ready}/${target}`);
      }

      const blockedFor=Math.max(0,(Number(state.rateLimitBlockedUntil)||0)-Date.now());
      const msg=blockedFor>0
        ? `History queue rate-limit pause ${Math.ceil(blockedFor/1000)}s • ready ${ready}/${target}`
        : `History queue warming • ready ${ready}/${target}`;
      setStatus(`Auto3m1m: ${msg}`,'info');
      await sleep(500);
    }
    (()=>{const e=new Error('Aborted');e.name='AbortError';throw e;})();
  }

  const state={running:false,cycleRunning:false,controller:null,startedAt:0,requestCount:0,errors:[],results:[],activity:[],context:null,settings:null,thresholds:null,snapshotElapsedMs:null,fundingInfoLoaded:false,activityCache:null,priceLearning:[],gateDiagnostics:null,lastCycleDiag:null,scanSource:SCAN_SOURCE,scanTimeframes:SCAN_TIMEFRAMES,session:null,loopTimer:null,watchTimer:null,watchRows:new Map(),watchStates:new Map(),greenQueue:[],startingFollow:new Set(),autoFollowSymbols:new Set(),premiumCache:null,serverOffsetMs:0,rateLimitBlockedUntil:0,lastRateLimitStatus:0,historyBootstrap:null,usedWeight1m:NaN,usedWeightObservedAt:0};
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
    if(c.liveDirection5m?.blocksSelect||c.liveDirection3m?.blocksSelect)return 'triggerZone';
    if(c.liveDirection1m?.blocksSelect)return 'triggerZone';
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
    // 3m TRANSITION is informational, not an exclusive blocking gate.
    // A TRANSITION row continues through 1m setup -> later 1m confirmation -> trigger -> R/R.
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
    log(`Gate Diagnostics: Universe ${g.fastEvents} | Liquidity ${g.liquidityDrop} | OI ${g.oiDrop} | Data ${g.dataDrop} | Operational ${g.operationalDrop} | Entry ${g.entryAnalyzed} | EntryError ${g.entryError} | 3mTrendBlock ${g.oneHourBlock} | 3mTransition(info) ${g.oneHourTransition} | Fresh/Elder ${g.freshnessElder} | 1mSetup ${g.setup15m} | 1mConfirm ${g.confirm5m} [timing ${d.timing}; 1/3 ${d.score1}; 2/3 ${d.score2}; closedVOLweak ${d.weakClosedVolume}; fail R/M/A ${d.failRsi}/${d.failMacd}/${d.failAtr}] | Trigger/Zone ${g.triggerZone} | R/R ${g.rr} | Soft ${g.softCaution} | SELECT ${g.select}`);
  }
  // This scanner does not read, save, validate, or schedule Scan Settings / Auto 2m.
  function followModule(){return runtime.followGateway||null;}
  let scanPreservedFollowRows=[];

  function captureFollowRowsBeforeScan(){
    const liveRows=followModule()?.getPreservedRows?.();
    scanPreservedFollowRows=Array.isArray(liveRows)?liveRows.filter(r=>r&&typeof r.symbol==='string'):[];
  }

  function log(message){emit('log',{message:String(message??'')});}

  let autoDiagCycle=0;

  function autoDiag(message){emit('diagnostic',{message:String(message??'')});}
  function autoDiagPct(n,total){return total>0?`${n} (${(100*n/total).toFixed(1)}%)`:`${n}`;}
  function autoDiagCountBy(rows,selector){
    const out=new Map();
    for(const r of Array.isArray(rows)?rows:[]){
      const key=String(selector(r)??'UNKNOWN');
      out.set(key,(out.get(key)||0)+1);
    }
    return out;
  }
  function autoDiagMapText(map,preferred=[]){
    const keys=[...new Set([...preferred,...map.keys()])];
    return keys.filter(k=>map.has(k)).map(k=>`${k} ${map.get(k)}`).join(' • ')||'—';
  }
  function autoDiagPrimaryGateSamples(rows,gate,max=4){
    const out=[];
    for(const r of Array.isArray(rows)?rows:[]){
      if(classifyEntryPrimaryGate(r)!==gate)continue;
      const c=r?.chartAnalysis||{};
      let reason='';
      if(gate==='oneHourBlock')reason=c.step7?.reason||'3m downtrend';
      else if(gate==='freshnessElder')reason=(c.entryImpulse?.status==='BEARISH'?entryImpulseReason(c.entryImpulse):entryFreshnessReason(c.entryFreshness));
      else if(gate==='setup15m')reason=c.step8?.reason||'1m setup';
      else if(gate==='confirm5m')reason=c.step9?.reason||'1m confirm';
      else if(gate==='triggerZone')reason=c.step10?.reason||'trigger/zone';
      else if(gate==='rr')reason=`R/R ${Number.isFinite(c.priceLocation?.structuralAsymmetry)?c.priceLocation.structuralAsymmetry.toFixed(2):'NA'}`;
      else reason=c.reason||gate;
      out.push(`${r.symbol}: ${reason}`);
      if(out.length>=max)break;
    }
    return out;
  }
  function autoDiagElderSamples(rows,max=5){
    const out=[];
    for(const r of Array.isArray(rows)?rows:[]){
      const e=r?.chartAnalysis?.entryImpulse;
      if(e?.status!=='BEARISH')continue;
      const es=Number(e.emaSlope),hs=Number(e.histSlope);
      out.push(`${r.symbol}(EMAΔ=${Number.isFinite(es)?es.toExponential(2):'NA'}, HΔ=${Number.isFinite(hs)?hs.toExponential(2):'NA'})`);
      if(out.length>=max)break;
    }
    return out;
  }
  function autoDiagMarketHealth(universe,now=Date.now()){
    let oneLive=0,threeLive=0,bookLive=0,oneMissing=0,threeMissing=0,bookMissing=0;
    for(const x of Array.isArray(universe)?universe:[]){
      const symbol=String(x?.symbol||x||'');if(!symbol)continue;
      const s=marketDataStore.symbols.get(symbol);
      const i1=s?.intervals?.get('1m'),i3=s?.intervals?.get('3m'),b=marketDataStore.books.get(symbol);
      if(i1?.lastEventTime&&now-i1.lastEventTime<=15000)oneLive++;else oneMissing++;
      if(i3?.lastEventTime&&now-i3.lastEventTime<=15000)threeLive++;else threeMissing++;
      if(b?.time&&now-b.time<=15000)bookLive++;else bookMissing++;
    }
    return {oneLive,threeLive,bookLive,oneMissing,threeMissing,bookMissing};
  }
  function autoDiagCycleCore(rows,universeCount){
    const list=(rows||[]).filter(Boolean),n=list.length;
    const primary=autoDiagCountBy(list,classifyEntryPrimaryGate);
    autoDiag(`PRIMARY GATE FUNNEL (${n}/${universeCount} analyzed): 3mDown ${primary.get('oneHourBlock')||0} • Fresh/Elder ${primary.get('freshnessElder')||0} • 1mSetup ${primary.get('setup15m')||0} • 1mConfirm ${primary.get('confirm5m')||0} • Trigger ${primary.get('triggerZone')||0} • R/R ${primary.get('rr')||0} • Soft ${primary.get('softCaution')||0} • ChartSELECT ${primary.get('select')||0} • Error ${primary.get('entryError')||0}`);
    const elder=autoDiagCountBy(list,r=>r?.chartAnalysis?.entryImpulse?.status||'NA');
    const s7=autoDiagCountBy(list,r=>r?.chartAnalysis?.step7?.regime||'NA');
    const s8=autoDiagCountBy(list,r=>r?.chartAnalysis?.step8?.status||'NA');
    const s9=autoDiagCountBy(list,r=>r?.chartAnalysis?.step9?.status||'NA');
    const s10=autoDiagCountBy(list,r=>r?.chartAnalysis?.step10?.status||'NA');
    const rt=new Map([['INTERNAL',n]]);
    autoDiag(`RAW STATES: 3m[${autoDiagMapText(s7,['UPTREND','TRANSITION','DOWNTREND'])}] • Elder[${autoDiagMapText(elder,['BULLISH','NEUTRAL','BEARISH','UNAVAILABLE'])}]`);
    autoDiag(`RAW STATES: 1mSetup[${autoDiagMapText(s8,['PASS','WAIT','BLOCKED','INVALIDATED'])}] • 1mConfirm[${autoDiagMapText(s9,['CONFIRMED','NOT_READY','WAIT'])}] • Trigger[${autoDiagMapText(s10,['READY','WAIT','TOO_LATE','SKIP_CHASE','INVALIDATED'])}] • AutoWatch[${autoDiagMapText(rt,['INTERNAL'])}]`);
    const bear=elder.get('BEARISH')||0;
    if(bear)autoDiag(`ELDER BEARISH raw ${autoDiagPct(bear,n)}; examples: ${autoDiagElderSamples(list).join(' • ')||'—'}`);
    for(const [gate,label] of [['oneHourBlock','3mDown'],['freshnessElder','Fresh/Elder'],['setup15m','1mSetup'],['confirm5m','1mConfirm'],['triggerZone','Trigger'],['rr','R/R']]){
      const samples=autoDiagPrimaryGateSamples(list,gate,3);
      if(samples.length)autoDiag(`${label} primary examples: ${samples.join(' || ')}`);
    }
  }
  function setStatus(text,className='info'){emit('status',{text:String(text??''),className});}
  function progress(value,text=''){emit('progress',{value:Number(value)||0,text:String(text??'')});}
  function setButtons(running){emit('controls',{running:!!running});}
  function resetScanState(){
    state.errors=[];
    state.results=[];
    state.activity=[];
    state.context=null;
    state.thresholds=null;
    state.snapshotElapsedMs=null;
    state.requestCount=0;
    state.fundingInfoLoaded=false;
    state.lastCycleDiag=null;
    resetBaseDropDiagnostics();
  }
  function resetUI(){emit('reset');}
  function clearMarketContext(message='Bu scan için hesaplanmadı.'){state.context=null;emit('context-clear',{message});}

  function activityCacheAgeMs(){
    return state.activityCache?Date.now()-state.activityCache.createdAt:Infinity;
  }

  function formatCacheAge(ms){
    if(!Number.isFinite(ms)||ms<0)return '—';
    const totalSec=Math.floor(ms/1000),m=Math.floor(totalSec/60),s=totalSec%60;
    return `${m}m ${String(s).padStart(2,'0')}s`;
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



  // Fast Event Watch intentionally removed from the direct 3m/1m scanner.

  function priceFmt(x){
    if(!Number.isFinite(x))return '—';
    const a=Math.abs(x),d=a>=1000?2:a>=1?4:a>=0.01?6:8;
    return x.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
  }
  function updateLearningStatus(){emit('learning-status',{completed:state.priceLearning.filter(x=>x.completed).length,pending:state.priceLearning.filter(x=>!x.completed).length});}

  function validLearningObservation(x){
    return !!x&&typeof x.id==='string'&&typeof x.symbol==='string'&&Number.isFinite(Number(x.entryTime))&&Number.isFinite(Number(x.entryPrice))&&x.entryPrice>0;
  }

  function loadPriceLearning(){
    state.priceLearning=[];
    try{
      const raw=storage.getItem(PRICE_LEARNING_KEY);if(!raw){updateLearningStatus();return;}
      const parsed=JSON.parse(raw);if(parsed?.version!==PRICE_LEARNING_VERSION||!Array.isArray(parsed.observations)){storage.removeItem(PRICE_LEARNING_KEY);updateLearningStatus();return;}
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

  async function getForwardPrimaryKlines(symbol,entryTime){
    const start=Math.floor((entryTime+1)/180000)*180000;
    const end=entryTime+MAX_HOLD_MS;
    const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=3m&startTime=${start}&endTime=${end}&limit=100`,{retries:2,timeout:15000});
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
      const candles=await getForwardPrimaryKlines(obs.symbol,Number(obs.entryTime));
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
    const id=`${row.symbol}|${Number(chart.step8?.setupTime)||0}|${Number(chart.step9?.firstConfirmationTime)||0}`;
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
    // 3m is the PRIMARY structure in this scanner.
    // Therefore hard R/R target/resistance must come from 3m structure.
    // 1m is the setup/entry timeframe; its micro swing highs are intentionally
    // NOT used as hard profit targets because they sit too close to price and
    // can make every otherwise-valid early entry appear to have R/R < 1.
    const t5=c5.length-1,atr5=i5.atr14[t5];
    const hPrimary=findSwings(c5,V2_CONFIG.swingLeft,V2_CONFIG.swingRight);
    const hSetup=findSwings(c3,V2_CONFIG.swingLeft,V2_CONFIG.swingRight);

    const resist=[],support=[],microResist=[],microSupport=[];

    // Hard structural levels: PRIMARY 3m only.
    for(const x of hPrimary.highs.slice(-8))resist.push({price:x.price,weight:3,source:'3m Swing High'});
    for(const x of hPrimary.lows.slice(-8))support.push({price:x.price,weight:3,source:'3m Swing Low'});

    // 1m swings remain diagnostic/context only; they do not cap hard R/R.
    for(const x of hSetup.highs.slice(-10))microResist.push({price:x.price,weight:1,source:'1m Micro Swing High'});
    for(const x of hSetup.lows.slice(-10))microSupport.push({price:x.price,weight:1,source:'1m Micro Swing Low'});

    if(step7?.regime==='RANGE'&&c5.length>=V2_CONFIG.breakoutLookback){
      const recent=c5.slice(-V2_CONFIG.breakoutLookback),rh=Math.max(...recent.map(c=>c.high)),rl=Math.min(...recent.map(c=>c.low));
      resist.push({price:rh,weight:2.5,source:'3m Range Upper'});
      support.push({price:rl,weight:2.5,source:'3m Range Lower'});
    }

    // Setup levels belong on the risk/invalidation side, not on the hard upside target side.
    if(step8?.setup==='PULLBACK_VALUE'){
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'1m Value Low'});
      if(Number.isFinite(step8.ema25))support.push({price:step8.ema25,weight:2,source:'1m EMA25'});
    }
    if(step8?.setup==='BREAKOUT_RETEST'){
      if(Number.isFinite(step8.rangeHigh))support.push({price:step8.rangeHigh,weight:3,source:'1m Breakout/Retest Level'});
      if(Number.isFinite(step8.entryZoneLow))support.push({price:step8.entryZoneLow,weight:2.5,source:'1m Retest Low'});
    }

    const rc=clusterPriceLevels(resist,atr5).filter(x=>x.price>currentPrice).sort((a,b)=>a.price-b.price);
    const sc=clusterPriceLevels(support,atr5).filter(x=>x.price<currentPrice).sort((a,b)=>b.price-a.price);
    const mrc=clusterPriceLevels(microResist,atr5).filter(x=>x.price>currentPrice).sort((a,b)=>a.price-b.price);
    const msc=clusterPriceLevels(microSupport,atr5).filter(x=>x.price<currentPrice).sort((a,b)=>b.price-a.price);

    return {
      atr5,
      resistance:rc[0]||null,
      support:sc[0]||null,
      resistanceClusters:rc,
      supportClusters:sc,
      microResistance:mrc[0]||null,
      microSupport:msc[0]||null,
      microResistanceClusters:mrc,
      microSupportClusters:msc
    };
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
    nearestMicroResistance:structural.microResistance?.price??NaN,
    nearestMicroResistanceSources:structural.microResistance?.sources||[],
    nearestMicroSupport:structural.microSupport?.price??NaN,
    nearestMicroSupportSources:structural.microSupport?.sources||[],
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

      const blockedFor=Math.max(0,(Number(state.rateLimitBlockedUntil)||0)-Date.now());
      if(blockedFor>0){
        const err=new Error(`Binance REST rate-limit beklemesi aktif (${Math.ceil(blockedFor/1000)}s)`);
        err.status=state.lastRateLimitStatus||418;
        err.rateLimit=true;
        err.retryDelayMs=blockedFor;
        if(essential)throw err;
        return null;
      }

      const timeoutController=new AbortController();
      const timer=setTimeout(()=>timeoutController.abort(),timeout);
      const onAbort=()=>timeoutController.abort();
      state.controller?.signal.addEventListener('abort',onAbort,{once:true});
      try{
        state.requestCount++;
        const res=await fetch(url,{signal:timeoutController.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(res.status===418||res.status===429){
          const retryAfterRaw=res.headers.get('Retry-After');
          const retryAfter=Number(retryAfterRaw);
          const waitMs=Number.isFinite(retryAfter)&&retryAfter>0
            ? retryAfter*1000
            : (res.status===418 ? 60_000 : 5_000*Math.pow(2,attempt));

          state.lastRateLimitStatus=res.status;
          state.rateLimitBlockedUntil=Math.max(Number(state.rateLimitBlockedUntil)||0,Date.now()+waitMs);

          const err=new Error(
            res.status===418
              ? `HTTP 418 — Binance geçici IP banı; REST ${Math.ceil(waitMs/1000)}s durduruldu`
              : `HTTP 429 — Binance rate limit; REST ${Math.ceil(waitMs/1000)}s durduruldu`
          );
          err.status=res.status;
          err.rateLimit=true;
          err.retryDelayMs=waitMs;

          // 418 MUST NOT be retried immediately. Repeated calls can extend the ban.
          if(res.status===418)throw err;

          // 429 may retry only after Retry-After/backoff.
          if(attempt<retries){
            log(`HTTP 429: ${Math.ceil(waitMs/1000)}s bekleniyor; yeni REST isteği gönderilmeyecek.`);
            await sleep(waitMs);
            continue;
          }
          throw err;
        }
        const usedWeight=Number(res.headers.get('X-MBX-USED-WEIGHT-1M')||res.headers.get('x-mbx-used-weight-1m'));
        if(Number.isFinite(usedWeight)){
          state.usedWeight1m=usedWeight;
          state.usedWeightObservedAt=Date.now();
        }
        if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      }catch(e){
        lastErr=e;
        if(e.name==='AbortError'&&state.controller?.signal.aborted) throw e;

        // Never loop/retry an IP ban.
        if(e?.status===418)break;

        if(attempt<retries&&!e?.rateLimit){
          await sleep(450*Math.pow(2,attempt));
        }
      }finally{
        clearTimeout(timer);
        state.controller?.signal.removeEventListener('abort',onAbort);
      }
    }

    const msg=`API failed: ${url} → ${lastErr?.message||lastErr}`;
    state.errors.push(msg);log(msg);
    if(essential){
      if(lastErr&&typeof lastErr==='object'){
        lastErr.message=msg;
        throw lastErr;
      }
      throw new Error(msg);
    }
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
    // P10 supplies the lower-tail location; 3× the coin's own typical absolute 5m OI move
    // prevents a tiny first negative print from being mislabeled as "severe" after a one-sided rising history.
    const severeThreshold=Number.isFinite(p10_5m)&&Number.isFinite(medianAbs5m)?Math.min(p10_5m,-3*medianAbs5m):p10_5m;
    const severeDrop=Number.isFinite(delta5)&&delta5<0&&Number.isFinite(severeThreshold)&&delta5<=severeThreshold;
    const bothDown=Number.isFinite(delta5)&&Number.isFinite(delta15)&&delta5<0&&delta15<0;
    const status=severeDrop?'SEVERE_DOWN':bothDown?'DOWN':(Number.isFinite(delta5)&&Number.isFinite(delta15)?'OK':'UNAVAILABLE');
    return {delta5,delta15,p10_5m,medianAbs5m,severeThreshold,severeDrop,bothDown,status};
  }



  async function analyzeFastMoveContext(symbol,refTime,serverTime){
    try{
      const snap=await marketDataStore.getSnapshot(symbol,'1m',serverTime),closed=snap.closed,live=snap.current;
      if(closed.length<20)return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:`cached completed 1m volume candles ${closed.length}/20`}};
      const reference=closed.slice(-20).map(c=>c.quoteVolume).filter(x=>Number.isFinite(x)&&x>=0);
      if(reference.length<20)return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:'cached 1m quote-volume reference incomplete'}};
      let projected=NaN;
      if(live&&Number.isFinite(live.quoteVolume)){
        const elapsed=clamp((serverTime-live.openTime)/60000,.20,1);projected=live.quoteVolume/elapsed;
      }else projected=closed.at(-1)?.quoteVolume;
      const avg=mean(reference),p25=percentile(reference,.25),rank=percentileRank(projected,reference),ratio=avg>0?projected/avg:NaN;
      if(![projected,p25,rank,ratio].every(Number.isFinite))return {fastVolume:{status:'UNAVAILABLE',ratio,rank,projectedQuoteVolume:projected,p25,reason:'cached 1m fast-volume context incomplete'}};
      const weak=projected<p25;
      return {fastVolume:{status:weak?'WEAK':'OK',ratio,rank,projectedQuoteVolume:projected,p25,reason:weak?'projected current 1m quote volume < own recent P25':'fast volume supported by own recent distribution'}};
    }catch(e){
      if(e.name==='AbortError')throw e;
      return {fastVolume:{status:'UNAVAILABLE',ratio:NaN,rank:NaN,projectedQuoteVolume:NaN,p25:NaN,reason:e.message||String(e)}};
    }
  }

  // 1h/15m trend helpers are not used in the 3m/1m variant.

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



  function analyzePrimaryElderImpulse(recent){
    if(!recent||!Array.isArray(recent.candles)||recent.candles.length<35)return {status:'UNAVAILABLE',reason:'insufficient completed 3m candles'};
    const candles=recent.candles,t=candles.length-1,closes=candles.map(c=>c.close);
    const ema13=emaSeries(closes,13),macd=recent.ind?.macd||macdSeries(closes);
    const emaNow=ema13[t],emaPrev=ema13[t-1],histNow=macd?.hist?.[t],histPrev=macd?.hist?.[t-1];
    if(![emaNow,emaPrev,histNow,histPrev].every(Number.isFinite))return {status:'UNAVAILABLE',reason:'3m EMA13/MACD-H inputs incomplete'};
    const emaSlope=emaNow-emaPrev,histSlope=histNow-histPrev;
    const status=emaSlope<0&&histSlope<0?'BEARISH':emaSlope>0&&histSlope>0?'BULLISH':'NEUTRAL';
    return {status,ema13:emaNow,ema13Prev:emaPrev,emaSlope,macdHist:histNow,macdHistPrev:histPrev,histSlope,
      reason:status==='BEARISH'?'EMA13 slope DOWN + MACD-H slope DOWN':status==='BULLISH'?'EMA13 slope UP + MACD-H slope UP':'EMA13 and MACD-H slopes are mixed'};
  }

  function entryImpulseReason(x){
    if(!x||x.status==='UNAVAILABLE')return `3m Elder Impulse UNAVAILABLE — ${x?.reason||'unknown'}`;
    if(x.status==='BEARISH')return '3m Elder Impulse BEARISH — EMA13 slope DOWN + MACD-H slope DOWN';
    if(x.status==='BULLISH')return '3m Elder Impulse BULLISH — EMA13 slope UP + MACD-H slope UP';
    return '3m Elder Impulse NEUTRAL — EMA13 / MACD-H slopes mixed';
  }


async function analyzeEntryFreshnessFromData(symbol,currentPrice,serverTime,candles,ind){
  const cfg=ENTRY_FRESHNESS_CONFIG;
  try{
    if(!Array.isArray(candles)||candles.length<cfg.recentMinBars||!ind){
      return {status:'UNAVAILABLE',ready:false,n:0,impulse:{status:'UNAVAILABLE',reason:'recent 3m history unavailable'},reason:`recent 3m history ${Array.isArray(candles)?candles.length:0}/${cfg.recentMinBars}`};
    }
    const recent={candles,ind,hl:activeConfirmedHL(candles,ind,candles.length-1)};
    const impulse=analyzePrimaryElderImpulse(recent);
    const t=candles.length-1,hl=recent.hl;
    const value=entryValueExtensionFeature(candles,ind,t,currentPrice);
    if(!value)return {status:'UNAVAILABLE',ready:false,n:0,impulse,reason:'3m freshness inputs incomplete'};
    const current=hl?entryFreshnessFeature(candles,ind,t,hl.price,currentPrice):null;
    const hlPrice=hl?.price??NaN,hlExtension=current?.hlExtension??NaN;

    if(value.valueExtension<=V2_CONFIG.noChaseAtrPrimary){
      return {status:'FRESH',ready:true,n:0,impulse,hlPrice,hlExtension,valueExtension:value.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,
        reason:value.valueExtension<=0?'price is inside/at 3m value zone':`3m value extension ${value.valueExtension.toFixed(2)} ATR <= ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR limit${hl?'':' (no active HL required)'}`};
    }

    if(!hl||!current){
      return {status:'WAIT_EXTENDED',ready:false,n:0,impulse,needsModel:false,refreshNeeded:false,hlPrice,hlExtension,valueExtension:value.valueExtension,
        medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`3m value extension ${value.valueExtension.toFixed(2)} ATR > ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR and no active confirmed HL exists for analog matching`};
    }

    // Auto hot-path: Step10 hard-blocks valueExtension > noChaseAtrPrimary anyway.
    // Do not spend a per-symbol REST request calibrating a historical model for a row
    // that cannot become FINAL SELECT in this cycle. This preserves SELECT behavior.
    return {status:'WAIT_EXTENDED',ready:false,n:0,impulse,needsModel:false,refreshNeeded:false,hlPrice:hl.price,hlExtension:current.hlExtension,valueExtension:current.valueExtension,
      medianMfeAtr:NaN,medianMaeAtr:NaN,asymmetry:NaN,reason:`3m value extension ${current.valueExtension.toFixed(2)} ATR > ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR no-chase limit`};
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
      ?`Entry Freshness WAIT_EXTENDED — 3m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`
      :`Entry Freshness WAIT_EXTENDED — ${x.reason||`ValueExt ${v} ATR`}`;
    if(x.status==='FAVORABLE')return `Entry Freshness FAVORABLE — 3m HLext ${h} ATR, ValueExt ${v} ATR, n=${x.n}, median MFE ${mfe} ATR, MAE ${mae} ATR, asymmetry ${a}`;
    if(x.status==='FRESH')return `Entry Freshness FRESH — ${x.reason||`ValueExt ${v} ATR`}${Number.isFinite(x.hlExtension)?`, HLext ${h} ATR`:''}`;
    if(x.status==='CALIBRATING')return `Entry Freshness CALIBRATING — ${x.reason}`;
    if(x.status==='NO_ACTIVE_HL')return 'Entry Freshness CALIBRATING — no active confirmed 3m HL';
    return `Entry Freshness UNAVAILABLE — ${x.reason||'unknown'}`;
  }

async function candidateDetails(row,refTime,serverTime,premiumMap,fundingInfoMap,thresholds,bookMap,trace=null){
  const symbol=row.symbol;
  const reject=reason=>{recordBaseDrop(reason);if(trace)trace.reason=reason;return null;};
  // Bulk bookTicker and bulk premiumIndex are shared across Entry-Ready candidates.
  // Only symbol-specific data that has no useful bulk equivalent is requested here.
  const liveBook=bookMap?.get(symbol)||null;
  const liveSpread=spreadPct(liveBook),mid=(num(liveBook?.bidPrice)+num(liveBook?.askPrice))/2;
  const decisionPrice=Number.isFinite(mid)&&mid>0?mid:row.snapshot2;
  if(!Number.isFinite(liveSpread)||!(decisionPrice>0)){return reject('bulk book/spread unavailable');}
  if(Number.isFinite(thresholds.spreadP90)&&liveSpread>thresholds.spreadP90){return reject('spread > p90');}

  const p=premiumMap.get(symbol)||{};
  const fundingRate=num(p.lastFundingRate),mark=num(p.markPrice),index=num(p.indexPrice),nextFunding=Number(p.nextFundingTime)||NaN;
  const premiumPct=mark>0&&index>0?(mark/index-1)*100:NaN;
  let intervalHours=NaN;
  if(state.fundingInfoLoaded){const fi=fundingInfoMap.get(symbol);intervalHours=fi?num(fi.fundingIntervalHours):8;}
  const fundingClock=Math.max(serverTime,Number(p.time)||0);
  const timeToFunding=Number.isFinite(nextFunding)?Math.max(0,nextFunding-fundingClock):NaN;
  const fundingProx=Number.isFinite(timeToFunding)&&intervalHours>0?timeToFunding/(intervalHours*3600000):NaN;
  const fundingExposure=Number.isFinite(timeToFunding)&&timeToFunding<=MAX_HOLD_MS;
  if(![fundingRate,premiumPct,timeToFunding,fundingProx].every(Number.isFinite)){return reject('funding/premium timing unavailable');}

  // Stage 1: three requests only. These can hard-fail the candidate before Taker + Depth are requested.
  const [moveContext,oiHist,freshOi]=await Promise.all([
    analyzeFastMoveContext(symbol,refTime,serverTime),
    fetchJson(`${BASE}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=5m&limit=55`,{retries:2}),
    fetchJson(`${BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,{retries:2})
  ]);

  const fastVolume=moveContext?.fastVolume;
  const liveOiQty=num(freshOi?.openInterest);
  const oiShort=shortOiMetrics(oiHist,liveOiQty,refTime);
  const liveOiNotional=liveOiQty>0&&mark>0?liveOiQty*mark:NaN;
  const volumeOiRatio=liveOiNotional>0?row.quoteVolume/liveOiNotional:NaN;

  const stage1Fields={liveOiQty,liveOiNotional,volumeOiRatio,deltaOi5:oiShort.delta5,deltaOi15:oiShort.delta15,oi5P10:oiShort.p10_5m};
  const missingStage1=Object.entries(stage1Fields).filter(([,v])=>!Number.isFinite(v)).map(([k])=>k);
  if(missingStage1.length){return reject(`detail data unavailable: ${missingStage1.slice(0,3).join(',')}`);}
  if(fastVolume?.status==='UNAVAILABLE'){return reject('fast volume unavailable');}
  if(oiShort.severeDrop){return reject('severe OI 5m drop');}

  // Stage 2 only for candidates that survived the hard Stage-1 gates.
  const [taker,freshDepth]=await Promise.all([
    fetchJson(`${BASE}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=5m&limit=3`,{retries:2}),
    fetchJson(`${BASE}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=50`,{retries:2})
  ]);
  let buy=0,sell=0;
  if(Array.isArray(taker))for(const t of taker){buy+=num(t.buyVol)||0;sell+=num(t.sellVol)||0;}
  const takerRatio=sell>0?buy/sell:NaN;
  if(!Number.isFinite(takerRatio)){return reject('taker B/S unavailable');}
  const liveDepth=depthMetrics(freshDepth,decisionPrice).depth;
  if(!Number.isFinite(liveDepth)){return reject('depth unavailable');}
  const fundingExtreme=Number.isFinite(thresholds.fundingP90)&&fundingRate>0&&fundingRate>thresholds.fundingP90;

  // Real 10bps depth and OI-notional percentiles are finalized AFTER all surviving
  // Entry-Ready candidates have been measured. This preserves the gates without
  // paying two heavy requests for every symbol in the full universe.
  const reasons=[],cautions=[];
  if(Number.isFinite(thresholds.spreadP75)&&liveSpread>thresholds.spreadP75)cautions.push('spread > p75');
  if(oiShort.bothDown)cautions.push(`OI 5m/15m both DOWN (${pct(oiShort.delta5)} / ${pct(oiShort.delta15)})`);
  if(fastVolume?.status==='WEAK')cautions.push(`fast volume weak (rank ${fmt(fastVolume.rank,0)}p, ratio ${fmt(fastVolume.ratio,2)}x)`);
  if(!(takerRatio>=1))cautions.push('taker B/S < 1');
  if(fundingExposure&&fundingExtreme)cautions.push('funding settlement + elevated positive funding');

  reasons.push(...cautions);
  const marketContext=state.context?.result;
  if(marketContext)reasons.push(`market ${marketContext} context (info only)`);
  reasons.push(`OI 5m ${pct(oiShort.delta5)} / 15m ${pct(oiShort.delta15)}`);
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
  log(`Entry-ready profile: depth n=${depthVals.length} P10=${money(thresholds.depthP10)} P25=${money(thresholds.depthP25)}; OI-notional n=${oiVals.length} P75=${money(thresholds.oiNotionalP75)}.`);

  const out=[];
  for(const r of source){
    if(Number.isFinite(thresholds.depthP10)&&Number.isFinite(r.liveDepth)&&r.liveDepth<thresholds.depthP10){recordBaseDrop('depth < entry-ready p10');continue;}
    const cautions=Array.isArray(r.baseCautions)?r.baseCautions.slice():[];
    if(Number.isFinite(thresholds.depthP25)&&Number.isFinite(r.liveDepth)&&r.liveDepth<thresholds.depthP25)cautions.push('depth < entry-ready p25');
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
    else if(interval==='3m'&&bodyAtr<=-LIVE_CANDLE_CONFIG.strongDownAtrPrimary)status='STRONG_DOWN';
    else if(bodyAtr<=-LIVE_CANDLE_CONFIG.neutralAtr)status='DOWN';
    const blocksSelect=interval==='3m'?status==='STRONG_DOWN':interval==='1m'?(status==='DOWN'||status==='STRONG_DOWN'):false;
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


function analyzeStep8(candles,ind,step7){
  const t=candles.length-1;
  if(step7.regime==='DOWNTREND')return {status:'BLOCKED',setup:'NONE',reason:'Step 7 3m DOWNTREND — LONG blocked'};

  // IMPORTANT:
  // In the original 5m->3m->1m scanner Step 8 runs on 3m candles.
  // Moving Step 8 to 1m must preserve the SAME wall-clock windows,
  // otherwise the setup becomes 3x narrower and SELECT almost disappears.
  const SETUP_TF_SCALE=3; // original setup TF 3m -> new setup TF 1m
  const setupPullbackLookback=V2_CONFIG.pullbackLookback*SETUP_TF_SCALE;   // 5x3m = 15m -> 15x1m
  const setupBreakoutLookback=V2_CONFIG.breakoutLookback*SETUP_TF_SCALE; // 20x3m = 60m -> 60x1m
  const setupRetestMaxBars=V2_CONFIG.retestMaxBars*SETUP_TF_SCALE;       // 4x3m = 12m -> 12x1m
  const setupVolumeSma=V2_CONFIG.volumeSma*SETUP_TF_SCALE;               // breakout volume context: 20x3m = 60m
  const setupSearchCushion=4*SETUP_TF_SCALE;

  // No Fast Event / Scan Settings timing exists in this scanner.
  // Preserve the original Step-8 validity window: 2 completed 3m bars = 6 minutes.
  const maxSetupAgeMs=V2_CONFIG.triggerValidBars*3*60*1000;
  const referenceTime=Number(candles[t]?.closeTime);
  const timingFor=setupTime=>{
    const st=Number(setupTime);
    if(!Number.isFinite(referenceTime))return {ok:false,kind:'NO_REFERENCE_TIME',reason:'latest completed 1m close time unavailable'};
    if(!Number.isFinite(st))return {ok:false,kind:'NO_SETUP_TIME',reason:'1m setup time unavailable'};
    if(st>referenceTime)return {ok:false,kind:'FUTURE_SETUP',ageMs:st-referenceTime,reason:'1m setup time is after latest completed 1m candle'};
    const ageMs=referenceTime-st;
    if(ageMs>maxSetupAgeMs)return {ok:false,kind:'STALE',ageMs,reason:`1m setup stale: ${Math.round(ageMs/60000)}m old > ${V2_CONFIG.triggerValidBars*3}m preserved setup window`};
    return {ok:true,kind:'VALID',ageMs,reason:`1m setup recent: ${Math.round(ageMs/60000)}m old`};
  };

  const pullbackSetup=()=>{
    let setupIndex=-1,setupZoneLow=NaN,setupZoneHigh=NaN,setupEma25=NaN,setupTiming=null,lastTimingReject=null;
    const scanStart=Math.max(1,t-setupPullbackLookback+1);
    for(let i=scanStart;i<=t;i++){
      const a=ind.atr14[i],e7=ind.ema7[i],e25=ind.ema25[i];if(![a,e7,e25].every(Number.isFinite))continue;
      const valueLow=Math.min(e7,e25)-V2_CONFIG.valueAtr*a,valueHigh=Math.max(e7,e25)+V2_CONFIG.valueAtr*a;
      let wasAbove=false;
      for(let j=Math.max(0,i-setupPullbackLookback);j<i&&!wasAbove;j++){
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
      if(deep)return {status:'INVALIDATED',setup:'INVALID_PULLBACK',reason:'current 1m close below deep-pullback limit'};
      if(lastTimingReject)return {status:'WAIT',setup:lastTimingReject.timing.kind==='STALE'?'STALE_SETUP':'TIMING_WAIT',reason:lastTimingReject.timing.reason,setupTime:lastTimingReject.setupTime,setupAgeMs:lastTimingReject.timing.ageMs,maxSetupAgeMs};
      return {status:'WAIT',setup:'NONE',reason:'no valid recent 1m pullback into EMA7–EMA25 value area'};
    }
    for(let j=setupIndex+1;j<=t;j++){
      const a=ind.atr14[j],e25=ind.ema25[j];if(![a,e25].every(Number.isFinite))continue;
      if(candles[j].close<e25-V2_CONFIG.deepPullbackAtr*a)return {status:'INVALIDATED',setup:'INVALID_PULLBACK',reason:'pullback invalidated below EMA25 - 0.50 ATR1',entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr3:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex,setupAgeMs:setupTiming?.ageMs,maxSetupAgeMs};
    }
    return {status:'PASS',setup:'PULLBACK_VALUE',reason:`valid recent 1m pullback; ${setupTiming?.reason||'setup timing valid'}`,entryZoneLow:setupZoneLow,entryZoneHigh:setupZoneHigh,atr3:ind.atr14[t],ema25:setupEma25,setupTime:candles[setupIndex].closeTime,setupIndex,setupAgeMs:setupTiming?.ageMs,maxSetupAgeMs};
  };

  const breakoutSetup=()=>{
    let pending=null,failed=null,lastTimingReject=null;
    const firstBreak=Math.max(setupBreakoutLookback,t-(setupBreakoutLookback+setupRetestMaxBars+setupSearchCushion));
    for(let b=t;b>=firstBreak;b--){
      const a=ind.atr14[b];if(!Number.isFinite(a))continue;
      const rangeHigh=Math.max(...candles.slice(b-setupBreakoutLookback,b).map(c=>c.high));
      const volAvg=mean(candles.slice(b-setupVolumeSma,b).map(c=>c.volume));
      if(!(candles[b].close>rangeHigh+V2_CONFIG.breakoutAtr*a&&candles[b].volume>volAvg))continue;
      const retestLow=rangeHigh-V2_CONFIG.retestAtr*a,retestHigh=rangeHigh+V2_CONFIG.retestAtr*a;
      let retestIndex=-1,invalid=false;
      const end=Math.min(t,b+setupRetestMaxBars);
      for(let j=b+1;j<=end;j++){
        if(candles[j].close<retestLow){invalid=true;break;}
        const touch=candles[j].low<=retestHigh&&candles[j].high>=retestLow;
        if(touch&&candles[j].close>=rangeHigh){retestIndex=j;break;}
      }
      if(invalid){failed={status:'INVALIDATED',setup:'FAILED_BREAKOUT',reason:'recent breakout retest closed below failure boundary',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t]};continue;}
      if(retestIndex<0){
        pending={status:'WAIT',setup:'WAIT_RETEST',reason:'recent 1m breakout valid; retest not completed within current window',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t]};
        continue;
      }
      let broke=false;
      for(let j=retestIndex+1;j<=t;j++)if(candles[j].close<retestLow){broke=true;break;}
      if(broke){failed={status:'INVALIDATED',setup:'FAILED_BREAKOUT',reason:'breakout/retest invalidated after retest',rangeHigh,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t],setupTime:candles[retestIndex].closeTime,retestIndex};continue;}
      const timing=timingFor(candles[retestIndex].closeTime);
      if(!timing.ok){lastTimingReject={timing,setupTime:candles[retestIndex].closeTime};continue;}
      return {status:'PASS',setup:'BREAKOUT_RETEST',reason:`valid recent 1m breakout + volume + retest; ${timing.reason}`,rangeHigh,retestIndex,entryZoneLow:retestLow,entryZoneHigh:retestHigh,atr3:ind.atr14[t],setupTime:candles[retestIndex].closeTime,setupIndex:retestIndex,setupAgeMs:timing.ageMs,maxSetupAgeMs};
    }
    if(pending)return pending;
    if(failed)return failed;
    if(lastTimingReject)return {status:'WAIT',setup:lastTimingReject.timing.kind==='STALE'?'STALE_SETUP':'TIMING_WAIT',reason:lastTimingReject.timing.reason,setupTime:lastTimingReject.setupTime,setupAgeMs:lastTimingReject.timing.ageMs,maxSetupAgeMs};
    return {status:'WAIT',setup:'NONE',reason:'no valid recent 1m breakout + volume + retest setup'};
  };

  if(step7.regime==='UPTREND')return pullbackSetup();
  if(step7.regime==='RANGE')return breakoutSetup();

  const p=pullbackSetup(),b=breakoutSetup(),passes=[p,b].filter(x=>x.status==='PASS');
  if(passes.length){
    const chosen=passes.sort((a,b)=>Number(b.setupTime||0)-Number(a.setupTime||0))[0];
    return {...chosen,transition:true,reason:`3m TRANSITION; ${chosen.reason}`};
  }
  if(p.status==='INVALIDATED'&&b.status==='INVALIDATED')return {status:'INVALIDATED',setup:'NONE',reason:`3m TRANSITION; both setup families invalidated (${p.setup}, ${b.setup})`};
  const timingWait=[p,b].find(x=>x.setup==='STALE_SETUP'||x.setup==='TIMING_WAIT');
  if(timingWait)return {...timingWait,transition:true,reason:`3m TRANSITION; ${timingWait.reason}`};
  return {status:'WAIT',setup:'NONE',transition:true,reason:'3m TRANSITION; no valid current 1m setup'};
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
  // Use the latest fully closed 1m candle without waiting for a post-Fast-Event close,
  // and it must be a later closed candle than the 1m setup candle; the same candle cannot confirm itself.
  if(t<1)return {status:'WAIT',score:'—',passed:NaN,mandatoryPassed:false,timingPending:false,reason:'completed 1m candle unavailable',checks:{}};
  const setupTime=Number(step8.setupTime),confirmationTime=Number(candles[t]?.closeTime);
  if(Number.isFinite(setupTime)&&Number.isFinite(confirmationTime)&&confirmationTime<=setupTime){
    return {status:'WAIT',score:'—',passed:NaN,mandatoryPassed:false,timingPending:true,reason:'latest completed 1m candle is not later than the 1m setup candle',checks:{},firstConfirmationIndex:-1,firstConfirmationTime:NaN};
  }
  const checks=step9ChecksAt(candles,ind,t);
  const qualityKeys=['rsi','macd','atr'];
  const passed=qualityKeys.filter(k=>checks[k]?.pass).length;
  const failed=qualityKeys.filter(k=>!checks[k]?.pass).map(k=>k.toUpperCase());
  // Same confirmation rule as StartScan: any 1 of RSI / MACD / ATR is sufficient.
  const confirmed=passed>=1;
  const status=confirmed?'CONFIRMED':'WAIT';
  const volumeNote=checks.volume?.pass?'closed-1m VOL supportive':'closed-1m VOL weak (info only)';
  const reason=confirmed
    ?`current completed 1m ${passed}/3 confirmed; at least 1 of RSI/MACD/ATR PASS; ${volumeNote}`
    :`current completed 1m 0/3; RSI/MACD/ATR all failed; CAUTION; ${volumeNote}`;
  return {status,score:`${passed}/3`,passed,mandatoryPassed:true,supportPassed:confirmed,timingPending:false,reason,checks,firstConfirmationIndex:confirmed?t:-1,firstConfirmationTime:confirmed?candles[t].closeTime:NaN};
}


function analyzeStep10(candles1,ind1,candles3,ind3,step8,step9,currentPrice,entryFreshness){
  if(step8.status!=='PASS')return {status:'NOT_RUN',reason:'Step 8 is not PASS'};
  const t3=candles3.length-1,t1=candles1.length-1,atr3=ind3.atr14[t3],current3Close=candles3[t3].close;
  if(step8.setup==='PULLBACK_VALUE'){
    const invalidLine=ind3.ema25[t3]-V2_CONFIG.deepPullbackAtr*atr3;
    if(current3Close<invalidLine)return {status:'INVALIDATED',reason:'1m pullback invalidated below EMA25 - 0.50 ATR1'};
  }else if(step8.setup==='BREAKOUT_RETEST'){
    if(current3Close<step8.entryZoneLow)return {status:'INVALIDATED',reason:'1m breakout/retest invalidated below retest zone'};
  }
  if(step9.status!=='CONFIRMED')return {status:'WAIT',reason:'current completed 1m confirmation is not valid (at least 1 of RSI/MACD/ATR must PASS)'};
  const px=Number.isFinite(currentPrice)&&currentPrice>0?currentPrice:candles1[t1].close;
  const lower=step8.entryZoneLow;
  if(px<lower)return {status:'WAIT',reason:'current price is below 1m entry-zone lower boundary',currentPrice:px};

  // Same no-chase rule, now anchored to the primary 3m structure.
  const valueExtension=Number(entryFreshness?.valueExtension);
  if(!Number.isFinite(valueExtension))return {status:'WAIT',reason:'3m no-chase value extension unavailable',currentPrice:px,valueExtension};
  if(valueExtension>V2_CONFIG.noChaseAtrPrimary){
    return {status:'TOO_LATE',reason:`entry too late: 3m value extension ${valueExtension.toFixed(2)} ATR > ${V2_CONFIG.noChaseAtrPrimary.toFixed(2)} ATR no-chase limit`,currentPrice:px,valueExtension};
  }

  const extensionAtr=Number.isFinite(atr3)&&atr3>0&&Number.isFinite(step8.entryZoneHigh)
    ?(px-step8.entryZoneHigh)/atr3:NaN;
  return {status:'READY',reason:`3m trend + fresh 1m setup + later-closed 1m ${step9.score} + live timing + 3m no-chase ${valueExtension.toFixed(2)} ATR`,currentPrice:px,extensionAtr,valueExtension};
}


function softWarningCategory(text){
  const x=String(text||'').toLowerCase();
  if(x.includes('spread')||x.includes('depth'))return 'liquidity';
  if(x.includes('oi 5m/15m')||x.includes('taker b/s'))return 'flow';
  if(x.includes('funding')||x.includes('crowding')||x.includes('premium'))return 'positioning';
  if(x.includes('fast volume'))return 'participation';
  if(x.includes('historical r/r'))return 'history';
  if(x.includes('extension')||x.includes('chase'))return 'extension';
  if(x.includes('3m transition'))return 'trend-transition';
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

  if(chart.step7?.regime==='DOWNTREND')drops.push('3m DOWNTREND');
  // 3m TRANSITION is informational only; it does not affect SELECT/CAUTION.

  const freshness=chart.entryFreshness;
  if(!freshness||freshness.status==='UNAVAILABLE'||freshness.status==='CALIBRATING')drops.push('3m freshness unavailable');
  // Current no-chase timing is enforced as a hard Entry gate in Step 10.

  const impulse=chart.entryImpulse;
  if(!impulse||impulse.status==='UNAVAILABLE')drops.push('3m Elder unavailable');
  else if(impulse.status==='BEARISH')drops.push('3m Elder BEARISH');

  const s8=chart.step8||{};
  if(s8.status==='INVALIDATED'||s8.status==='BLOCKED')drops.push(s8.reason||'1m setup invalid');
  else if(s8.status!=='PASS')coreCautions.push(s8.reason||'1m setup not ready');

  if(s8.status==='PASS'){
    const passed=Number(chart.step9?.passed);
    if(chart.step9?.status!=='CONFIRMED'){
      // 1m confirmation is an Entry-Ready gate, not a structural invalidation gate.
      // Any non-confirmed 1m state stays visible as CAUTION; only explicit hard-fail
      // conditions elsewhere are allowed to remove the candidate from the Response.
      if(chart.step9?.timingPending){
        coreCautions.push(chart.step9?.reason||'1m candle not ready');
      }else if(Number.isFinite(passed)){
        coreCautions.push(`${chart.step9.score} not Entry Ready — no RSI/MACD/ATR confirmation component passed`);
      }else{
        coreCautions.push(chart.step9?.reason||'1m confirmation not ready');
      }
    }
  }

  if(s8.status==='PASS'&&chart.step9?.status==='CONFIRMED'){
    if(chart.step10?.status==='INVALIDATED')drops.push(chart.step10.reason||'setup invalidated');
    else if(chart.step10?.status==='TOO_LATE'||chart.step10?.status==='SKIP_CHASE')coreCautions.push(chart.step10.reason||'entry too late');
    else if(chart.step10?.status!=='READY')coreCautions.push(chart.step10?.reason||'entry trigger/zone not ready');
  }

  // Live direction is an entry-timing gate, never a structural invalidation.
  // 3m primary: only a strong downside body blocks SELECT. A mild 3m DOWN stays valid.
  // 1m entry/setup: a clear downside body blocks SELECT. FLAT/UP remain valid.
  const livePrimary=chart.liveDirection5m,live1=chart.liveDirection1m;
  if(livePrimary?.blocksSelect)coreCautions.push(`live 3m STRONG_DOWN (${livePrimary.bodyAtr>=0?'+':''}${fmt(livePrimary.bodyAtr,2)} ATR)`);
  else if(livePrimary?.status==='DOWN')softWarnings.push(`live 3m mild DOWN (${livePrimary.bodyAtr>=0?'+':''}${fmt(livePrimary.bodyAtr,2)} ATR)`);
  if(live1?.blocksSelect)coreCautions.push(`live 1m DOWN (${live1.bodyAtr>=0?'+':''}${fmt(live1.bodyAtr,2)} ATR1)`);

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
    const [s3,s1]=await Promise.all([
      getKlineSnapshot(row.symbol,'3m',serverTime),
      getKlineSnapshot(row.symbol,'1m',serverTime)
    ]);
    // Reuse the 1m series for both setup and confirmation. analyzeStep9 enforces
    // confirmation closeTime > setup closeTime, so one candle can never do both jobs.
    const c5=s3.closed,c3=s1.closed,c1=s1.closed;
    const finalBook=finalBookMap?.get(row.symbol)||null;
    const finalSpread=spreadPct(finalBook),finalBid=num(finalBook?.bidPrice),finalAsk=num(finalBook?.askPrice);
    const currentPrice=finalBid>0&&finalAsk>0?(finalBid+finalAsk)/2:row.decisionPrice;
    if(Number.isFinite(state.thresholds?.spreadP90)&&Number.isFinite(finalSpread)&&finalSpread>state.thresholds.spreadP90){
      return {...row,decisionPrice:currentPrice,liveSpread:finalSpread,result:'DROP',reasons:[...(row.reasons||[]),'entry drop: final spread > profile p90'],chartAnalysis:{final:'DROP',reason:'final spread > profile p90',step7:{regime:'NOT_RUN'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—',passed:0},step10:{status:'NOT_RUN'},priceLocation:null,entryFreshness:null,entryImpulse:null}};
    }

    const i5=buildIndicators(c5),i3=buildIndicators(c3),i1=i3;
    // Keep legacy chart field names for compatibility; liveDirection5m now carries
    // the primary 3m candle, while liveDirection1m is the entry/setup candle.
    const liveDirection5m=analyzeLiveCandleDirection(s3.current,c5,currentPrice,i5.atr14.at(-1),'3m');
    const liveDirection3m=null;
    const liveDirection1m=analyzeLiveCandleDirection(s1.current,c1,currentPrice,i1.atr14.at(-1),'1m');

    // New hierarchy: 3m primary structure -> 1m setup (original 3m setup windows preserved in wall-clock time) -> later 1m confirmation.
    const step7=analyzeStep7(c5,i5);
    const entryFreshness=await analyzeEntryFreshnessFromData(row.symbol,currentPrice,serverTime,c5,i5);
    const entryImpulse=entryFreshness?.impulse||analyzePrimaryElderImpulse({candles:c5,ind:i5,hl:null});
    const step8=analyzeStep8(c3,i3,step7);
    const step9=analyzeStep9(c1,i1,step8);
    const step10=analyzeStep10(c1,i1,c3,i3,step8,step9,currentPrice,entryFreshness);
    const priceLocation=step10.status==='READY'?computePriceLocation(c5,c3,c1,i5,i3,step7,step8,{horizonMin:240,currentPriceOverride:currentPrice,currentTimeOverride:serverTime}):null;
    const provisional={step7,step8,step9,step10,priceLocation,entryFreshness,entryImpulse,liveDirection5m,liveDirection3m,liveDirection1m};
    const decision=finalizeEntryDecision(row,provisional,finalSpread);
    const final=decision.result;
    const reason=`7(3m):${step7.reason} | Fresh:${entryFreshnessReason(entryFreshness)} | Elder:${entryImpulseReason(entryImpulse)} | 8(1m setup):${step8.reason} | 9(1m confirm):${step9.reason} | 10:${step10.reason} | Live:${liveDirectionReason(liveDirection5m)}; ${liveDirectionReason(liveDirection1m)}${priceLocation?` | Location:${priceLocation.verdict}; StructuralAsym=${priceLocation.structuralAsymmetry===Infinity?'OPEN':fmt(priceLocation.structuralAsymmetry,2)}; HistAsym=${fmt(priceLocation.historicalAsymmetry,2)}; StatN=${priceLocation.model.n}`:''}`;
    const chartAnalysis={final,reason,step7,step8,step9,step10,priceLocation,entryFreshness,entryImpulse,liveDirection5m,liveDirection3m,liveDirection1m,decision,asOf:serverTime};
    const reasons=[...(row.reasons||[]),...decision.drops.map(x=>`entry drop: ${x}`),...decision.coreCautions.map(x=>`entry caution: ${x}`),...decision.softWarnings.map(x=>`entry info: ${x}`),reason];
    const out={...row,decisionPrice:currentPrice,liveSpread:finalSpread,result:decision.result,reasons,chartAnalysis,entryFreshness,entryImpulse,trend5mRegime:step7.regime,trend5mReason:step7.reason};
    if(decision.result==='SELECT'&&step10.status==='READY'&&priceLocation)registerPriceObservation(out,chartAnalysis,priceLocation);
    return out;
  }catch(e){
    if(e.name==='AbortError')throw e;
    return {...row,result:'DROP',reasons:[...(row.reasons||[]),`entry drop: data/analysis error ${e.message}`],chartAnalysis:{final:'DROP',reason:`entry data/analysis error: ${e.message}`,step7:{regime:'ERROR'},step8:{setup:'—',status:'NOT_RUN'},step9:{status:'NOT_RUN',score:'—',passed:0},step10:{status:'NOT_RUN'},priceLocation:null,entryFreshness:null,entryImpulse:null}};
  }
}

  // ================================================================
  // INTERNAL AUTO WATCH
  // Same orchestration as working Auto5m3m1m: SELECT -> price Watch -> GREEN -> BTC gate -> Follow.
  // Coin selection remains owned by the 3m/1m algorithm above.
  // ================================================================

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
    if(last)return [];
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

    let next=0;async function supplyWorker(){while(true){const i=next++;if(i>=rows.length)return;const r=rows[i],m=r.gridMeta;if(!(m?.spotPrice>0&&m?.circulatingSupply>0))continue;try{m.totalSupply=await metaVerifiedTotalSupply(m);}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;}}}
    await Promise.all(Array.from({length:Math.min(META_SUPPLY_CONCURRENCY,rows.length)},supplyWorker));

    next=0;async function historyWorker(){while(true){const i=next++;if(i>=rows.length)return;const r=rows[i],m=r.gridMeta;if(!m?.spotSymbol)continue;try{const [firstDaily,monthly]=await Promise.all([metaSpotKlines(m.spotSymbol,'1d',0,1),metaSpotKlines(m.spotSymbol,'1M',0,1000)]);if(firstDaily.length){const t=metaToNumber(firstDaily[0]?.[0]);if(Number.isFinite(t))m.listingTime=t;}if(monthly.length){let hi=-Infinity,lo=Infinity;for(const k of monthly){const h=metaToNumber(k?.[2]),l=metaToNumber(k?.[3]);if(h>0&&h>hi)hi=h;if(l>0&&l<lo)lo=l;}if(Number.isFinite(hi))m.allTimeHigh=hi;if(Number.isFinite(lo))m.allTimeLow=lo;}}catch(e){if(e.name==='AbortError'&&state.controller?.signal.aborted)throw e;}}}
    await Promise.all(Array.from({length:Math.min(META_HISTORY_CONCURRENCY,rows.length)},historyWorker));
    for(const r of rows){const m=r.gridMeta;m.ys=metaYsResult(m.totalSupply,m.spotPrice,m.listingTime);}
  }



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

  function currentServerTime(){return Date.now()+Number(state.serverOffsetMs||0);}

  async function loadAutoPremiumFunding(force=false){
    const now=Date.now();
    if(!force&&state.premiumCache&&now-state.premiumCache.loadedAt<60000)return state.premiumCache;
    const data=await loadPremiumFunding();
    state.premiumCache={...data,loadedAt:now};
    return state.premiumCache;
  }
  function followApi(){return runtime.followGateway||null;}
  function activeFollowSymbols(){
    const api=followApi();
    if(typeof api?.getActiveSymbols==='function')return new Set((api.getActiveSymbols()||[]).map(s=>String(s||'').trim().toUpperCase()).filter(Boolean));
    const out=new Set();for(const s of state.autoFollowSymbols)if(api?.isFollowing?.(s))out.add(s);return out;
  }
  function usedSlots(){const active=activeFollowSymbols();let n=active.size;for(const s of state.startingFollow)if(!active.has(s))n++;return n;}
  function activeCapacity(){return Math.max(0,getAutoSettings().maxOpenPositions-usedSlots());}
  function slotsText(){const c=getAutoSettings();return `${usedSlots()}/${c.maxOpenPositions}`;}

  function operationallyValid(row,cycleTime){
    const sym=state.session?.statusMap?.get(row.symbol);
    if(!sym||sym.status!=='TRADING'||sym.contractType!=='PERPETUAL'||sym.underlyingType!=='COIN'||sym.quoteAsset!=='USDT'||sym.marginAsset!=='USDT')return false;
    const delivery=Number(sym.deliveryDate);return !(Number.isFinite(delivery)&&delivery>0&&delivery<=cycleTime+MAX_HOLD_MS);
  }
  function watchStateFor(symbol,row=null){const w=runtime.watchService.add(symbol);if(row)state.watchRows.set(symbol,{...row,result:'SELECT',scanSource:SCAN_SOURCE,scanTimeframes:{...SCAN_TIMEFRAMES},autoWatchStatus:w.status,autoWatchReason:w.reason,btcImpact3m1m:w.btcImpact||null});return w;}
  function removeWatch(symbol){runtime.watchService.remove(symbol);state.watchRows.delete(symbol);state.greenQueue=state.greenQueue.filter(x=>x!==symbol);}
  function updateWatchRowsFromStates(){for(const [symbol,row] of state.watchRows){const w=state.watchStates.get(symbol);if(w)state.watchRows.set(symbol,{...row,result:'SELECT',autoWatchStatus:w.status,autoWatchReason:w.reason,btcImpact3m1m:w.btcImpact||null});}}
  function reconcileWatchPool(finalSelects){
    const eligible=new Map((finalSelects||[]).map(r=>[r.symbol,r]));const active=activeFollowSymbols();
    for(const symbol of [...state.watchStates.keys()])if(!eligible.has(symbol)&&!active.has(symbol))removeWatch(symbol);
    for(const row of finalSelects||[]){if(active.has(row.symbol)&&!getAutoSettings().allowDuplicateSymbolPosition)continue;watchStateFor(row.symbol,row);}
    updateWatchRowsFromStates();
  }
  function evaluateWatchSymbol(symbol,referenceTime){return runtime.watchService.evaluate(symbol,referenceTime);}
  function ensureFollowInputs(symbol,fallbackPrice){return runtime.followGateway?.prepareInputs?.(symbol,fallbackPrice,SCAN_SOURCE)!==false;}
  async function checkBtcImpactBeforeFollow(symbol,w){const api=runtime.btcImpactGateway;if(!w)return false;if(!api?.analyze){w.confirmed=false;w.confirmCount=0;w.status='WAIT';w.reason='BTC WAIT • BTC impact gateway unavailable';return false;}try{const result=await api.analyze(symbol);w.btcImpact=result;w.btcImpactError=null;w.btcCheckedAt=Date.now();const summary=api.summaryText?.(result)||`BTC ${result?.level||'NEUTRAL'}`;if(result?.entryDecision==='WAIT'){w.confirmed=false;w.confirmCount=0;w.status='WAIT';w.reason=`BTC WAIT • ${summary}`;return false;}w.reason=`${w.reason} • BTC ALLOW • ${summary}`;const row=state.watchRows.get(symbol);if(row)state.watchRows.set(symbol,{...row,btcImpact3m1m:result});return true;}catch(e){w.confirmed=false;w.confirmCount=0;w.status='WAIT';w.btcImpactError=String(e?.message||e);w.btcCheckedAt=Date.now();w.reason=`BTC WAIT • etki verisi alınamadı: ${e?.message||e}`;return false;}}
  async function startFollowFor(symbol){if(activeCapacity()<=0||state.startingFollow.has(symbol))return false;const api=followApi();if(!api)return false;if(api.isFollowing?.(symbol)){state.autoFollowSymbols.add(symbol);removeWatch(symbol);return true;}const w=state.watchStates.get(symbol);if(!ensureFollowInputs(symbol,w?.latestPrice)){if(w){w.status='ARMED';w.reason='GREEN hazır; Follow Entry/Stop bekleniyor.';}return false;}state.startingFollow.add(symbol);try{const started=typeof api.startFollow==='function'?((await api.startFollow(symbol))===true||!!api.isFollowing?.(symbol)):false;if(started){state.autoFollowSymbols.add(symbol);removeWatch(symbol);log(`AUTO FOLLOW ${symbol}: GREEN + BTC ALLOW → Follow başladı • slots ${slotsText()}.`);return true;}if(w){w.status='ARMED';w.reason='GREEN hazır; Follow başlatılamadı, tekrar denenecek.';}return false;}finally{state.startingFollow.delete(symbol);}}

  async function drainGreenQueue(){
    if(!getAutoSettings().autoFollowOnSelect)return;
    while(state.running&&state.greenQueue.length&&activeCapacity()>0){
      const symbol=state.greenQueue.shift(),w=state.watchStates.get(symbol);if(!w||!w.confirmed||!['GREEN','ARMED'].includes(w.status))continue;
      w.status='GREEN';const btcAllowed=await checkBtcImpactBeforeFollow(symbol,w);if(!btcAllowed){renderAutoGrid();continue;}
      const ok=await startFollowFor(symbol);if(!ok&&state.watchStates.has(symbol)){w.status='ARMED';state.greenQueue.unshift(symbol);break;}
    }
  }
  function renderAutoGrid(){updateWatchRowsFromStates();state.results=[...state.watchRows.values()].filter(r=>r?.result==='SELECT');emit('auto-grid',{rows:state.results});}
  async function watchTick(){if(!state.running)return;const t=currentServerTime();for(const symbol of state.watchStates.keys())evaluateWatchSymbol(symbol,t);renderAutoGrid();await drainGreenQueue();updateAutoStatus();}
  function startWatchTimer(){if(state.watchTimer)clearInterval(state.watchTimer);state.watchTimer=setInterval(()=>{void watchTick();},1000);}
  function stopWatchTimer(){if(state.watchTimer)clearInterval(state.watchTimer);state.watchTimer=null;}
  function updateAutoStatus(){
    if(!state.running)return;
    const cfg=getAutoSettings(),watch=state.watchStates.size,green=[...state.watchStates.values()].filter(x=>x.status==='GREEN'||x.status==='ARMED').length;
    if(cfg.pauseScanWhenPositionLimitReached&&activeCapacity()<=0){
      setStatus(`Auto3m1m PAUSED • slots ${slotsText()} • Follow EXIT bekleniyor.`,'good');
      return;
    }
    if(watch){
      setStatus(`Auto3m1m: SELECT ${watch} • Watch giriş zamanını bekliyor${green?` • GREEN/ARMED ${green}`:''} • confirm ${cfg.entryConfirmationCount}x • slots ${slotsText()}.`,'good');
      return;
    }
    const d=state.lastCycleDiag;
    if(d){
      const drop=d.topDrop?` • drop ${d.topDrop}`:'';
      setStatus(
        `Auto3m1m LIVE • SELECT yok • ready ${d.ready}/${d.universe} • analyzed ${d.analyzed} • rawSELECT ${d.rawSelect} • allowed ${d.allowed} • spread ${d.spread} • detail ${d.detail} • profile ${d.profile} • final ${d.final} • topGate ${d.topGate}${drop} • slots ${slotsText()} • ${cfg.scanIntervalSeconds}s cycle.`,
        'info'
      );
      return;
    }
    setStatus(`Auto3m1m LIVE • SELECT yok • slots ${slotsText()} • ${cfg.scanIntervalSeconds}s cycle.`,'info');
  }

  async function prepareAutoSession(){
    const allowedCoins=await runtime.universeProvider();
    log(`Auto3m1m: hybrid REST bootstrap + WebSocket live mode. AllowedCoins=${allowedCoins.size}.`);

    let activity,exchange;
    const cacheAge=activityCacheAgeMs();
    if(state.activityCache&&cacheAge<ACTIVITY_CACHE_MS){
      const cachedActivity=state.activityCache.activity;
      setStatus(`Auto3m1m universe doğrulanıyor (${formatCacheAge(cacheAge)} cache)…`,'info');
      progress(5,'Universe validation');
      exchange=await getExchangeInfo();
      const liveEligible=activeSymbols(exchange),liveEligibleSet=new Set(liveEligible.map(s=>s.symbol));
      activity=cachedActivity.filter(r=>liveEligibleSet.has(r.symbol));
      if(!activity.length)throw new Error('Cached Activity Rank ile güncel Binance USDT-M crypto universe kesişimi boş.');
      state.activity=activity;
      emit('active-count',{count:liveEligible.length});
      emit('ranked-count',{count:activity.length});
      updateActivityCacheStatus();
    }else{
      // Fix7 request architecture:
      // Activity Rank requires complete 24h volume + top-of-book information.
      // Use exactly TWO bulk REST snapshots instead of hundreds of per-symbol
      // requests or a partial WebSocket coverage gate. This does NOT change
      // Activity Rank math or any 3m/1m SELECT rule.
      progress(3,'Bootstrap: exchange + 2 bulk activity snapshots');
      exchange=await getExchangeInfo();

      const [tickers,books]=await Promise.all([
        getBulk24(),
        getBulkBook()
      ]);

      if(!Array.isArray(tickers)||!tickers.length)throw new Error('Bulk 24h ticker snapshot alınamadı.');
      if(!Array.isArray(books)||!books.length)throw new Error('Bulk bookTicker snapshot alınamadı.');

      marketDataStore.seedBooks(books);
      activity=await buildActivityRank(exchange,tickers,books);
      state.activity=activity;
      if(!activity.length)throw new Error('Activity Rank oluşturulamadı.');

      savePersistentActivityCache({
        createdAt:Date.now(),
        activeCount:activeSymbols(exchange).length,
        activity
      });

      autoDiag(`ACTIVITY BOOTSTRAP: complete bulk snapshot • ticker rows ${tickers.length} • book rows ${books.length} • symbol-specific activity REST 0.`);
    }

    const universe=activity.filter(r=>allowedCoins.has(r.symbol));
    if(!universe.length)throw new Error('AllowedCoins sonrası Auto3m1m universe boş.');
    emit('universe-count',{count:universe.length});
    emit('rank-300-count',{count:activity.filter(r=>r.activityRank>=300).length});
    emit('fast-mode',{value:'WS'});
    emit('event-watch-count',{count:universe.length});

    // From this point market data is WebSocket-owned. REST history is prepared
    // by a slow background queue; the live scanner starts as soon as a small
    // history-ready subset exists and automatically expands as more symbols warm up.
    const serverTime=await getServerTime();
    state.serverOffsetMs=serverTime-Date.now();
    const statusMap=new Map((exchange.symbols||[]).map(x=>[x.symbol,x]));
    startHybridStreams(universe);
    await sleep(1200);

    progress(8,'History queue warming');
    startHistoryBootstrapQueue(universe);
    const readyAtStart=await waitForMinimumHistoryReady(universe);
    const bootstrap=historyBootstrapSnapshot(universe);
    clearMarketContext(`Auto3m1m: history queue aktif; ${readyAtStart}/${universe.length} coin scan-ready. 1m/3m + bookTicker WebSocket canlı.`);
    autoDiag(`LIVE ENGINE START: history-ready ${readyAtStart}/${universe.length}; remaining symbols join automatically without restarting scan.`);
    return {universe,allowedCoins,statusMap,preparedAt:Date.now(),bootstrap};
  }


  async function evaluateAutoCycle(){
    if(!state.running||state.cycleRunning||!state.session)return;
    const cfg=getAutoSettings();if(cfg.pauseScanWhenPositionLimitReached&&activeCapacity()<=0){updateAutoStatus();return;}
    state.cycleRunning=true;resetBaseDropDiagnostics();const cycleTime=currentServerTime();const cycleNo=++autoDiagCycle,cycleStartedAt=performance.now();
    try{
      const universe=state.session.universe;
      const readyUniverse=universe.filter(r=>marketDataStore.isHistoryReady(r.symbol));
      const active=activeFollowSymbols();
      const candidates=readyUniverse.filter(r=>cfg.allowDuplicateSymbolPosition||!active.has(r.symbol));
      const health=autoDiagMarketHealth(universe),hb=historyBootstrapSnapshot(universe);
      autoDiag(`──────── CYCLE #${cycleNo} ────────`);
      autoDiag(`Universe ${universe.length} • history-ready ${readyUniverse.length} • pending ${hb.pending} • candidates ${candidates.length} • slots ${slotsText()} • interval ${cfg.scanIntervalSeconds}s • REST total ${state.requestCount}`);
      autoDiag(`WS health: 1m ${health.oneLive}/${universe.length} • 3m ${health.threeLive}/${universe.length} • book ${health.bookLive}/${universe.length}`);
      if(!readyUniverse.length){state.lastCycleDiag={universe:universe.length,ready:0,analyzed:0,rawSelect:0,allowed:0,spread:0,detail:0,profile:0,final:0,topGate:'history=0',topDrop:''};reconcileWatchPool([]);renderAutoGrid();setStatus(`Auto3m1m: history queue hazırlanıyor • 0/${universe.length} scan-ready.`,'info');return;}

      const chartBookMap=marketDataStore.bookMap(universe);
      state.thresholds={spreadP75:NaN,spreadP90:NaN,depthP25:NaN,depthP10:NaN,fundingP90:NaN,premiumP90:NaN,oiNotionalP75:NaN};
      const chartInput=candidates.map(r=>{const b=chartBookMap.get(r.symbol),bid=num(b?.bidPrice),ask=num(b?.askPrice),px=bid>0&&ask>0?(bid+ask)/2:r.price;return {...r,snapshot1:px,snapshot2:px,currentFastChange:0,fastChange:0,fastEventStartTime:cycleTime,fastEventTime:cycleTime,fastEventPrice:px,fastEventWindowSec:0,eventAgeMs:0,decisionPrice:px};}).filter(r=>Number.isFinite(r.snapshot2)&&r.snapshot2>0);
      progress(15,`Auto3m1m 3m→1m ${chartInput.length}`);
      const chartAnalyzed=await mapLimit(chartInput,10,r=>analyzeChartCandidate(r,cycleTime,chartBookMap),{pauseMs:0,onProgress:(d,n)=>progress(15+45*d/Math.max(1,n),`3m→1m ${d}/${n}`)});
      const validChartRows=chartAnalyzed.filter(Boolean);finalizeGateDiagnostics(validChartRows);logEntryDecisionDiagnostics(validChartRows);autoDiagCycleCore(validChartRows,readyUniverse.length);
      const rawChartSelects=validChartRows.filter(r=>r.result==='SELECT');
      let chartSelects=rawChartSelects.filter(r=>state.session.allowedCoins.has(r.symbol));
      autoDiag(`PRIMARY GATE: analyzed ${validChartRows.length} • raw ChartSELECT ${rawChartSelects.length} • AllowedCoins ${chartSelects.length}.`);

      let spreadEligibleCount=0,detailCount=0,profileCount=0;
      let finalSelects=[];
      if(chartSelects.length){
        progress(62,'Auto3m1m FINAL safety');
        const {premiumMap,fundingInfoMap}=await loadAutoPremiumFunding();
        const profilePremium=universe.map(r=>premiumMap.get(r.symbol)).filter(Boolean);
        const positiveFunding=profilePremium.map(p=>num(p.lastFundingRate)).filter(x=>Number.isFinite(x)&&x>0);
        const positivePremium=profilePremium.map(p=>{const m=num(p.markPrice),ix=num(p.indexPrice);return m>0&&ix>0?(m/ix-1)*100:NaN;}).filter(x=>Number.isFinite(x)&&x>0);
        const spreadVals=universe.map(r=>spreadPct(chartBookMap.get(r.symbol))).filter(Number.isFinite);
        const thresholds={spreadP75:percentile(spreadVals,.75),spreadP90:percentile(spreadVals,.90),depthP25:NaN,depthP10:NaN,fundingP90:percentile(positiveFunding,.90),premiumP90:percentile(positivePremium,.90),oiNotionalP75:NaN};state.thresholds=thresholds;
        const spreadEligible=chartSelects.filter(r=>{const sp=spreadPct(chartBookMap.get(r.symbol));return Number.isFinite(sp)&&(!Number.isFinite(thresholds.spreadP90)||sp<=thresholds.spreadP90);});
        spreadEligibleCount=spreadEligible.length;
        const detailed=await mapLimit(spreadEligible,DETAIL_CONCURRENCY,r=>candidateDetails(r,cycleTime,cycleTime,premiumMap,fundingInfoMap,thresholds,chartBookMap),{pauseMs:0,onProgress:(d,n)=>progress(62+25*d/Math.max(1,n),`FINAL safety ${d}/${n}`)});
        detailCount=detailed.filter(Boolean).length;
        const safety=applyFastCandidateProfileThresholds(detailed.filter(Boolean),thresholds);
        profileCount=safety.length;
        finalSelects=safety.map(r=>{const chart=r.chartAnalysis;if(!chart)return null;const decision=finalizeEntryDecision(r,chart,r.liveSpread),final=decision.result;return {...r,result:final,decisionTime:cycleTime,scanSource:SCAN_SOURCE,scanTimeframes:{...SCAN_TIMEFRAMES},chartAnalysis:{...chart,final,decision},reasons:[...new Set([...(r.reasons||[]),...decision.drops.map(x=>`entry drop: ${x}`),...decision.coreCautions.map(x=>`entry caution: ${x}`),...decision.softWarnings.map(x=>`entry info: ${x}`)])]};}).filter(r=>r?.result==='SELECT'&&operationallyValid(r,cycleTime));
        autoDiag(`BASE SAFETY: chart SELECT ${chartSelects.length} → spread eligible ${spreadEligible.length} → detail ${detailed.filter(Boolean).length} → profile ${safety.length} → WATCH-ELIGIBLE ${finalSelects.length}`);
      }
      finalSelects=sortCandidates(finalSelects);
      const primaryCounts=autoDiagCountBy(validChartRows,classifyEntryPrimaryGate);
      const primaryOrder=[['oneHourBlock','3mDown'],['freshnessElder','Fresh/Elder'],['setup15m','1mSetup'],['confirm5m','1mConfirm'],['triggerZone','Trigger'],['rr','R/R'],['softCaution','Soft'],['entryError','Error'],['select','ChartSELECT']];
      const topPrimary=primaryOrder.map(([key,label])=>({key,label,count:primaryCounts.get(key)||0})).sort((a,b)=>b.count-a.count)[0]||{label:'—',count:0};
      const topDrop=[...baseDropDiagnostics.entries()].sort((a,b)=>b[1]-a[1])[0]||null;
      state.lastCycleDiag={
        universe:universe.length,
        ready:readyUniverse.length,
        analyzed:validChartRows.length,
        rawSelect:rawChartSelects.length,
        allowed:chartSelects.length,
        spread:spreadEligibleCount,
        detail:detailCount,
        profile:profileCount,
        final:finalSelects.length,
        topGate:`${topPrimary.label}=${topPrimary.count}`,
        topDrop:topDrop?`${topDrop[1]}× ${topDrop[0]}`:''
      };
      autoDiag(`FUNNEL: ready ${state.lastCycleDiag.ready}/${state.lastCycleDiag.universe} • analyzed ${state.lastCycleDiag.analyzed} • rawSELECT ${state.lastCycleDiag.rawSelect} • allowed ${state.lastCycleDiag.allowed} • spread ${state.lastCycleDiag.spread} • detail ${state.lastCycleDiag.detail} • profile ${state.lastCycleDiag.profile} • final ${state.lastCycleDiag.final} • topGate ${state.lastCycleDiag.topGate}${state.lastCycleDiag.topDrop?` • drop ${state.lastCycleDiag.topDrop}`:''}`);
      reconcileWatchPool(finalSelects);
      if(finalSelects.length)await enrichV5GridMetadata(finalSelects);
      for(const r of finalSelects){const existing=state.watchRows.get(r.symbol);if(existing)state.watchRows.set(r.symbol,{...existing,...r,result:'SELECT'});}
      renderAutoGrid();await drainGreenQueue();progress(100,'Live cycle completed');updateAutoStatus();
      autoDiag(`CYCLE #${cycleNo} RESULT: WATCH-ELIGIBLE ${finalSelects.length} • Watch pool ${state.watchStates.size} • slots ${slotsText()} • scan-ready ${readyUniverse.length}/${universe.length} • REST total ${state.requestCount} • duration ${((performance.now()-cycleStartedAt)/1000).toFixed(2)}s`);
    }catch(e){if(e.name==='AbortError')throw e;state.errors.push({time:Date.now(),message:e.message||String(e)});log(`Auto cycle error: ${e.stack||e.message}`);setStatus(`Auto3m1m cycle error: ${e.message}`,'warn');}
    finally{state.cycleRunning=false;}
  }

  function scheduleNextAutoCycle(delayMs=null){
    if(!state.running)return;if(state.loopTimer)clearTimeout(state.loopTimer);
    const ms=delayMs==null?getAutoSettings().scanIntervalSeconds*1000:Math.max(0,delayMs);
    state.loopTimer=setTimeout(async()=>{state.loopTimer=null;if(!state.running)return;try{await evaluateAutoCycle();}catch(e){if(e.name!=='AbortError')log(`Auto scheduler: ${e.message||e}`);}finally{scheduleNextAutoCycle();}},ms);
  }

  function hydratePersistentState(){
    loadPersistentActivityCache();
    loadPriceLearning();
    loadEntryFreshnessCache();
  }

  async function startScan(){
    if(state.running)return;
    log(`Auto3m1m BUILD ${AUTO31_BUILD}`);
    captureFollowRowsBeforeScan();
    emit('scan-start',{reason:SCAN_SOURCE,preserveFollow:true});
    state.running=true;state.cycleRunning=false;state.controller=new AbortController();state.startedAt=Date.now();state.settings={...getAutoSettings(),scanSettingsUsed:false};state.watchRows.clear();state.watchStates.clear();state.greenQueue=[];state.startingFollow.clear();state.autoFollowSymbols.clear();state.premiumCache=null;state.historyBootstrap=null;resetScanState();resetUI();setButtons(true);
    try{
      state.session=await prepareAutoSession();
      if(state.controller.signal.aborted)(()=>{const e=new Error('Aborted');e.name='AbortError';throw e;})();
      setStatus('Auto3m1m LIVE başladı: 3m/1m WebSocket + internal AutoWatch + Follow.','good');
      startWatchTimer();
      await evaluateAutoCycle();
      scheduleNextAutoCycle();
      // IMPORTANT: completePriceLearning() is intentionally disabled in Auto mode.
      // It is UI/statistical enrichment, not an entry gate, and would add background REST traffic.
      autoDiag('PRICE LEARNING background REST: OFF (selection algorithm unaffected).');
    }catch(e){
      if(e.name==='AbortError'){
        setStatus('Auto3m1m kullanıcı tarafından durduruldu.','warn');
        progress(0,'Cancelled');
        stopAutoRuntime();
      }else if(e?.status===418||e?.rateLimit){
        const waitMs=Math.max(1000,Number(e.retryDelayMs)||Math.max(0,(Number(state.rateLimitBlockedUntil)||0)-Date.now())||60000);
        const waitSec=Math.ceil(waitMs/1000);
        setStatus(`Auto3m1m PAUSED: Binance HTTP ${e.status||418} rate-limit. REST çağrıları durduruldu. Yaklaşık ${waitSec}s sonra tekrar deneyin; bu sürede sayfayı tekrar tekrar başlatmayın.`,'warn');
        progress(0,'Binance rate-limit pause');
        log(`RATE LIMIT PAUSE: ${e.message||e} • wait≈${waitSec}s • immediate retry disabled.`);
        stopAutoRuntime();
      }else{
        setStatus(`Auto3m1m failed: ${e.message}`,'bad');
        progress(0,'Failed');
        log(`FATAL: ${e.stack||e.message}`);
        stopAutoRuntime();
      }
    }
  }

  function stopAutoRuntime(){
    if(state.loopTimer)clearTimeout(state.loopTimer);state.loopTimer=null;
    if(state.historyBootstrap)state.historyBootstrap.running=false;
    stopWatchTimer();stopHybridStreams();state.running=false;state.cycleRunning=false;state.session=null;setButtons(false);
  }

  // Auto3m1m owns its internal live timer and does not bind to #startBtn.
  // It binds only to #auto3m1mScanBtn when that button is added to index.html.
  async function runStandaloneScan(){if(state.running)return;await startScan();}

  function cancelStandaloneScan(){if(state.controller)state.controller.abort();stopAutoRuntime();setStatus('Auto3m1m durduruldu.','warn');}


  function onFollowComplete(symbol){symbol=String(symbol||'').trim().toUpperCase();if(!symbol)return;const was=state.autoFollowSymbols.delete(symbol);if(was)log(`Follow complete ${symbol}: Auto3m1m slot released.`);if(state.running&&getAutoSettings().resumeScanAfterPositionExit){void drainGreenQueue().finally(()=>{if(state.running&&activeCapacity()>0)void evaluateAutoCycle();});}}
  const api={configure:configureRuntime,start:runStandaloneScan,scan:runStandaloneScan,cancel:cancelStandaloneScan,stop:cancelStandaloneScan,onFollowComplete,evaluateCycle:evaluateAutoCycle,get running(){return state.running;},state,source:SCAN_SOURCE,timeframes:SCAN_TIMEFRAMES,build:AUTO31_BUILD,get settings(){return getAutoSettings();},get watchedSymbols(){return runtime.watchService?.symbols?.()||[];},get activeFollowSymbols(){return [...activeFollowSymbols()];},get openSlots(){return activeCapacity();}};
  globalThis.Auto3m1mCore=api;
})();
