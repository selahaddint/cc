(() => {
  'use strict';

  // ================================================================
  // FOLLOW 3m/1m MODULE
  // Owns only: Entry/Stop interaction, Follow start/stop, live monitor,
  // HOLD/PROTECT/EXIT rules and live OI/flow analysis.
  // It calls no Start Scan or Risk Management function.
  // ================================================================

  const FOLLOW_BASE='https://fapi.binance.com';
  const FOLLOW_MAX_HOLD_MS=60*60*1000;
  const FOLLOW_CONFIG=Object.freeze({refreshMs:15*1000,atrBreakWarn:0.25,atrBreakExit:0.50,trailingAtrMultiple:2,breakEvenArmAtr:1,maxHoldMs:FOLLOW_MAX_HOLD_MS});
  const FOLLOW_LIVE_CONFIG=Object.freeze({spikePercentile:0.95,priceHistoryMinutes:60,oiSpikeMinSamples:10,oiSpikeMaxSamples:60,lsPeriod:'5m',oiHistoryLimit:30,oiCizgiEnabled:false});
  const FOLLOW_DIAG_CONFIG=Object.freeze({snapshotMs:5*60*1000,maxEntries:40});
  const FOLLOW_V2_CONFIG=Object.freeze({
    candleLimit:300,swingLeft:2,swingRight:2,structureAtr:0.10,emaSlopeBars:3,emaSlopeAtr:0.05,
    rangeEmaGapAtr:0.50,rangeBars:10,rangeMinEachSide:3,valueAtr:0.15,pullbackLookback:5,deepPullbackAtr:0.50,
    breakoutLookback:20,breakoutAtr:0.10,retestAtr:0.20,retestMaxBars:4,volumeSma:20,rsiPeriod:14,rsiMin:50,rsiMax:70,
    atrPeriod:14,atrPercentileLookback:100,atrPercentileMin:30,atrPercentileMax:80,triggerAtr5:0.05,noChaseAtr15:0.50,triggerValidBars:2
  });

  const followMonitors=new Map();
  // Keeps the original scan-row model for symbols that have been followed.
  // The cache is separate from followMonitors so a row can be re-used if Follow is restarted.
  const followRowCache=new Map();
  const followRowDomCache=new Map();
  const followNum=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const followFmt=(x,d=2)=>Number.isFinite(x)?x.toFixed(d):'—';
  const followPct=x=>Number.isFinite(x)?`${x>=0?'+':''}${x.toFixed(3)}%`:'—';
  const followCompact=x=>{if(!Number.isFinite(x))return '—';return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(x);};
  const followSleep=ms=>new Promise(r=>setTimeout(r,ms));

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

  function followScanSource(tr){
    return String(tr?.dataset?.scanSource||tr?.querySelector('[data-role="scan-source"]')?.textContent||window.CryptoOfferData?.activeScanSource||'Unknown').trim()||'Unknown';
  }

  const FOLLOW_AUTO531_SOURCE='Auto 5m-3m-1m Scan';
  function followBtcImpactApi(){return window.BTCImpact3m1m||null;}
  function followBtcImpactSummary(task){
    if(!task?.btcImpact)return '';
    const api=followBtcImpactApi(task);
    return String(api?.summaryText?.(task.btcImpact)||task.btcImpact?.level||'').trim();
  }
  function followAuto531EntryImpact(symbol,preservedRow=null){
    const fromRow=preservedRow?.btcImpact5m3m1m;
    if(fromRow&&typeof fromRow==='object')return fromRow;
    const fromEntry=window.CryptoOfferData?.btcImpact5m3m1mEntries?.[symbol];
    return fromEntry&&typeof fromEntry==='object'?fromEntry:null;
  }
  function snapshotFollowRow(symbol,entryPrice,stopPrice,scanSource){
    const tr=followRow(symbol);if(!tr)return null;
    const clone=tr.cloneNode(true);
    clone.dataset.followPreserved='true';
    clone.dataset.scanSource=scanSource||followScanSource(tr);
    const entry=clone.querySelector('[data-role="entry"]'),stop=clone.querySelector('[data-role="stop"]');
    if(entry){entry.value=String(entryPrice);entry.setAttribute('value',String(entryPrice));}
    if(stop){stop.value=String(stopPrice);stop.setAttribute('value',String(stopPrice));}
    const sourceCell=clone.querySelector('[data-role="scan-source"]');
    if(sourceCell)sourceCell.textContent=clone.dataset.scanSource;
    followRowDomCache.set(symbol,clone);
    return clone;
  }
  function ensureFollowRowDom(task){
    if(!task||task.status==='RED')return null;
    const body=document.getElementById('candidateBody');if(!body)return null;
    let tr=followRow(task.symbol);
    const session=String(task.startedAt||'');
    const isOwned=tr&&tr.dataset.followSession===session;
    const hasControls=tr&&tr.querySelector('[data-role="entry"]')&&tr.querySelector('[data-role="stop"]')&&tr.querySelector('[data-action="follow"]');
    if(!isOwned||!hasControls){
      const cached=task.preservedDom||followRowDomCache.get(task.symbol);
      if(cached){
        const clone=cached.cloneNode(true);
        clone.dataset.followPreserved='true';
        clone.dataset.followSession=session;
        clone.dataset.scanSource=task.scanSource||clone.dataset.scanSource||'Unknown';
        const sourceCell=clone.querySelector('[data-role="scan-source"]');if(sourceCell&&sourceCell.textContent!==clone.dataset.scanSource)sourceCell.textContent=clone.dataset.scanSource;
        if(tr)tr.replaceWith(clone);else body.prepend(clone);
        tr=clone;
      }
    }
    if(tr){
      tr.dataset.followPreserved='true';tr.dataset.followSession=session;tr.dataset.scanSource=task.scanSource||tr.dataset.scanSource||'Unknown';
      const sourceCell=tr.querySelector('[data-role="scan-source"]');if(sourceCell&&sourceCell.textContent!==tr.dataset.scanSource)sourceCell.textContent=tr.dataset.scanSource;
      if(body.firstElementChild!==tr)body.prepend(tr);
    }
    return tr;
  }
  async function followFetchJson(url,{retries=3,timeout=15000,essential=false}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      const timeoutController=new AbortController(),timer=setTimeout(()=>timeoutController.abort(),timeout);
      try{
        const res=await fetch(url,{signal:timeoutController.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(res.status===429||res.status===418){const retryAfter=Number(res.headers.get('Retry-After')),err=new Error(`HTTP ${res.status}`);err.retryDelayMs=Number.isFinite(retryAfter)?retryAfter*1000:1500*Math.pow(2,attempt);throw err;}
        if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText}`);return await res.json();
      }catch(e){
        lastErr=e;
        if(attempt<retries){const wait=Number.isFinite(e.retryDelayMs)?e.retryDelayMs:450*Math.pow(2,attempt);await followSleep(wait);}
      }finally{clearTimeout(timer);}
    }
    const msg=`API failed: ${url} → ${lastErr?.message||lastErr}`;
    followLog(msg);
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
      const ctx={bucket,lsa:ratioDir(lsa),lsp:ratioDir(lsp),gls:ratioDir(gls),taker5:ratioDir(taker5),oiHist:Array.isArray(oiHist)?oiHist:[],oiCizgi:FOLLOW_LIVE_CONFIG.oiCizgiEnabled?OICizgiAnalysis(oiHist):{enabled:false,ready:false,exit:false}};
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
    const deltaTag=Number.isFinite(sampleSec)?(sampleSec<60?`${sampleSec}s`:sampleSec>=45&&sampleSec<=90?'1m':`${Math.max(1,Math.round(sampleSec/60))}m`):'15s';
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
    const oiCText=FOLLOW_LIVE_CONFIG.oiCizgiEnabled?(oiC.exit?'OICizgiAnalysis EXIT':oiC.ready?'OICizgiAnalysis OK':'OICizgiAnalysis CAL'):'OICizgiAnalysis OFF';
    const result=`${label} → ${decision} | ${oiCText}`;

    pushRolling(task.oiDeltaHistory,oiDelta,FOLLOW_LIVE_CONFIG.oiSpikeMaxSamples);
    task.prevBasisPct=basisPct;task.prevFundingRate=fundingRate;task.prevLiveTime=serverTime;
    return {change,result,label,decision,priceDelta,oiDelta,basisPct,basisDelta,fundingRate,toFunding,strongBuyer,strongSeller,fastUnwind,longCrowding,sellBuild,oiCizgi:oiC,buyShare:one.buyShare,bsSide:one.bsSide,volumeDir:one.volumeDir,volSpike:one.volSpike,priceSpike:one.priceSpike,oiSpike};
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

  function followDisplayedPrice(symbol){
    const text=followRow(symbol)?.querySelector('[data-role="current-price"]')?.textContent?.trim();
    if(!text)return NaN;
    return followNum(text.replace(/,/g,''));
  }


  function followPctValue(base,value){
    return Number.isFinite(Number(base))&&Number(base)>0&&Number.isFinite(Number(value))&&Number(value)>0
      ?(Number(value)/Number(base)-1)*100:NaN;
  }

  function followDiagNumber(value,digits=4){
    const n=Number(value);return Number.isFinite(n)?Number(n.toFixed(digits)):null;
  }
  function followDiagWatchSnapshot(symbol,tr=null){
    try{
      const auto=null;
      if(auto)return {status:String(auto.status||''),label:'AUTO31',reason:String(auto.reason||''),metrics:{confirmCount:Number(auto.confirmCount)||0,confirmed:!!auto.confirmed,btcImpact:auto.btcImpact||null}};
    }catch(_){}
    const cell=(tr||followRow(symbol))?.querySelector?.('td[data-role="watch-status"]');
    const badge=cell?.querySelector?.('.watchSignal');
    const label=badge?.textContent?.trim();
    const reason=badge?.getAttribute?.('title')||'';
    return label||reason?{status:'',label:String(label||''),reason:String(reason||''),metrics:null}:null;
  }

  function followDiagLine(x){
    if(!x)return '';
    const t=followFormatDateTime(x.at);
    const pnl=Number.isFinite(x.pnlPct)?followPct(x.pnlPct):'—';
    const hi=Number.isFinite(x.highestPnlPct)?followPct(x.highestPnlPct):'—';
    const lo=Number.isFinite(x.lowestPnlPct)?followPct(x.lowestPnlPct):'—';
    const dd=Number.isFinite(x.drawdownFromHighPct)?followPct(x.drawdownFromHighPct):'—';
    const s5=x.structure5m||'—',s3=x.structure3m||'—';
    const oi=Number.isFinite(x.oiDeltaPct)?followPct(x.oiDeltaPct):'—';
    const bs=Number.isFinite(x.buySharePct)?`${x.bsSide||'MIXED'} ${x.buySharePct.toFixed(1)}%`:(x.bsSide||'—');
    const btc=x.btc||'—';
    const flags=(x.flags||[]).join('; ')||'—';
    return `${x.phase} ${t} | +${x.elapsedMin}m | P=${followPriceFmt(x.price)} PnL=${pnl} RunHi=${hi} RunLo=${lo} DD=${dd} | 3m=${s5} 1m=${s3} | OIΔ=${oi} B/S=${bs} | BTC=${btc} | ${x.status} | ${flags}`;
  }

  function followDiagnosticText(task){
    const lines=(task?.diagnostics||[]).map(followDiagLine).filter(Boolean);
    const watch=task?.entryWatchSignal;
    const watchLine=watch?`ENTRY WATCH | ${watch.status||watch.label||'—'} | ${watch.reason||'—'}`:'ENTRY WATCH | —';
    const source=`SOURCE | ${String(task?.scanSource||'Unknown')} | Entry=${followPriceFmt(Number(task?.entryPrice))} Stop=${followPriceFmt(Number(task?.stopPrice))} MaxHold=${Math.round(FOLLOW_CONFIG.maxHoldMs/60000)}m`;
    return [source,watchLine,...lines].join('\n');
  }

  function followRecordDiagnostic(task,{at=Date.now(),phase='SNAPSHOT',price=NaN,observedLow=NaN,status='',red=[],yellow=[],confirm=[],info=[],live=null,force=false}={}){
    if(!task)return;
    task.diagnostics=Array.isArray(task.diagnostics)?task.diagnostics:[];
    const now=Number(at)||Date.now();
    const previous=task.diagnostics.at(-1);
    const p=Number(price),low=Number(observedLow);
    const currentPnl=followPctValue(task.entryPrice,p);
    const highPnl=followPctValue(task.entryPrice,Number(task.highest));
    const lowPnl=followPctValue(task.entryPrice,low);
    task.diagHighestPnl=Number.isFinite(highPnl)?Math.max(Number.isFinite(task.diagHighestPnl)?task.diagHighestPnl:-Infinity,highPnl):task.diagHighestPnl;
    task.diagLowestPnl=Number.isFinite(lowPnl)?Math.min(Number.isFinite(task.diagLowestPnl)?task.diagLowestPnl:Infinity,lowPnl):task.diagLowestPnl;

    const statusChanged=String(status||'')!==String(task.lastDiagStatus||'');
    const due=!Number.isFinite(Number(task.lastDiagnosticAt))||now-Number(task.lastDiagnosticAt)>=FOLLOW_DIAG_CONFIG.snapshotMs;
    if(!force&&!statusChanged&&!due)return;
    const highestPrice=Number(task.highest);
    const drawdownFromHighPct=Number.isFinite(p)&&p>0&&Number.isFinite(highestPrice)&&highestPrice>0?(p/highestPrice-1)*100:NaN;
    const five=task.tf5?.structure,three=task.tf3?.structure;
    const btc=followBtcImpactSummary(task);
    const flags=[...red.map(x=>`EXIT:${x}`),...yellow.map(x=>`WARN:${x}`),...confirm.map(x=>`CONF:${x}`)];
    if(!flags.length&&Array.isArray(info)&&info.length)flags.push(...info.map(x=>`INFO:${x}`));

    const entry={
      at:now,phase:String(phase||'SNAPSHOT'),
      elapsedMin:Math.max(0,Math.round((now-Number(task.startedAt||now))/60000)),
      price:followDiagNumber(p,10),
      pnlPct:followDiagNumber(currentPnl,4),
      highestPnlPct:followDiagNumber(task.diagHighestPnl,4),
      lowestPnlPct:followDiagNumber(task.diagLowestPnl,4),
      drawdownFromHighPct:followDiagNumber(drawdownFromHighPct,4),
      observedLow:followDiagNumber(low,10),
      structure5m:five?`${five.highStructure}/${five.lowStructure}`:null,
      structure3m:three?`${three.highStructure}/${three.lowStructure}`:null,
      oi:followDiagNumber(task.currentOi,4),
      oiDeltaPct:followDiagNumber(live?.oiDelta,4),
      buySharePct:Number.isFinite(live?.buyShare)?Number((live.buyShare*100).toFixed(2)):null,
      bsSide:live?.bsSide||null,
      volumeDir:live?.volumeDir||null,
      volSpike:!!live?.volSpike,
      basisPct:followDiagNumber(live?.basisPct,5),
      fundingPct:followDiagNumber(live?.fundingRate,5),
      liveDecision:live?.decision||null,
      liveLabel:live?.label||null,
      btc:btc||null,
      status:String(status||task.status||''),
      flags
    };
    task.diagnostics.push(entry);
    while(task.diagnostics.length>FOLLOW_DIAG_CONFIG.maxEntries)task.diagnostics.shift();
    task.lastDiagnosticAt=now;
    task.lastDiagStatus=String(status||task.status||'');
    return entry;
  }

  function emitFollowReport(task,{closeType='EXIT',exitPrice=NaN,reason='',closedAt=Date.now()}={}){
    if(!task?.symbol||!(Number(task.entryPrice)>0)||!(Number(task.stopPrice)>0)||task.reportClosed)return;
    task.reportClosed=true;
    const finalPrice=Number.isFinite(Number(exitPrice))?Number(exitPrice):followDisplayedPrice(task.symbol);
    document.dispatchEvent(new CustomEvent('cryptooffer:follow-complete',{detail:{
      followKey:`${task.symbol}|${task.startedAt}`,
      symbol:task.symbol,
      startedAt:Number(task.startedAt)||Date.now(),
      closedAt:Number(closedAt)||Date.now(),
      entryPrice:Number(task.entryPrice),
      stopPrice:Number(task.stopPrice),
      exitPrice:Number.isFinite(finalPrice)?finalPrice:null,
      reason:String(reason||''),
      diagnosticLog:followDiagnosticText(task),
      diagnostics:Array.isArray(task.diagnostics)?task.diagnostics.slice():[],
      diagnosticSummary:{
        highestPnlPct:followDiagNumber(task.diagHighestPnl,4),
        lowestPnlPct:followDiagNumber(task.diagLowestPnl,4),
        maxHoldMinutes:Math.round(FOLLOW_CONFIG.maxHoldMs/60000),
        snapshotMinutes:Math.round(FOLLOW_DIAG_CONFIG.snapshotMs/60000)
      },
      closeType:String(closeType||'EXIT'),
      scanSource:String(task.scanSource||task.preservedRow?.scanSource||'Unknown')
    }}));
  }

  function stopFollow(symbol,{reason='Follow stopped',reset=true}={}){
    const task=followMonitors.get(symbol);
    if(task?.timer)clearInterval(task.timer);
    followMonitors.delete(symbol);
    const tr=followRow(symbol);if(tr){delete tr.dataset.followSession;delete tr.dataset.followPreserved;}
    if(reset){setMonitorUI(symbol,'OFF',reason);setLiveUI(symbol,'','');}
  }

  function stopAllFollowMonitors(reason='New scan started'){
    for(const symbol of [...followMonitors.keys()])stopFollow(symbol,{reason,reset:true});
  }

  function cloneFollowRowModel(row){
    if(!row||typeof row.symbol!=='string')return null;
    try{return typeof structuredClone==='function'?structuredClone(row):row;}catch(_){return row;}
  }

  function captureFollowRowModel(symbol,existingTask=null){
    // A Follow can be started from LONG StartScan, SHORT StartScan or OneMScan.
    // Pick the newest scanner state so an older scan containing the same symbol
    // cannot overwrite the row model that is actually visible when Follow is clicked.
    const scannerStates=[
      window.CryptoOfferData?.scanState,
      window.CryptoOfferData?.shortScanState,
      window.CryptoOfferData?.oneMScanState,
      window.CryptoOfferData?.bookScanState,
      window.CryptoOfferData?.coinScanState,
      window.CryptoOfferData?.coinScanForShortState,
      window.CryptoOfferData?.rangeBreakoutState,
      window.CryptoOfferData?.squeezeLongState,
      window.CryptoOfferData?.longEntryConfirmState,
      window.CryptoOfferData?.rangeSqueezeLongState,
      window.CryptoOfferData?.auto3m1mScanState,
      window.CryptoOfferData?.auto531State,
      window.CryptoOfferData?.auto153State
    ].filter(Boolean).sort((a,b)=>(Number(b?.startedAt)||0)-(Number(a?.startedAt)||0));

    let fromLatestScan=null;
    for(const scannerState of scannerStates){
      const rows=scannerState?.results;
      const found=Array.isArray(rows)?rows.find(r=>r?.symbol===symbol):null;
      if(found){fromLatestScan=found;break;}
    }

    let model=cloneFollowRowModel(fromLatestScan)||cloneFollowRowModel(existingTask?.preservedRow)||cloneFollowRowModel(followRowCache.get(symbol));
    if(!model){
      const tr=followRow(symbol),displayed=followDisplayedPrice(symbol);
      model={symbol,result:String(tr?.querySelector('.pill')?.textContent||'SELECT').trim().toUpperCase()||'SELECT',snapshot2:displayed,decisionPrice:displayed,price:displayed};
    }
    model.scanSource=existingTask?.scanSource||model.scanSource||followScanSource(followRow(symbol));
    if(model)followRowCache.set(symbol,model);
    return model;
  }

  function getPreservedRows(){
    const rows=[];
    for(const task of followMonitors.values()){
      // Only an active Follow is persistent across a new scan. EXIT/RED is finished.
      if(!task||task.status==='RED')continue;
      const model=cloneFollowRowModel(task.preservedRow)||cloneFollowRowModel(followRowCache.get(task.symbol));
      if(model)rows.push(model);
    }
    return rows;
  }

  function restoreFollowRowsUI(){
    for(const task of followMonitors.values()){
      if(!task||task.status==='RED')continue;
      const tr=ensureFollowRowDom(task);if(!tr)continue;
      const entry=tr.querySelector('[data-role="entry"]'),stop=tr.querySelector('[data-role="stop"]');
      if(entry)entry.value=String(task.entryPrice);
      if(stop)stop.value=String(task.stopPrice);
      const price=tr.querySelector('[data-role="current-price"]');
      if(price&&Number.isFinite(task.currentPrice))price.textContent=followMetaFormatPrice(task.currentPrice);
      setMonitorUI(task.symbol,task.status,task.reason,Number(task.lastCheck)||task.startedAt||Date.now());
      setLiveUI(task.symbol,task.liveAnalysis?.change||'',task.liveAnalysis?.result||'');
    }
  }

  function latestSwingPoints(candles){
    const sw=followFindSwings(candles,FOLLOW_V2_CONFIG.swingLeft,FOLLOW_V2_CONFIG.swingRight);
    const high=sw.highs.at(-1),prevHigh=sw.highs.at(-2),low=sw.lows.at(-1),prevLow=sw.lows.at(-2);
    const enrich=x=>x?{...x,time:candles[x.index]?.closeTime??NaN}:null;
    return {high:enrich(high),prevHigh:enrich(prevHigh),low:enrich(low),prevLow:enrich(prevLow),all:sw};
  }

  function lastConfirmedHLPoint(candles,ind,entryPrice=NaN){
    const sw=followFindSwings(candles,FOLLOW_V2_CONFIG.swingLeft,FOLLOW_V2_CONFIG.swingRight),lows=sw.lows,highs=sw.highs;
    const lastClose=candles.at(-1)?.close;
    for(let i=lows.length-1;i>=1;i--){
      const low=lows[i],prevLow=lows[i-1],atr=ind?.atr14?.[low.index];
      const tol=Number.isFinite(atr)?FOLLOW_V2_CONFIG.structureAtr*atr:0;
      if(!(low.price>prevLow.price+tol))continue;
      if(Number.isFinite(entryPrice)&&!(low.price<entryPrice))continue;
      if(Number.isFinite(lastClose)&&lastClose<low.price)continue;

      // A higher swing-low is only structural HL after price subsequently makes
      // a confirmed swing-high above the swing-high that preceded that low.
      const priorHigh=highs.filter(h=>h.index<low.index).at(-1)||null;
      if(!priorHigh)continue;
      const confirmingHigh=highs.find(h=>{
        if(h.index<=low.index)return false;
        const highAtr=ind?.atr14?.[h.index];
        const highTol=Number.isFinite(highAtr)?FOLLOW_V2_CONFIG.structureAtr*highAtr:0;
        return h.price>priorHigh.price+highTol;
      });
      if(!confirmingHigh)continue;
      return {...low,time:candles[low.index]?.closeTime??NaN,confirmedByHigh:confirmingHigh.price,confirmedAt:candles[confirmingHigh.index]?.closeTime??NaN};
    }
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
      const [serverTime,priceRaw,oiRaw,fastRaw,premiumRaw]=await Promise.all([
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

      const recentFast=Array.isArray(fastRaw)?fastRaw.map(followKlineToCandle).filter(c=>[c.high,c.low,c.close].every(Number.isFinite)):[];
      const closedFast=parseLive1m(fastRaw,serverTime);
      const liveFlow=false?await refreshLive5mContext(task,serverTime):{lsa:{value:NaN,arrow:'—'},lsp:{value:NaN,arrow:'—'},gls:{value:NaN,arrow:'—'},taker5:{value:NaN,arrow:'—'},oiHist:[],oiCizgi:{enabled:false,ready:false,exit:false}};
      const isFirstFollowCheck=!Number.isFinite(Number(task.lastCheck));
      const since=Math.max(0,Number(task.lastCheck)||task.startedAt);
      const activeFast=isFirstFollowCheck?[]:recentFast.filter(c=>c.closeTime>=since);
      const observedHigh=isFirstFollowCheck?currentPrice:Math.max(currentPrice,...activeFast.map(c=>c.high));
      const observedLow=isFirstFollowCheck?currentPrice:Math.min(currentPrice,...activeFast.map(c=>c.low));
      task.tfExec={candles:recentFast,observedHigh,observedLow,timeframe:'1m'};
      task.highest=Math.max(task.highest||task.entryPrice,observedHigh);

      if(monitorNeedsRefresh(task,'tfPrimary',serverTime,3*60*1000)){
        const initializeSwingTracking=!task.tfPrimary;
        const candles=await followGetClosedKlines(symbol,'3m',serverTime),ind=followBuildIndicators(candles);
        task.tfPrimary={bucket:Math.floor((serverTime-1)/3*60*1000),candles,ind,structure:structureState(candles,ind),timeframe:'3m'};
        const pts=latestSwingPoints(candles),hl=lastConfirmedHLPoint(candles,ind,task.entryPrice),hh=lastConfirmedHHPoint(candles);
        if(!task.hlInitialized){
          task.hlInitialized=true;
          if(hl&&hl.price<task.entryPrice&&candles.at(-1)?.close>=hl.price){task.lastHL=hl.price;task.lastHLTime=hl.time;}
        }
        if(initializeSwingTracking)task.lastSeenLowTime=pts.low?.time??task.lastSeenLowTime;
        if(!Number.isFinite(task.lastHH)&&hh){task.lastHH=hh.price;task.lastHHTime=hh.time;task.lastHHRSI=ind.rsi14[hh.index];task.lastHHMACD=ind.macd.hist[hh.index];}
        if(initializeSwingTracking)task.lastSeenHighTime=pts.high?.time??task.lastSeenHighTime;
      }

      if(monitorNeedsRefresh(task,'tfSecondary',serverTime,1*60*1000)){
        const candles=true
          ?closedFast.slice(-FOLLOW_V2_CONFIG.candleLimit)
          :await followGetClosedKlines(symbol,'1m',serverTime);
        if(candles.length>=30){
          const ind=followBuildIndicators(candles);
          task.tfSecondary={bucket:Math.floor((serverTime-1)/1*60*1000),candles,ind,structure:structureState(candles,ind),timeframe:'1m'};
        }
      }
      const secondaryBearish=!!task.tfSecondary?.structure?.bearish;

      if(false&&(secondaryBearish||!task.tfConfirm)&&monitorNeedsRefresh(task,'tfConfirm',serverTime,1*60*1000)){
        const candles=true
          ?closedFast.slice(-FOLLOW_V2_CONFIG.candleLimit)
          :await followGetClosedKlines(symbol,'1m',serverTime);
        if(candles.length>=30){
          const ind=followBuildIndicators(candles);
          task.tfConfirm={bucket:Math.floor((serverTime-1)/1*60*1000),candles,ind,structure:structureState(candles,ind),timeframe:'1m'};
        }
      }

      task.tf5=task.tfPrimary;task.tf3=task.tfSecondary;task.tf1=task.tfSecondary||task.tfExec;

      const red=[],yellow=[],confirm=[],info=[];
      const cp=task.tfPrimary?.candles,ip=task.tfPrimary?.ind;
      if(!cp||!ip)throw new Error('3m monitor data unavailable');
      const tp=cp.length-1,lastP=cp[tp],atrP=ip.atr14[tp];

      if(task.stopPrice>0&&observedLow<=task.stopPrice)red.push(`Stop Price hit/touched: 1m low ${followPriceFmt(observedLow)} ≤ ${followPriceFmt(task.stopPrice)}`);

      if(Number.isFinite(task.lastHL)&&atrP>0){
        if(lastP.close<task.lastHL){
          const breakRatio=(task.lastHL-lastP.close)/atrP;task.lastBreakRatio=breakRatio;
          if(breakRatio>=FOLLOW_CONFIG.atrBreakExit)red.push(`3m HL breakdown: ${followFmt(breakRatio,2)} ATR (HL ${followPriceFmt(task.lastHL)}, Close ${followPriceFmt(lastP.close)})`);
          else if(breakRatio>=FOLLOW_CONFIG.atrBreakWarn)yellow.push(`3m HL break warning: ${followFmt(breakRatio,2)} ATR`);
          else info.push(`3m close ${followFmt(breakRatio,2)} ATR below HL; below warning threshold`);
        }else if(lastP.low<task.lastHL)info.push('3m wick below HL; close recovered above HL');
      }

      const ptsP=latestSwingPoints(cp);
      if(ptsP.low&&ptsP.low.time>Number(task.lastSeenLowTime||0)){
        task.lastSeenLowTime=ptsP.low.time;
        const lowAtr=ip.atr14[ptsP.low.index],lowTol=Number.isFinite(lowAtr)?FOLLOW_V2_CONFIG.structureAtr*lowAtr:0;
        const isHigherLow=!!ptsP.prevLow&&ptsP.low.price>ptsP.prevLow.price+lowTol;
        if(isHigherLow){
          const priorHigh=ptsP.all.highs.filter(h=>h.index<ptsP.low.index).at(-1)||null;
          task.pendingHL=priorHigh?{price:ptsP.low.price,time:ptsP.low.time,index:ptsP.low.index,previousLow:ptsP.prevLow.price,confirmAbove:priorHigh.price,confirmHighIndex:priorHigh.index}:null;
        }else task.pendingHL=null;
      }
      if(task.pendingHL){
        const p=task.pendingHL;
        const confirmingHigh=ptsP.all.highs.find(h=>{
          if(h.index<=p.index)return false;
          const highAtr=ip.atr14[h.index],highTol=Number.isFinite(highAtr)?FOLLOW_V2_CONFIG.structureAtr*highAtr:0;
          return h.price>p.confirmAbove+highTol;
        });
        if(confirmingHigh){
          const candidateAtr=ip.atr14[p.index],candidateTol=Number.isFinite(candidateAtr)?FOLLOW_V2_CONFIG.structureAtr*candidateAtr:0;
          if(!Number.isFinite(task.lastHL)||p.price>task.lastHL+candidateTol){task.lastHL=p.price;task.lastHLTime=p.time;}
          task.pendingHL=null;
        }
      }

      if(secondaryBearish){
        yellow.push('1m structure turned LL/LH');
        if(false&&task.tfConfirm?.structure?.bearish)yellow.push('1m confirms LL/LH');
      }

      const emaNow=ip.ema25[tp],emaPrev=ip.ema25[tp-FOLLOW_V2_CONFIG.emaSlopeBars];
      const slopeThreshold=Number.isFinite(atrP)?FOLLOW_V2_CONFIG.emaSlopeAtr*atrP:0;
      const emaDown=Number.isFinite(emaNow)&&Number.isFinite(emaPrev)&&(emaNow-emaPrev)<-slopeThreshold;
      const macdNow=ip.macd.hist[tp],macdPrev=ip.macd.hist[tp-1];
      const macdDown=Number.isFinite(macdNow)&&Number.isFinite(macdPrev)&&macdNow<macdPrev;
      if(emaDown)yellow.push('3m EMA25 slope DOWN');
      if(emaDown&&macdDown)yellow.push('3m bearish Impulse: EMA↓ + MACD-H↓');

      if(ptsP.high&&ptsP.high.time>Number(task.lastSeenHighTime||0)){
        const newHigh=ptsP.high,oldHH=task.lastHH,oldRSI=task.lastHHRSI,oldMACD=task.lastHHMACD;
        const newRSI=ip.rsi14[newHigh.index],newMACD=ip.macd.hist[newHigh.index];
        task.lastSeenHighTime=newHigh.time;
        if(Number.isFinite(oldHH)){
          if(newHigh.price<=oldHH)yellow.push(`3m failed HH: ${followPriceFmt(newHigh.price)} ≤ ${followPriceFmt(oldHH)}`);
          else{
            const rsiDiv=Number.isFinite(newRSI)&&Number.isFinite(oldRSI)&&newRSI<oldRSI;
            const macdDiv=Number.isFinite(newMACD)&&Number.isFinite(oldMACD)&&newMACD<oldMACD;
            if(rsiDiv||macdDiv)yellow.push(`3m bearish divergence${rsiDiv&&macdDiv?' (RSI + MACD-H)':rsiDiv?' (RSI)':' (MACD-H)'}`);
            task.lastHH=newHigh.price;task.lastHHTime=newHigh.time;task.lastHHRSI=newRSI;task.lastHHMACD=newMACD;
          }
        }else{task.lastHH=newHigh.price;task.lastHHTime=newHigh.time;task.lastHHRSI=newRSI;task.lastHHMACD=newMACD;}
      }

      if(sellingVolumeExpansion(task.tfSecondary?.candles)||sellingVolumeExpansion(cp))confirm.push('selling volume expanding');
      if(Number.isFinite(task.prevPrice)&&Number.isFinite(task.prevOi)&&Number.isFinite(currentOi)&&currentPrice<task.prevPrice&&currentOi>task.prevOi)confirm.push('price ↓ + OI ↑');

      if(atrP>0){
        const trailingLevel=task.highest-FOLLOW_CONFIG.trailingAtrMultiple*atrP;task.trailingLevel=trailingLevel;
        if(!task.breakEvenArmed&&task.highest>=task.entryPrice+FOLLOW_CONFIG.breakEvenArmAtr*atrP){task.breakEvenArmed=true;task.breakEvenArmedAt=serverTime;}
        const effectiveExitLevel=task.breakEvenArmed?Math.max(task.entryPrice,trailingLevel):trailingLevel;
        task.effectiveExitLevel=effectiveExitLevel;
        if(task.breakEvenArmed)info.push(`Break-even armed: exit floor ${followPriceFmt(effectiveExitLevel)}`);
        if(currentPrice<=effectiveExitLevel){
          if(task.breakEvenArmed&&task.entryPrice>=trailingLevel)red.push(`Break-even protection hit: Current ${followPriceFmt(currentPrice)} ≤ Entry ${followPriceFmt(task.entryPrice)} after +${followFmt(FOLLOW_CONFIG.breakEvenArmAtr,2)} ATR profit`);
          else red.push(`ATR trailing hit: Current ${followPriceFmt(currentPrice)} ≤ ${followPriceFmt(effectiveExitLevel)} (Highest ${followPriceFmt(task.highest)})`);
        }
      }

      if(serverTime-task.startedAt>=FOLLOW_CONFIG.maxHoldMs)red.push(`Maximum ${Math.round(FOLLOW_CONFIG.maxHoldMs/60000)}m Follow holding time reached`);

      const live=buildLiveFollowAnalysis(task,{serverTime,currentPrice,currentOi,premiumRaw,closed1m:closedFast,live5m:liveFlow});
      task.liveAnalysis=live;setLiveUI(symbol,live.change,live.result);
      if(live.decision==='PROTECT')yellow.push(`Live Analysis: ${live.label}`);
      if(FOLLOW_LIVE_CONFIG.oiCizgiEnabled&&live.oiCizgi?.exit)red.push(`OICizgiAnalysis EXIT: OI USDT line DOWN + latest OI ${followCompact(live.oiCizgi.latestOi)} < previous peak ${followCompact(live.oiCizgi.previousPeakOi)}`);

      const btcApi=window.BTCImpact3m1m;
      if(btcApi?.analyze){
        try{
          const btc=await btcApi.analyze(symbol);
          task.btcImpact=btc;task.btcImpactError=null;
          const btcText=btcApi.summaryText?.(btc)||`BTC ${btc.level}`;
          if(btc.followDecision==='PROTECT')yellow.push(`BTC 3m/1m PROTECT • ${btcText}`);
          else if(btc.level==='POSITIVE')info.push(`BTC 3m/1m supportive • ${btcText}`);
          else if((btc.level==='NEGATIVE'||btc.level==='STRONG_NEGATIVE')&&Number.isFinite(Number(btc.relativeStrengthPct))&&Number(btc.relativeStrengthPct)>0)info.push(`BTC negative but coin relatively strong • ${btcText}`);
        }catch(e){task.btcImpactError=String(e?.message||e);followLog(`BTC Impact ${symbol}: ${e?.message||e}`);}
      }

      task.prevPrice=currentPrice;task.prevOi=currentOi;task.currentPrice=currentPrice;task.currentOi=currentOi;task.lastCheck=serverTime;
      let status='GREEN',reason='HOLD — no PROTECT / EXIT condition';
      if(red.length){status='RED';reason=red.join(' | ');if(yellow.length)reason+=` | Warnings: ${yellow.join('; ')}`;if(confirm.length)reason+=` | Confirm: ${confirm.join('; ')}`;}
      else if(yellow.length){status='YELLOW';reason=yellow.join(' | ');if(confirm.length)reason+=` | Confirm: ${confirm.join('; ')}`;}
      else if(info.length){reason=`HOLD — ${info.join(' | ')}`;}
      reason+=followProfitLossText(task.entryPrice,currentPrice);
      const previousStatus=task.status;
      task.status=status;task.reason=reason;
      setMonitorUI(symbol,status,reason,serverTime);
      const diagPhase=isFirstFollowCheck?'ENTRY':status==='RED'?'EXIT':status!==previousStatus?'STATUS':'SNAPSHOT';
      followRecordDiagnostic(task,{at:serverTime,phase:diagPhase,price:currentPrice,observedLow,status,red,yellow,confirm,info,live,force:isFirstFollowCheck||status==='RED'||status!==previousStatus});
      if(status==='RED'&&previousStatus!=='RED')emitFollowReport(task,{closeType:'EXIT',exitPrice:currentPrice,reason,closedAt:serverTime});
      if(status==='RED'&&task.timer){clearInterval(task.timer);task.timer=null;}
    }catch(e){
      const taskNow=followMonitors.get(symbol);
      if(taskNow&&taskNow.status!=='RED'){taskNow.status='YELLOW';taskNow.reason=`Monitor data error: ${e.message||e}`;setMonitorUI(symbol,'YELLOW',taskNow.reason,Date.now());}
      followLog(`Follow ${symbol}: ${e.message||e}`);
    }finally{const t=followMonitors.get(symbol);if(t)t.refreshing=false;}
  }

  async function startFollow(symbol){
    const tr=followRow(symbol);if(!tr)return false;
    const existing=followMonitors.get(symbol);
    if(existing&&existing.status!=='RED'){
      const manualReason='Manual Follow Stop';
      const manualPrice=Number.isFinite(existing.currentPrice)?existing.currentPrice:followDisplayedPrice(symbol);
      followRecordDiagnostic(existing,{at:Date.now(),phase:'MANUAL',price:manualPrice,observedLow:manualPrice,status:existing.status,red:[],yellow:[],confirm:[],info:[manualReason],live:existing.liveAnalysis,force:true});
      emitFollowReport(existing,{closeType:'MANUAL',exitPrice:manualPrice,reason:manualReason,closedAt:Date.now()});
      stopFollow(symbol,{reason:manualReason,reset:true});
      return false;
    }
    if(existing&&existing.status==='RED')stopFollow(symbol,{reason:'Restarting Follow',reset:false});
    const entry=followNum(tr.querySelector('[data-role="entry"]')?.value),stop=followNum(tr.querySelector('[data-role="stop"]')?.value);
    if(!(entry>0)){setMonitorUI(symbol,'OFF','Entry Price girilmelidir.');return false;}
    if(!(stop>0)){setMonitorUI(symbol,'OFF','Stop Price girilmelidir.');return false;}
    if(!(stop<entry)){setMonitorUI(symbol,'OFF','LONG için Stop Price, Entry Price altında olmalıdır.');return false;}
    const now=Date.now();
    const scanSource=followScanSource(tr);
    const preservedRow=captureFollowRowModel(symbol,existing);if(preservedRow)preservedRow.scanSource=scanSource;
    const preservedDom=snapshotFollowRow(symbol,entry,stop,scanSource);
    const entryBtcImpact=(preservedRow?.btcImpact3m1m&&typeof preservedRow.btcImpact3m1m==='object')
      ?preservedRow.btcImpact3m1m
      :(window.CryptoOfferData?.btcImpact3m1mEntries?.[symbol]||null);
    const task={symbol,entryPrice:entry,stopPrice:stop,scanSource,startedAt:now,highest:entry,breakEvenArmed:false,breakEvenArmedAt:0,effectiveExitLevel:NaN,status:'GREEN',reason:'Follow starting',refreshing:false,prevPrice:NaN,prevOi:NaN,prevBasisPct:NaN,prevFundingRate:NaN,prevLiveTime:NaN,oiDeltaHistory:[],live5m:null,liveAnalysis:null,btcImpact:entryBtcImpact,btcImpactError:null,lastHL:NaN,lastHH:NaN,lastSeenLowTime:0,lastSeenHighTime:0,pendingHL:null,hlInitialized:false,tf15:null,tf5:null,tf3:null,timer:null,preservedRow,preservedDom,entryWatchSignal:followDiagWatchSnapshot(symbol,tr),diagnostics:[],lastDiagnosticAt:NaN,lastDiagStatus:'',diagHighestPnl:0,diagLowestPnl:0};
    tr.dataset.followSession=String(now);tr.dataset.followPreserved='true';tr.dataset.scanSource=scanSource;
    followMonitors.set(symbol,task);setLiveUI(symbol,'','');setMonitorUI(symbol,'GREEN','Follow starting…',now);
    await refreshFollow(symbol);
    const active=followMonitors.get(symbol);if(active&&active.status!=='RED'&&!active.timer)active.timer=setInterval(()=>refreshFollow(symbol),FOLLOW_CONFIG.refreshMs);
    // A valid Follow session was started even if its very first refresh immediately
    // decided EXIT/RED. Returning true prevents Watch from repeatedly re-starting it.
    return true;
  }


  function followProfitLossText(entry,current){
    if(!(Number.isFinite(entry)&&entry>0&&Number.isFinite(current)&&current>0))return '';
    const change=(current/entry-1)*100;
    return ` (${change>=0?'+':''}${change.toFixed(2)}%)`;
  }

  function followAutoStopValue(entry){
    if(!(Number.isFinite(entry)&&entry>0))return '';
    return Number((entry*0.98).toPrecision(12)).toString();
  }

  

  const auto3m1mFollowPending=new Map();

  function auto3m1mEntryPrice(detail,tr){
    const row=detail?.row||{};
    const candidates=[detail?.entryPrice,row?.decisionPrice,row?.snapshot2,row?.price,followDisplayedPrice(detail?.symbol)];
    for(const value of candidates){
      const n=followNum(value);if(Number.isFinite(n)&&n>0)return n;
    }
    const currentText=tr?.querySelector('[data-role="current-price"]')?.textContent?.trim();
    return followNum(String(currentText||'').replace(/,/g,''));
  }

  async function startAuto3m1mFollow(detail){
    const symbol=String(detail?.symbol||detail?.row?.symbol||'').trim().toUpperCase();
    if(!symbol)return false;

    const existing=followMonitors.get(symbol);
    if(existing&&existing.status!=='RED'){
      auto3m1mFollowPending.delete(symbol);
      return true;
    }

    const tr=followRow(symbol);
    if(!tr){
      auto3m1mFollowPending.set(symbol,{...detail,symbol});
      return false;
    }

    const entryInput=tr.querySelector('[data-role="entry"]');
    const stopInput=tr.querySelector('[data-role="stop"]');
    const entry=auto3m1mEntryPrice({...detail,symbol},tr);
    if(!(entry>0)){
      followLog(`Auto3m1m Follow ${symbol}: valid entry price unavailable.`);
      auto3m1mFollowPending.set(symbol,{...detail,symbol});
      return false;
    }

    // Test-stage execution contract: SELECT decision price becomes the simulated
    // Follow entry. Stop keeps the existing Follow default (2% below entry).
    if(entryInput){entryInput.value=String(entry);entryInput.setAttribute('value',String(entry));}
    const requestedStop=followNum(detail?.row?.stopPrice);
    const stop=Number.isFinite(requestedStop)&&requestedStop>0&&requestedStop<entry
      ? requestedStop
      : followNum(followAutoStopValue(entry));
    if(stopInput&&stop>0){stopInput.value=String(stop);stopInput.setAttribute('value',String(stop));}

    auto3m1mFollowPending.delete(symbol);
    followLog(`Auto3m1m FINAL SELECT ${symbol}: Follow auto-start. Entry=${followPriceFmt(entry)} Stop=${followPriceFmt(stop)}.`);
    await startFollow(symbol);
    return true;
  }

  function drainAuto3m1mFollowPending(){
    for(const detail of [...auto3m1mFollowPending.values()]){
      if(followRow(detail.symbol))void startAuto3m1mFollow(detail);
    }
  }


  window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V13.4',modules:{}};
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.follow31={
    config:FOLLOW_CONFIG,
    liveConfig:FOLLOW_LIVE_CONFIG,
    diagnosticConfig:FOLLOW_DIAG_CONFIG,
    source:'Auto 3m-1m Scan',
    profile:'3m/1m',
    startFollow,
    startAuto3m1mFollow,
    drainPending:drainAuto3m1mFollowPending,
    stopFollow,
    isFollowing:symbol=>{const t=followMonitors.get(String(symbol||'').trim().toUpperCase());return !!t&&t.status!=='RED';},
    getActiveSymbols:()=>[...followMonitors.values()].filter(t=>t&&t.status!=='RED').map(t=>t.symbol),
    getDiagnostics:symbol=>{const t=followMonitors.get(String(symbol||'').trim().toUpperCase());return t?{log:followDiagnosticText(t),entries:Array.isArray(t.diagnostics)?t.diagnostics.slice():[]}:null;},
    getPreservedRows,
    restoreRowsUI:restoreFollowRowsUI
  };
})();
