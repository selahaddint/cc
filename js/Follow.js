(() => {
  'use strict';

  // ================================================================
  // FOLLOW MODULE
  // Owns only: Entry/Stop interaction, Follow start/stop, live monitor,
  // HOLD/PROTECT/EXIT rules and live OI/flow analysis.
  // It calls no Start Scan or Risk Management function.
  // ================================================================

  const FOLLOW_BASE='https://fapi.binance.com';
  const FOLLOW_MAX_HOLD_MS=4*60*60*1000;
  const FOLLOW_CONFIG=Object.freeze({refreshMs:60*1000,atrBreakWarn:0.25,atrBreakExit:0.50,trailingAtrMultiple:2,breakEvenArmAtr:1,maxHoldMs:FOLLOW_MAX_HOLD_MS});
  const FOLLOW_LIVE_CONFIG=Object.freeze({spikePercentile:0.95,priceHistoryMinutes:60,oiSpikeMinSamples:10,oiSpikeMaxSamples:60,lsPeriod:'5m',oiHistoryLimit:30});
  const FOLLOW_V2_CONFIG=Object.freeze({
    candleLimit:300,swingLeft:2,swingRight:2,structureAtr:0.10,emaSlopeBars:3,emaSlopeAtr:0.05,
    rangeEmaGapAtr:0.50,rangeBars:10,rangeMinEachSide:3,valueAtr:0.15,pullbackLookback:5,deepPullbackAtr:0.50,
    breakoutLookback:20,breakoutAtr:0.10,retestAtr:0.20,retestMaxBars:4,volumeSma:20,rsiPeriod:14,rsiMin:50,rsiMax:70,
    atrPeriod:14,atrPercentileLookback:100,atrPercentileMin:30,atrPercentileMax:80,triggerAtr5:0.05,noChaseAtr15:0.50,triggerValidBars:2
  });

  const followMonitors=new Map();
  const followNum=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const followFmt=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
  const followPct=x=>Number.isFinite(x)?`${x>=0?'+':''}${x.toFixed(3)}%`:'—';
  const followCompact=x=>{if(!Number.isFinite(x))return '—';return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(x);};
  const followSleep=ms=>new Promise(r=>setTimeout(r,ms));

  // System notification support for Follow EXIT decisions.
  // Permission is requested only from the user's Follow button click.
  let followServiceWorkerRegistration=null;

  async function followRegisterServiceWorker(){
    if(!('serviceWorker' in navigator))return null;
    if(followServiceWorkerRegistration)return followServiceWorkerRegistration;
    try{
      followServiceWorkerRegistration=await navigator.serviceWorker.register('./service-worker.js',{scope:'./'});
      return followServiceWorkerRegistration;
    }catch(e){
      followLog(`Notification service worker unavailable: ${e.message||e}`);
      return null;
    }
  }

  async function ensureFollowNotificationPermission(){
    if(!('Notification' in window)){followLog('System notifications are not supported by this browser.');return false;}
    if(Notification.permission==='denied'){followLog('System notification permission is denied. Follow continues without notifications.');return false;}
    try{
      // Request permission before any awaited registration work so the browser still sees
      // this as a direct consequence of the user's Follow button gesture.
      if(Notification.permission==='default'){
        const permission=await Notification.requestPermission();
        if(permission!=='granted'){followLog('System notification permission was not granted. Follow continues without notifications.');return false;}
      }
      const registration=await followRegisterServiceWorker();
      return Notification.permission==='granted'&&!!registration;
    }catch(e){
      followLog(`Notification permission request failed: ${e.message||e}`);
      return false;
    }
  }

  async function showFollowExitNotification(symbol,currentPrice,reason){
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    try{
      const registration=await followRegisterServiceWorker();
      if(!registration?.showNotification)return;
      const cleanReason=String(reason||'EXIT condition triggered').replace(/\s+/g,' ').trim();
      const body=`Price: ${followPriceFmt(currentPrice)}\n${cleanReason}`.slice(0,320);
      await registration.showNotification(`EXIT — ${symbol}`,{
        body,
        icon:'./icon-192.png',
        badge:'./icon-192.png',
        tag:`follow-exit-${symbol}`,
        renotify:true,
        requireInteraction:true,
        data:{url:'./CryptoOffer_V13_4.html',symbol,reason:cleanReason,price:currentPrice}
      });
      followLog(`EXIT notification sent: ${symbol}.`);
    }catch(e){
      followLog(`EXIT notification failed for ${symbol}: ${e.message||e}`);
    }
  }

  function followLog(msg){
    const el=document.getElementById('logBox');if(!el)return;
    const t=new Date().toLocaleTimeString('tr-TR');el.textContent+=`\n[${t}] ${msg}`;el.scrollTop=el.scrollHeight;
  }
  function followPriceFmt(x){
    if(!Number.isFinite(x))return '—';const a=Math.abs(x),d=a>=1000?2:a>=1?4:a>=0.01?6:8;
    return x.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
  }
  function followFormatDateTime(ms){
    const n=Number(ms);if(!Number.isFinite(n))return '—';
    return new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(n));
  }
  function followMetaFormatPrice(v){return Number.isFinite(v)?followPriceFmt(v):'—';}
  function followPercentile(arr,p){const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return NaN;if(a.length===1)return a[0];const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos),w=pos-lo;return a[lo]*(1-w)+a[hi]*w;}
  function followMean(values){const a=values.filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;}
  function followEmaSeries(values,period){
    const out=new Array(values.length).fill(NaN);if(values.length<period)return out;
    let seed=0;for(let i=0;i<period;i++){if(!Number.isFinite(values[i]))return out;seed+=values[i];}
    let prev=seed/period;out[period-1]=prev;const k=2/(period+1);
    for(let i=period;i<values.length;i++){if(!Number.isFinite(values[i]))continue;prev=values[i]*k+prev*(1-k);out[i]=prev;}return out;
  }
  function followAtrSeries(candles,period=14){
    const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
    const out=new Array(candles.length).fill(NaN);if(tr.length<period)return out;let prev=followMean(tr.slice(0,period));out[period-1]=prev;
    for(let i=period;i<tr.length;i++){prev=((prev*(period-1))+tr[i])/period;out[i]=prev;}return out;
  }
  function followRsiSeries(closes,period=14){
    const out=new Array(closes.length).fill(NaN);if(closes.length<=period)return out;let gain=0,loss=0;
    for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)gain+=d;else loss-=d;}
    let avgGain=gain/period,avgLoss=loss/period;const calc=()=>avgLoss===0?(avgGain===0?50:100):avgGain===0?0:100-(100/(1+avgGain/avgLoss));out[period]=calc();
    for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1],g=d>0?d:0,l=d<0?-d:0;avgGain=(avgGain*(period-1)+g)/period;avgLoss=(avgLoss*(period-1)+l)/period;out[i]=calc();}return out;
  }
  function followMacdSeries(closes){
    const fast=followEmaSeries(closes,12),slow=followEmaSeries(closes,26),dif=new Array(closes.length).fill(NaN),dea=new Array(closes.length).fill(NaN),hist=new Array(closes.length).fill(NaN);
    const start=25,difVals=[];for(let i=start;i<closes.length;i++){dif[i]=fast[i]-slow[i];difVals.push(dif[i]);}
    const signal=followEmaSeries(difVals,9);for(let j=0;j<difVals.length;j++){const i=start+j;if(Number.isFinite(signal[j])){dea[i]=signal[j];hist[i]=dif[i]-dea[i];}}return {dif,dea,hist};
  }
  function followKlineToCandle(k){return {openTime:Number(k[0]),open:followNum(k[1]),high:followNum(k[2]),low:followNum(k[3]),close:followNum(k[4]),volume:followNum(k[5]),closeTime:Number(k[6]),quoteVolume:followNum(k[7])};}
  function followBuildIndicators(candles){const closes=candles.map(c=>c.close),volumes=candles.map(c=>c.volume);return {closes,volumes,ema7:followEmaSeries(closes,7),ema25:followEmaSeries(closes,25),ema99:followEmaSeries(closes,99),rsi14:followRsiSeries(closes,14),atr14:followAtrSeries(candles,14),macd:followMacdSeries(closes)};}
  function followFindSwings(candles,left=2,right=2){
    const highs=[],lows=[];for(let i=left;i<candles.length-right;i++){let sh=true,sl=true;for(let k=1;k<=left;k++){if(!(candles[i].high>candles[i-k].high))sh=false;if(!(candles[i].low<candles[i-k].low))sl=false;}for(let k=1;k<=right;k++){if(!(candles[i].high>candles[i+k].high))sh=false;if(!(candles[i].low<candles[i+k].low))sl=false;}if(sh)highs.push({index:i,price:candles[i].high});if(sl)lows.push({index:i,price:candles[i].low});}return {highs,lows};
  }
  function followRow(symbol){return [...document.querySelectorAll('#candidateBody tr[data-symbol]')].find(tr=>tr.dataset.symbol===symbol)||null;}
  function followScanState(){return window.CryptoOfferData?.scanState||null;}
  function followLatestScanRow(symbol){return (followScanState()?.results||[]).find(r=>r?.symbol===symbol)||null;}
  function activeFollowTasks(){
    return [...followMonitors.values()].filter(t=>t&&t.status!=='RED');
  }
  function getActiveSymbols(){
    return activeFollowTasks().map(t=>t.symbol).filter(Boolean);
  }
  function preservedRowForTask(task){
    if(!task)return null;
    // Prefer the newest row from the latest completed/current scan when available,
    // but never require the coin to appear in the new scan in order to preserve Follow.
    const latest=followLatestScanRow(task.symbol);
    if(latest){
      if(!latest.decisionSupport&&task.rowSnapshot?.decisionSupport)latest.decisionSupport=task.rowSnapshot.decisionSupport;
      task.rowSnapshot=latest;
    }
    if(task.rowSnapshot&&Number.isFinite(task.currentPrice))task.rowSnapshot.snapshot2=task.currentPrice;
    return task.rowSnapshot&&typeof task.rowSnapshot.symbol==='string'?task.rowSnapshot:null;
  }
  function getPreservedRows(){
    return activeFollowTasks().map(preservedRowForTask).filter(Boolean);
  }

  function purgeExitedFollowMonitors(){
    for(const [symbol,task] of [...followMonitors.entries()]){
      if(task?.status!=='RED')continue;
      if(task.timer)clearInterval(task.timer);
      followMonitors.delete(symbol);
    }
  }
  function syncFollowUI(){
    for(const task of followMonitors.values()){
      preservedRowForTask(task);
      const tr=followRow(task.symbol);if(!tr)continue;
      const entry=tr.querySelector('[data-role="entry"]'),stop=tr.querySelector('[data-role="stop"]'),price=tr.querySelector('[data-role="current-price"]');
      if(entry)entry.value=String(task.entryPrice);
      if(stop)stop.value=String(task.stopPrice);
      if(price&&Number.isFinite(task.currentPrice))price.textContent=followMetaFormatPrice(task.currentPrice);
      setLiveUI(task.symbol,task.liveAnalysis?.change||'',task.liveAnalysis?.result||'');
      setMonitorUI(task.symbol,task.status,task.reason,task.lastCheck||task.startedAt||Date.now());
    }
  }
  async function followFetchJson(url,{retries=3,timeout=15000,essential=false}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      const timeoutController=new AbortController(),timer=setTimeout(()=>timeoutController.abort(),timeout);
      try{
        const scan=followScanState();
        if(scan)scan.requestCount=(Number(scan.requestCount)||0)+1;
        const res=await fetch(url,{signal:timeoutController.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(res.status===429||res.status===418){const retryAfter=Number(res.headers.get('Retry-After')),err=new Error(`HTTP ${res.status}`);err.retryDelayMs=Number.isFinite(retryAfter)?retryAfter*1000:1500*Math.pow(2,attempt);throw err;}
        if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText}`);return await res.json();
      }catch(e){
        lastErr=e;
        if(attempt<retries){const wait=Number.isFinite(e.retryDelayMs)?e.retryDelayMs:450*Math.pow(2,attempt);await followSleep(wait);}
      }finally{clearTimeout(timer);}
    }
    const msg=`API failed: ${url} → ${lastErr?.message||lastErr}`;
    const scan=followScanState();if(scan?.errors)scan.errors.push(msg);followLog(msg);
    if(essential)throw new Error(msg);return null;
  }
  async function followGetServerTime(){const x=await followFetchJson(`${FOLLOW_BASE}/fapi/v1/time`,{essential:true});return Number(x.serverTime);}
  async function followGetClosedKlines(symbol,interval,serverTime){
    const raw=await followFetchJson(`${FOLLOW_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${FOLLOW_V2_CONFIG.candleLimit+5}`,{retries:2,timeout:15000});
    if(!Array.isArray(raw))throw new Error(`${interval} klines unavailable`);
    const closed=raw.map(followKlineToCandle).filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<serverTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
    if(closed.length<FOLLOW_V2_CONFIG.candleLimit)throw new Error(`${interval} closed candles ${closed.length}/${FOLLOW_V2_CONFIG.candleLimit}`);return closed.slice(-FOLLOW_V2_CONFIG.candleLimit);
  }

  function monitorDot(status){
    const cls=status==='RED'?'red':status==='YELLOW'?'yellow':status==='GREEN'?'green':'off';
    const label=status==='RED'?'EXIT':status==='YELLOW'?'PROTECT':status==='GREEN'?'HOLD':'OFF';
    return `<span class="monitorDot ${cls}" title="${label}" aria-label="${label}"></span>`;
  }
  function setLiveUI(symbol,changeText='',resultText=''){
    const tr=followRow(symbol);if(!tr)return;
    const change=tr.querySelector('[data-role="live-change"]'),result=tr.querySelector('[data-role="live-result"]');
    if(change)change.textContent=changeText||'';
    if(result){
      result.textContent=resultText||'';
      result.className='liveResultCell';
      if(resultText.includes('OICizgiAnalysis EXIT'))result.classList.add('bad');
      else if(resultText.includes('PROTECT'))result.classList.add('warn');
      else if(resultText)result.classList.add('good');
    }
  }

  function liveArrow(delta,epsilon=0){
    if(!Number.isFinite(delta))return '—';
    return delta>epsilon?'↑':delta<-epsilon?'↓':'≈';
  }

  function liveDeltaPct(now,prev){return Number.isFinite(now)&&Number.isFinite(prev)&&prev!==0?(now/prev-1)*100:NaN;}
  function livePctlAbs(value,history,p=FOLLOW_LIVE_CONFIG.spikePercentile,minN=20){
    const a=(history||[]).filter(Number.isFinite).map(Math.abs);if(!Number.isFinite(value)||a.length<minN)return {spike:false,threshold:NaN,ready:false};
    const threshold=followPercentile(a,p);return {spike:Number.isFinite(threshold)&&Math.abs(value)>=threshold,threshold,ready:true};
  }
  function pushRolling(arr,value,maxN){if(Number.isFinite(value)){arr.push(value);while(arr.length>maxN)arr.shift();}}
  function shortDuration(ms){
    if(!Number.isFinite(ms))return '—';const x=Math.max(0,ms),m=Math.floor(x/60000),h=Math.floor(m/60),mm=m%60;
    return h>0?`${h}h${String(mm).padStart(2,'0')}m`:`${m}m`;
  }
  function ratioPoint(x){
    if(!x)return NaN;
    const ls=followNum(x.longShortRatio);if(Number.isFinite(ls))return ls;
    const bs=followNum(x.buySellRatio);if(Number.isFinite(bs))return bs;
    const buy=followNum(x.buyVol),sell=followNum(x.sellVol);return Number.isFinite(buy)&&Number.isFinite(sell)&&sell>0?buy/sell:NaN;
  }
  function ratioDir(rows){
    if(!Array.isArray(rows)||rows.length<2)return {value:rows?.length?ratioPoint(rows.at(-1)):NaN,delta:NaN,arrow:'—'};
    const ordered=rows.slice().sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)),a=ratioPoint(ordered.at(-2)),b=ratioPoint(ordered.at(-1));
    return {value:b,delta:Number.isFinite(a)&&Number.isFinite(b)?b-a:NaN,arrow:liveArrow(Number.isFinite(a)&&Number.isFinite(b)?b-a:NaN)};
  }

  function parseLive1m(raw,serverTime){
    if(!Array.isArray(raw))return [];
    return raw.map(k=>({openTime:Number(k[0]),open:followNum(k[1]),high:followNum(k[2]),low:followNum(k[3]),close:followNum(k[4]),volume:followNum(k[5]),closeTime:Number(k[6]),quoteVolume:followNum(k[7]),takerBuyBase:followNum(k[9])}))
      .filter(c=>c.closeTime<serverTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite));
  }

  function liveOneMinuteStats(rows,priceDelta){
    if(!Array.isArray(rows)||rows.length<3)return {priceSpike:false,volSpike:false,buyShare:NaN,bsSpike:false,bsSide:'MIXED',volumeDir:'—'};
    const last=rows.at(-1),prev=rows.at(-2),hist=rows.slice(0,-1);
    const returns=[];for(let i=1;i<hist.length;i++)if(hist[i-1].close>0)returns.push((hist[i].close/hist[i-1].close-1)*100);
    const priceSpike=livePctlAbs(priceDelta,returns,FOLLOW_LIVE_CONFIG.spikePercentile,20).spike;
    const volBase=hist.slice(-60).map(x=>x.volume).filter(Number.isFinite),volP95=followPercentile(volBase,FOLLOW_LIVE_CONFIG.spikePercentile);
    const volSpike=Number.isFinite(volP95)&&last.volume>=volP95;
    const buy=Math.max(0,followNum(last.takerBuyBase)),sell=Number.isFinite(last.volume)&&Number.isFinite(buy)?Math.max(0,last.volume-buy):NaN,total=Number.isFinite(buy)&&Number.isFinite(sell)?buy+sell:NaN;
    const buyShare=total>0?buy/total:NaN,imb=Number.isFinite(buyShare)?2*buyShare-1:NaN;
    const histImb=hist.slice(-60).map(x=>{const b=Math.max(0,followNum(x.takerBuyBase)),ss=Number.isFinite(x.volume)&&Number.isFinite(b)?Math.max(0,x.volume-b):NaN,t=Number.isFinite(b)&&Number.isFinite(ss)?b+ss:NaN;return t>0?2*(b/t)-1:NaN;}).filter(Number.isFinite);
    const bsSpike=livePctlAbs(imb,histImb,FOLLOW_LIVE_CONFIG.spikePercentile,20).spike;
    const bsSide=Number.isFinite(buyShare)?buyShare>0.5?'BUY':buyShare<0.5?'SELL':'MIXED':'MIXED';
    const volumeDir=liveArrow(Number.isFinite(last.volume)&&Number.isFinite(prev.volume)?last.volume-prev.volume:NaN);
    return {priceSpike,volSpike,buyShare,bsSpike,bsSide,volumeDir,lastVolume:last.volume};
  }

  // === OICizgiAnalysis START (experimental, intentionally isolated for easy removal) ===
  function OICizgiAnalysis(rawRows){
    const rows=Array.isArray(rawRows)?rawRows.map(x=>({oi:followNum(x.sumOpenInterest),value:followNum(x.sumOpenInterestValue),timestamp:Number(x.timestamp)}))
      .filter(x=>Number.isFinite(x.oi)&&Number.isFinite(x.value)&&Number.isFinite(x.timestamp)).sort((a,b)=>a.timestamp-b.timestamp):[];
    if(rows.length<7)return {ready:false,exit:false,lineDown:false,barBelowPreviousPeak:false,latestOi:NaN,previousPeakOi:NaN};
    const last=rows.at(-1),prev=rows.at(-2),lineDown=last.value<prev.value;
    const peaks=[];
    for(let i=2;i<rows.length-2;i++){
      const v=rows[i].oi;
      if(v>rows[i-1].oi&&v>rows[i-2].oi&&v>rows[i+1].oi&&v>rows[i+2].oi)peaks.push(rows[i]);
    }
    const peak=peaks.at(-1)||null,barBelowPreviousPeak=!!peak&&last.oi<peak.oi;
    return {ready:!!peak,exit:!!peak&&lineDown&&barBelowPreviousPeak,lineDown,barBelowPreviousPeak,latestOi:last.oi,latestValue:last.value,previousValue:prev.value,previousPeakOi:peak?.oi??NaN,previousPeakTime:peak?.timestamp??NaN,timestamp:last.timestamp};
  }
  // === OICizgiAnalysis END ===

  async function refreshLive5mContext(task,serverTime){
    const symbol=task.symbol,bucket=Math.floor((serverTime-1)/(5*60*1000));
    if(task.live5m?.bucket===bucket)return task.live5m;
    try{
      const enc=encodeURIComponent(symbol),period=FOLLOW_LIVE_CONFIG.lsPeriod;
      const [lsa,lsp,gls,taker5,oiHist]=await Promise.all([
        followFetchJson(`${FOLLOW_BASE}/futures/data/topLongShortAccountRatio?symbol=${enc}&period=${period}&limit=2`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/futures/data/topLongShortPositionRatio?symbol=${enc}&period=${period}&limit=2`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/futures/data/globalLongShortAccountRatio?symbol=${enc}&period=${period}&limit=2`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/futures/data/takerlongshortRatio?symbol=${enc}&period=${period}&limit=2`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/futures/data/openInterestHist?symbol=${enc}&period=${period}&limit=${FOLLOW_LIVE_CONFIG.oiHistoryLimit}`,{retries:2,timeout:12000})
      ]);
      const ctx={bucket,lsa:ratioDir(lsa),lsp:ratioDir(lsp),gls:ratioDir(gls),taker5:ratioDir(taker5),oiHist:Array.isArray(oiHist)?oiHist:[],oiCizgi:OICizgiAnalysis(oiHist)};
      task.live5m=ctx;return ctx;
    }catch(e){
      followLog(`Follow live 5m context ${symbol}: ${e.message||e}`);
      return task.live5m||{bucket,lsa:{value:NaN,arrow:'—'},lsp:{value:NaN,arrow:'—'},gls:{value:NaN,arrow:'—'},taker5:{value:NaN,arrow:'—'},oiHist:[],oiCizgi:{ready:false,exit:false}};
    }
  }

  function buildLiveFollowAnalysis(task,{serverTime,currentPrice,currentOi,premiumRaw,closed1m,live5m}){
    const prevPrice=task.prevPrice,prevOi=task.prevOi,prevBasis=task.prevBasisPct;
    const priceDelta=liveDeltaPct(currentPrice,prevPrice),oiDelta=liveDeltaPct(currentOi,prevOi);
    const mark=followNum(premiumRaw?.markPrice),index=followNum(premiumRaw?.indexPrice),basisPct=mark>0&&index>0?(mark/index-1)*100:NaN;
    const basisDelta=Number.isFinite(basisPct)&&Number.isFinite(prevBasis)?basisPct-prevBasis:NaN;
    const fundingRate=Number.isFinite(followNum(premiumRaw?.lastFundingRate))?followNum(premiumRaw.lastFundingRate)*100:NaN;
    const nextFunding=Number(premiumRaw?.nextFundingTime),toFunding=Number.isFinite(nextFunding)?nextFunding-serverTime:NaN;
    const one=liveOneMinuteStats(closed1m,priceDelta);
    const oiSpikeInfo=livePctlAbs(oiDelta,task.oiDeltaHistory,FOLLOW_LIVE_CONFIG.spikePercentile,FOLLOW_LIVE_CONFIG.oiSpikeMinSamples);
    const oiSpike=oiSpikeInfo.spike,priceUp=priceDelta>0,priceDown=priceDelta<0,oiUp=oiDelta>0,oiDown=oiDelta<0;
    const buyPressure=one.bsSide==='BUY',sellPressure=one.bsSide==='SELL';
    const priceSpikeUp=one.priceSpike&&priceUp,priceSpikeDown=one.priceSpike&&priceDown,oiSpikeUp=oiSpike&&oiUp,oiSpikeDown=oiSpike&&oiDown;
    const bsSpikeBuy=one.bsSpike&&buyPressure,bsSpikeSell=one.bsSpike&&sellPressure;
    const basisUp=basisDelta>0,basisDown=basisDelta<0;

    const strongBuyer=priceSpikeUp&&oiSpikeUp&&bsSpikeBuy&&(one.volSpike||basisUp);
    const strongSeller=priceSpikeDown&&oiSpikeUp&&bsSpikeSell&&(one.volSpike||basisDown);
    const fastUnwind=priceDown&&oiSpikeDown&&sellPressure&&(one.bsSpike||one.volSpike);
    const shortCover=priceUp&&oiSpikeDown&&buyPressure;
    const newLongSupport=priceUp&&oiUp&&buyPressure;
    const weakUp=priceUp&&oiDown;
    const sellBuild=priceDown&&sellPressure&&(oiUp||oiSpikeDown||one.volSpike);
    const lsaUp=live5m?.lsa?.delta>0,lspUp=live5m?.lsp?.delta>0,glsUp=live5m?.gls?.delta>0;
    const longCrowding=priceDelta<=0&&lsaUp&&lspUp&&glsUp&&fundingRate>0&&basisPct>0;

    let label='NO LIVE EVENT',decision='HOLD';
    if(strongBuyer)label='POSSIBLE LARGE BUYER ACTIVITY • STRONG BUY BUILDUP';
    else if(strongSeller){label='POSSIBLE LARGE SELLER ACTIVITY • STRONG SELL BUILDUP';decision='PROTECT';}
    else if(fastUnwind){label='FAST POSITION UNWINDING • LONG PRESSURE';decision='PROTECT';}
    else if(longCrowding){label='LONG CROWDING / PRICE NOT CONFIRMING';decision='PROTECT';}
    else if(sellBuild){label='SELL PRESSURE';decision='PROTECT';}
    else if(shortCover)label='POSSIBLE SHORT COVERING • UP MOVE LESS SUPPORTED';
    else if(weakUp)label='PRICE UP • OI DOWN • MOVE LESS SUPPORTED';
    else if(newLongSupport)label='BUY SUPPORT • PRICE + OI ALIGNED';
    else if(priceDown&&oiDown)label='PRICE DOWN • OI UNWINDING';
    else if(priceDown&&oiUp)label='PRICE DOWN • NEW OI BUILDUP';

    const sampleSec=Number.isFinite(task.prevLiveTime)?Math.max(1,Math.round((serverTime-task.prevLiveTime)/1000)):NaN;
    const deltaTag=Number.isFinite(sampleSec)&&sampleSec>=45&&sampleSec<=90?'1m':Number.isFinite(sampleSec)?`${Math.max(1,Math.round(sampleSec/60))}m`:'1m';
    const pSpike=one.priceSpike?' ANI':'';
    const oiSpikeTag=oiSpike?' ANI':'';
    const bsText=Number.isFinite(one.buyShare)?`${one.bsSide} ${(one.buyShare*100).toFixed(0)}%${one.bsSpike?' ANI':''}`:'—';
    const volText=one.volSpike?'ANI↑':one.volumeDir;
    const basisText=Number.isFinite(basisPct)?`${followPct(basisPct)} ${liveArrow(basisDelta)}`:'—';
    const fundingText=Number.isFinite(fundingRate)?`${fundingRate>=0?'+':''}${fundingRate.toFixed(4)}%/${shortDuration(toFunding)}`:'—';
    const ratioText=(name,x)=>Number.isFinite(x?.value)?`${name} ${followFmt(x.value,2)}${x.arrow}`:`${name} —`;
    const change=[
      `P${deltaTag} ${followPct(priceDelta)} ${liveArrow(priceDelta)}${pSpike}`,
      `OI${deltaTag} ${followPct(oiDelta)} ${liveArrow(oiDelta)}${oiSpikeTag}`,
      `B/S ${bsText}`,
      `VOL ${volText}`,
      `Basis ${basisText}`,
      `Funding ${fundingText}`,
      ratioText('LSA',live5m?.lsa),ratioText('LSP',live5m?.lsp),ratioText('GLS',live5m?.gls),ratioText('BS5',live5m?.taker5)
    ].join(' | ');

    const oiC=live5m?.oiCizgi||{ready:false,exit:false};
    const oiCText=oiC.exit?'OICizgiAnalysis EXIT':oiC.ready?'OICizgiAnalysis OK':'OICizgiAnalysis CAL';
    const result=`${label} → ${decision} | ${oiCText}`;

    pushRolling(task.oiDeltaHistory,oiDelta,FOLLOW_LIVE_CONFIG.oiSpikeMaxSamples);
    task.prevBasisPct=basisPct;task.prevFundingRate=fundingRate;task.prevLiveTime=serverTime;
    return {change,result,label,decision,priceDelta,oiDelta,basisPct,basisDelta,fundingRate,toFunding,strongBuyer,strongSeller,fastUnwind,longCrowding,sellBuild,oiCizgi:oiC};
  }

  function setMonitorUI(symbol,status,reason,when=Date.now()){
    const tr=followRow(symbol);if(!tr)return;
    const cell=tr.querySelector('.monitorCell'),reasonEl=tr.querySelector('.reasonText'),timeEl=tr.querySelector('.monitorTime'),btn=tr.querySelector('[data-action="follow"]');
    if(cell)cell.innerHTML=monitorDot(status);
    if(reasonEl)reasonEl.textContent=reason||'';
    if(timeEl)timeEl.textContent=status==='OFF'?'':`Last check: ${followFormatDateTime(when)}`;
    if(btn)btn.textContent=status==='OFF'?'Follow':status==='RED'?'Follow Again':'Stop Follow';
    const entry=tr.querySelector('[data-role="entry"]'),stop=tr.querySelector('[data-role="stop"]');
    const lock=status==='GREEN'||status==='YELLOW';if(entry)entry.disabled=lock;if(stop)stop.disabled=lock;
  }

  function stopFollow(symbol,{reason='Follow stopped',reset=true}={}){
    const task=followMonitors.get(symbol);
    if(task?.timer)clearInterval(task.timer);
    followMonitors.delete(symbol);
    if(reset){
      const belongsToCurrentScan=!!followLatestScanRow(symbol);
      if(belongsToCurrentScan){setMonitorUI(symbol,'OFF',reason);setLiveUI(symbol,'','');}
      else followRow(symbol)?.remove();
    }
  }

  function stopAllFollowMonitors(reason='Follow stopped'){
    for(const symbol of [...followMonitors.keys()])stopFollow(symbol,{reason,reset:true});
  }

  function latestSwingPoints(candles){
    const sw=followFindSwings(candles,FOLLOW_V2_CONFIG.swingLeft,FOLLOW_V2_CONFIG.swingRight);
    const high=sw.highs.at(-1),prevHigh=sw.highs.at(-2),low=sw.lows.at(-1),prevLow=sw.lows.at(-2);
    const enrich=x=>x?{...x,time:candles[x.index]?.closeTime??NaN}:null;
    return {high:enrich(high),prevHigh:enrich(prevHigh),low:enrich(low),prevLow:enrich(prevLow),all:sw};
  }

  function lastConfirmedHLPoint(candles){
    const lows=followFindSwings(candles,FOLLOW_V2_CONFIG.swingLeft,FOLLOW_V2_CONFIG.swingRight).lows;
    for(let i=lows.length-1;i>=1;i--)if(lows[i].price>lows[i-1].price)return {...lows[i],time:candles[lows[i].index]?.closeTime??NaN};
    return null;
  }

  function lastConfirmedHHPoint(candles){
    const highs=followFindSwings(candles,FOLLOW_V2_CONFIG.swingLeft,FOLLOW_V2_CONFIG.swingRight).highs;
    for(let i=highs.length-1;i>=1;i--)if(highs[i].price>highs[i-1].price)return {...highs[i],time:candles[highs[i].index]?.closeTime??NaN};
    return null;
  }

  function structureState(candles,ind){
    const t=candles.length-1,atr=ind.atr14[t],tol=Number.isFinite(atr)?FOLLOW_V2_CONFIG.structureAtr*atr:0,{high,prevHigh,low,prevLow}=latestSwingPoints(candles);
    const hs=!high||!prevHigh?'INSUFFICIENT':high.price>prevHigh.price+tol?'HH':high.price<prevHigh.price-tol?'LH':'NEUTRAL';
    const ls=!low||!prevLow?'INSUFFICIENT':low.price>prevLow.price+tol?'HL':low.price<prevLow.price-tol?'LL':'NEUTRAL';
    return {bearish:hs==='LH'&&ls==='LL',bullish:hs==='HH'&&ls==='HL',highStructure:hs,lowStructure:ls,high,prevHigh,low,prevLow,atr};
  }

  function sellingVolumeExpansion(candles){
    if(!Array.isArray(candles)||candles.length<22)return false;
    const t=candles.length-1,c=candles[t],p=candles[t-1],avg=followMean(candles.slice(t-20,t).map(x=>x.volume));
    return Number.isFinite(avg)&&avg>0&&c.close<p.close&&c.volume>avg;
  }

  function monitorNeedsRefresh(task,key,serverTime,intervalMs){
    const bucket=Math.floor((serverTime-1)/intervalMs);
    return !task[key]||task[key].bucket!==bucket;
  }

  async function refreshFollow(symbol){
    const task=followMonitors.get(symbol);if(!task||task.refreshing||task.status==='RED')return;
    task.refreshing=true;
    try{
      const [serverTime,priceRaw,oiRaw,oneMinRaw,premiumRaw]=await Promise.all([
        followGetServerTime(),
        followFetchJson(`${FOLLOW_BASE}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=65`,{retries:2,timeout:12000}),
        followFetchJson(`${FOLLOW_BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,{retries:2,timeout:12000})
      ]);
      const currentPrice=followNum(priceRaw?.price),currentOi=followNum(oiRaw?.openInterest);
      if(!(currentPrice>0))throw new Error('current price unavailable');
      const priceCell=followRow(symbol)?.querySelector('[data-role="current-price"]');
      if(priceCell)priceCell.textContent=followMetaFormatPrice(currentPrice);
      const recent1m=Array.isArray(oneMinRaw)?oneMinRaw.map(followKlineToCandle).filter(c=>[c.high,c.low].every(Number.isFinite)):[];
      const closedLive1m=parseLive1m(oneMinRaw,serverTime);
      const live5m=await refreshLive5mContext(task,serverTime);
      const since=Math.max(0,Number(task.lastCheck)||task.startedAt);
      const active1m=recent1m.filter(c=>c.closeTime>=since);
      const observedHigh=Math.max(currentPrice,...active1m.map(c=>c.high));
      const observedLow=Math.min(currentPrice,...active1m.map(c=>c.low));
      task.tf1={candles:recent1m,observedHigh,observedLow};
      task.highest=Math.max(task.highest||task.entryPrice,observedHigh);

      if(monitorNeedsRefresh(task,'tf15',serverTime,15*60*1000)){
        const candles=await followGetClosedKlines(symbol,'15m',serverTime),ind=followBuildIndicators(candles);
        task.tf15={bucket:Math.floor((serverTime-1)/(15*60*1000)),candles,ind};
        const pts=latestSwingPoints(candles),hl=lastConfirmedHLPoint(candles),hh=lastConfirmedHHPoint(candles);
        if(!Number.isFinite(task.lastHL)&&hl){task.lastHL=hl.price;task.lastHLTime=hl.time;}
        task.lastSeenLowTime=pts.low?.time??task.lastSeenLowTime;
        if(!Number.isFinite(task.lastHH)&&hh){
          task.lastHH=hh.price;task.lastHHTime=hh.time;task.lastHHRSI=ind.rsi14[hh.index];task.lastHHMACD=ind.macd.hist[hh.index];
        }
        task.lastSeenHighTime=pts.high?.time??task.lastSeenHighTime;
      }
      if(monitorNeedsRefresh(task,'tf5',serverTime,5*60*1000)){
        const candles=await followGetClosedKlines(symbol,'5m',serverTime),ind=followBuildIndicators(candles);
        task.tf5={bucket:Math.floor((serverTime-1)/(5*60*1000)),candles,ind,structure:structureState(candles,ind)};
      }
      const fiveBearish=!!task.tf5?.structure?.bearish;
      if(fiveBearish&&monitorNeedsRefresh(task,'tf3',serverTime,3*60*1000)){
        const candles=await followGetClosedKlines(symbol,'3m',serverTime),ind=followBuildIndicators(candles);
        task.tf3={bucket:Math.floor((serverTime-1)/(3*60*1000)),candles,ind,structure:structureState(candles,ind)};
      }

      const red=[],yellow=[],confirm=[],info=[];
      const c15=task.tf15?.candles,i15=task.tf15?.ind;
      if(!c15||!i15)throw new Error('15m monitor data unavailable');
      const t15=c15.length-1,last15=c15[t15],atr15=i15.atr14[t15];

      // 1) Hard stop / maximum accepted loss.
      if(task.stopPrice>0&&observedLow<=task.stopPrice)red.push(`Stop Price hit/touched: 1m low ${followPriceFmt(observedLow)} ≤ ${followPriceFmt(task.stopPrice)}`);

      // 2–4) 15m structure + ATR break + wick/close discipline.
      if(Number.isFinite(task.lastHL)&&atr15>0){
        if(last15.close<task.lastHL){
          const breakRatio=(task.lastHL-last15.close)/atr15;task.lastBreakRatio=breakRatio;
          if(breakRatio>=FOLLOW_CONFIG.atrBreakExit)red.push(`15m HL breakdown: ${followFmt(breakRatio,2)} ATR (HL ${followPriceFmt(task.lastHL)}, Close ${followPriceFmt(last15.close)})`);
          else if(breakRatio>=FOLLOW_CONFIG.atrBreakWarn)yellow.push(`15m HL break warning: ${followFmt(breakRatio,2)} ATR`);
          else info.push(`15m close ${followFmt(breakRatio,2)} ATR below HL; below warning threshold`);
        }else if(last15.low<task.lastHL){
          info.push('15m wick below HL; close recovered above HL');
        }
      }

      // Update confirmed structural references only after evaluating the previous HL/HH.
      const pts15=latestSwingPoints(c15);
      if(pts15.low&&pts15.low.time>Number(task.lastSeenLowTime||0)){
        task.lastSeenLowTime=pts15.low.time;
        const isConfirmedHL=pts15.prevLow&&pts15.low.price>pts15.prevLow.price;
        if(isConfirmedHL){task.lastHL=pts15.low.price;task.lastHLTime=pts15.low.time;}
      }

      // 5–6) 5m warning + 3m confirmation.
      if(fiveBearish){
        yellow.push('5m structure turned LL/LH');
        if(task.tf3?.structure?.bearish)yellow.push('3m confirms LL/LH');
      }

      // 7) 1m is execution-only; it never changes the color.

      // 8–9) 15m EMA slope + Elder-style impulse confirmation.
      const emaNow=i15.ema25[t15],emaPrev=i15.ema25[t15-FOLLOW_V2_CONFIG.emaSlopeBars];
      const slopeThreshold=Number.isFinite(atr15)?FOLLOW_V2_CONFIG.emaSlopeAtr*atr15:0;
      const emaDown=Number.isFinite(emaNow)&&Number.isFinite(emaPrev)&&(emaNow-emaPrev)<-slopeThreshold;
      const macdNow=i15.macd.hist[t15],macdPrev=i15.macd.hist[t15-1];
      const macdDown=Number.isFinite(macdNow)&&Number.isFinite(macdPrev)&&macdNow<macdPrev;
      if(emaDown)yellow.push('15m EMA25 slope DOWN');
      if(emaDown&&macdDown)yellow.push('15m bearish Impulse: EMA↓ + MACD-H↓');

      // 10–11) New confirmed swing-high: failed HH or bearish divergence.
      if(pts15.high&&pts15.high.time>Number(task.lastSeenHighTime||0)){
        const newHigh=pts15.high,oldHH=task.lastHH,oldRSI=task.lastHHRSI,oldMACD=task.lastHHMACD;
        const newRSI=i15.rsi14[newHigh.index],newMACD=i15.macd.hist[newHigh.index];
        task.lastSeenHighTime=newHigh.time;
        if(Number.isFinite(oldHH)){
          if(newHigh.price<=oldHH)yellow.push(`15m failed HH: ${followPriceFmt(newHigh.price)} ≤ ${followPriceFmt(oldHH)}`);
          else{
            const rsiDiv=Number.isFinite(newRSI)&&Number.isFinite(oldRSI)&&newRSI<oldRSI;
            const macdDiv=Number.isFinite(newMACD)&&Number.isFinite(oldMACD)&&newMACD<oldMACD;
            if(rsiDiv||macdDiv)yellow.push(`15m bearish divergence${rsiDiv&&macdDiv?' (RSI + MACD-H)':rsiDiv?' (RSI)':' (MACD-H)'}`);
            task.lastHH=newHigh.price;task.lastHHTime=newHigh.time;task.lastHHRSI=newRSI;task.lastHHMACD=newMACD;
          }
        }else{
          task.lastHH=newHigh.price;task.lastHHTime=newHigh.time;task.lastHHRSI=newRSI;task.lastHHMACD=newMACD;
        }
      }

      // 12) Volume is confirmation only.
      if(sellingVolumeExpansion(task.tf5?.candles)||sellingVolumeExpansion(c15))confirm.push('selling volume expanding');

      // 13) OI is confirmation only; direction is not inferred from OI alone.
      if(Number.isFinite(task.prevPrice)&&Number.isFinite(task.prevOi)&&Number.isFinite(currentOi)&&currentPrice<task.prevPrice&&currentOi>task.prevOi)confirm.push('price ↓ + OI ↑');

      // 14–15) Highest price + ATR trailing + break-even protection.
      if(atr15>0){
        const trailingLevel=task.highest-FOLLOW_CONFIG.trailingAtrMultiple*atr15;task.trailingLevel=trailingLevel;

        // Break-even arms once the trade has reached at least +1 ATR from Entry.
        // Once armed it stays armed for the lifetime of this Follow session.
        if(!task.breakEvenArmed&&task.highest>=task.entryPrice+FOLLOW_CONFIG.breakEvenArmAtr*atr15){
          task.breakEvenArmed=true;task.breakEvenArmedAt=serverTime;
        }

        const effectiveExitLevel=task.breakEvenArmed?Math.max(task.entryPrice,trailingLevel):trailingLevel;
        task.effectiveExitLevel=effectiveExitLevel;

        if(task.breakEvenArmed)info.push(`Break-even armed: exit floor ${followPriceFmt(effectiveExitLevel)}`);

        if(currentPrice<=effectiveExitLevel){
          if(task.breakEvenArmed&&task.entryPrice>=trailingLevel){
            red.push(`Break-even protection hit: Current ${followPriceFmt(currentPrice)} ≤ Entry ${followPriceFmt(task.entryPrice)} after +${followFmt(FOLLOW_CONFIG.breakEvenArmAtr,2)} ATR profit`);
          }else{
            red.push(`ATR trailing hit: Current ${followPriceFmt(currentPrice)} ≤ ${followPriceFmt(effectiveExitLevel)} (Highest ${followPriceFmt(task.highest)})`);
          }
        }
      }

      // 16) Maximum holding period, measured from Follow start.
      if(serverTime-task.startedAt>=FOLLOW_CONFIG.maxHoldMs)red.push('Maximum 4h Follow holding time reached');

      // V11 Follow-only live analysis. It may add PROTECT, but never EXIT on its own.
      // The isolated experimental OICizgiAnalysis below is the sole exception requested by the user.
      const live=buildLiveFollowAnalysis(task,{serverTime,currentPrice,currentOi,premiumRaw,closed1m:closedLive1m,live5m});
      task.liveAnalysis=live;setLiveUI(symbol,live.change,live.result);
      if(live.decision==='PROTECT')yellow.push(`Live Analysis: ${live.label}`);
      if(live.oiCizgi?.exit)red.push(`OICizgiAnalysis EXIT: OI USDT line DOWN + latest OI ${followCompact(live.oiCizgi.latestOi)} < previous peak ${followCompact(live.oiCizgi.previousPeakOi)}`);

      task.prevPrice=currentPrice;task.prevOi=currentOi;task.currentPrice=currentPrice;task.currentOi=currentOi;task.lastCheck=serverTime;
      if(task.rowSnapshot)task.rowSnapshot.snapshot2=currentPrice;

      let status='GREEN',reason='HOLD — no PROTECT / EXIT condition';
      if(red.length){status='RED';reason=red.join(' | ');if(yellow.length)reason+=` | Warnings: ${yellow.join('; ')}`;if(confirm.length)reason+=` | Confirm: ${confirm.join('; ')}`;}
      else if(yellow.length){status='YELLOW';reason=yellow.join(' | ');if(confirm.length)reason+=` | Confirm: ${confirm.join('; ')}`;}
      else if(info.length){reason=`HOLD — ${info.join(' | ')}`;}
      reason+=followProfitLossText(task.entryPrice,currentPrice);
      const previousStatus=task.status;
      task.status=status;task.reason=reason;
      setMonitorUI(symbol,status,reason,serverTime);
      if(status==='RED'&&previousStatus!=='RED')void showFollowExitNotification(symbol,currentPrice,reason);
      if(status==='RED'&&task.timer){clearInterval(task.timer);task.timer=null;}
    }catch(e){
      const taskNow=followMonitors.get(symbol);
      if(taskNow&&taskNow.status!=='RED'){
        taskNow.status='YELLOW';taskNow.reason=`Monitor data error: ${e.message||e}`;
        setMonitorUI(symbol,'YELLOW',taskNow.reason,Date.now());
      }
      followLog(`Follow ${symbol}: ${e.message||e}`);
    }finally{
      const t=followMonitors.get(symbol);if(t)t.refreshing=false;
    }
  }

  async function startFollow(symbol){
    const tr=followRow(symbol);if(!tr)return;
    const existing=followMonitors.get(symbol);
    if(existing&&existing.status!=='RED'){stopFollow(symbol);return;}
    const sourceRow=followLatestScanRow(symbol)||existing?.rowSnapshot||null;
    if(existing&&existing.status==='RED')stopFollow(symbol,{reason:'Restarting Follow',reset:false});
    const entry=followNum(tr.querySelector('[data-role="entry"]')?.value),stop=followNum(tr.querySelector('[data-role="stop"]')?.value);
    if(!(entry>0)){setMonitorUI(symbol,'OFF','Entry Price girilmelidir.');return;}
    if(!(stop>0)){setMonitorUI(symbol,'OFF','Stop Price girilmelidir.');return;}
    if(!(stop<entry)){setMonitorUI(symbol,'OFF','LONG için Stop Price, Entry Price altında olmalıdır.');return;}
    // Follow button click is the user gesture used to request notification permission.
    // Failure/denial never blocks the Follow algorithm.
    await ensureFollowNotificationPermission();
    const now=Date.now();
    const task={symbol,entryPrice:entry,stopPrice:stop,startedAt:now,highest:entry,breakEvenArmed:false,breakEvenArmedAt:0,effectiveExitLevel:NaN,status:'GREEN',reason:'Follow starting',refreshing:false,prevPrice:NaN,prevOi:NaN,prevBasisPct:NaN,prevFundingRate:NaN,prevLiveTime:NaN,oiDeltaHistory:[],live5m:null,liveAnalysis:null,lastHL:NaN,lastHH:NaN,lastSeenLowTime:0,lastSeenHighTime:0,tf15:null,tf5:null,tf3:null,timer:null,rowSnapshot:sourceRow,currentPrice:NaN,currentOi:NaN,lastCheck:now};
    followMonitors.set(symbol,task);setLiveUI(symbol,'','');setMonitorUI(symbol,'GREEN','Follow starting…',now);
    await refreshFollow(symbol);
    const active=followMonitors.get(symbol);if(active&&active.status!=='RED'&&!active.timer)active.timer=setInterval(()=>refreshFollow(symbol),FOLLOW_CONFIG.refreshMs);
  }


  function followProfitLossText(entry,current){
    if(!(Number.isFinite(entry)&&entry>0&&Number.isFinite(current)&&current>0))return '';
    const change=(current/entry-1)*100;
    if(Math.abs(change)<0.005)return ' (P/L 0.00%)';
    return change>0
      ?` (Kar +${change.toFixed(2)}%)`
      :` (Zarar ${change.toFixed(2)}%)`;
  }

  function followAutoStopValue(entry){
    if(!(Number.isFinite(entry)&&entry>0))return '';
    return Number((entry*0.98).toPrecision(12)).toString();
  }

  document.getElementById('candidateBody').addEventListener('input',e=>{
    const input=e.target;
    if(!(input instanceof HTMLInputElement)||input.dataset.role!=='entry')return;
    const tr=input.closest('tr[data-symbol]');if(!tr)return;
    const stopInput=tr.querySelector('[data-role="stop"]');if(!stopInput||stopInput.disabled)return;
    const entry=followNum(input.value);stopInput.value=entry>0?followAutoStopValue(entry):'';
  });

  document.getElementById('candidateBody').addEventListener('click',e=>{
    const btn=e.target.closest?.('[data-action="follow"]');if(!btn)return;
    const symbol=btn.dataset.symbol;if(symbol)startFollow(symbol);
  });

  document.addEventListener('cryptooffer:scan-start',purgeExitedFollowMonitors);
  document.addEventListener('cryptooffer:candidates-rendered',syncFollowUI);

  // Register silently on load; permission itself is never requested until Follow is clicked.
  void followRegisterServiceWorker();

  window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V13.4',modules:{}};
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.follow={config:FOLLOW_CONFIG,liveConfig:FOLLOW_LIVE_CONFIG,getPreservedRows,getActiveSymbols,syncUI:syncFollowUI,purgeExited:purgeExitedFollowMonitors,stopAll:stopAllFollowMonitors};
})();
