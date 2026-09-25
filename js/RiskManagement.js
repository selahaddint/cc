(() => {
  'use strict';

  // ================================================================
  // RISK MANAGEMENT MODULE
  // Owns only: Coin-name click -> PriceLevel + RiskLevel lazy analysis.
  // It reads the selected scan row as data, but calls no Start Scan or
  // Follow function.
  // ================================================================

  const RISK_BASE='https://fapi.binance.com';
  const RISK_CONFIG=Object.freeze({
    priceWeights:{h24:0.45,d7:0.35,d30:0.20},
    riskWindowWeights:{h1:0.35,h4:0.30,h24:0.20,d7:0.15},
    riskWeights:{volatility:0.35,pumpDrop:0.30,volume:0.20,liquidity:0.15},
    minPriceCandles:8,minRiskCandles:12,
    priceLookbackMs:30*24*60*60*1000,riskLookbackMs:7*24*60*60*1000
  });

  const decisionSupportInflight=new Map();
  const riskNum=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN};
  const riskClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const riskMean=values=>{const a=values.filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN};
  const riskPercentile=(arr,p)=>{const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return NaN;if(a.length===1)return a[0];const pos=(a.length-1)*p,lo=Math.floor(pos),hi=Math.ceil(pos),w=pos-lo;return a[lo]*(1-w)+a[hi]*w;};
  const riskMedian=arr=>riskPercentile(arr,.5);
  const riskSleep=ms=>new Promise(r=>setTimeout(r,ms));

  function riskScanState(){return window.CryptoOfferData?.scanState||null;}
  function riskRow(symbol){return [...document.querySelectorAll('#candidateBody tr[data-symbol]')].find(tr=>tr.dataset.symbol===symbol)||null;}
  function riskLog(msg){
    const el=document.getElementById('logBox');if(!el)return;
    const t=new Date().toLocaleTimeString('tr-TR');el.textContent+=`\n[${t}] ${msg}`;el.scrollTop=el.scrollHeight;
  }
  function riskKlineToCandle(k){
    return {openTime:Number(k[0]),open:riskNum(k[1]),high:riskNum(k[2]),low:riskNum(k[3]),close:riskNum(k[4]),volume:riskNum(k[5]),closeTime:Number(k[6]),quoteVolume:riskNum(k[7])};
  }
  async function riskFetchJson(url,{retries=3,timeout=15000,essential=false}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      const scan=riskScanState();
      if(scan?.controller?.signal.aborted)throw new DOMException('Aborted','AbortError');
      const timeoutController=new AbortController();
      const timer=setTimeout(()=>timeoutController.abort(),timeout);
      const onAbort=()=>timeoutController.abort();
      scan?.controller?.signal.addEventListener('abort',onAbort,{once:true});
      try{
        if(scan)scan.requestCount=(Number(scan.requestCount)||0)+1;
        const res=await fetch(url,{signal:timeoutController.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        if(res.status===429||res.status===418){
          const retryAfter=Number(res.headers.get('Retry-After')),err=new Error(`HTTP ${res.status}`);
          err.retryDelayMs=Number.isFinite(retryAfter)?retryAfter*1000:1500*Math.pow(2,attempt);throw err;
        }
        if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      }catch(e){
        lastErr=e;
        if(e.name==='AbortError'&&scan?.controller?.signal.aborted)throw e;
        if(attempt<retries){const wait=Number.isFinite(e.retryDelayMs)?e.retryDelayMs:450*Math.pow(2,attempt);await riskSleep(wait);}
      }finally{clearTimeout(timer);scan?.controller?.signal.removeEventListener('abort',onAbort);}
    }
    const msg=`API failed: ${url} → ${lastErr?.message||lastErr}`;
    const scan=riskScanState();if(scan?.errors)scan.errors.push(msg);riskLog(msg);
    if(essential)throw new Error(msg);return null;
  }

  function decisionClamp01(x){return riskClamp(Number(x),0,1);}

  function decisionWeightedAverage(parts){
    const valid=parts.filter(x=>Number.isFinite(x?.value)&&Number.isFinite(x?.weight)&&x.weight>0);
    const total=valid.reduce((s,x)=>s+x.weight,0);
    return total>0?valid.reduce((s,x)=>s+x.value*x.weight,0)/total:NaN;
  }

  function decisionStdDev(values){
    const a=values.filter(Number.isFinite);if(a.length<2)return NaN;
    const m=riskMean(a),v=a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length;
    return Math.sqrt(v);
  }

  function decisionPercentile01(value,reference){
    const a=reference.filter(Number.isFinite);if(!Number.isFinite(value)||!a.length)return NaN;
    let less=0,equal=0;for(const x of a){if(x<value)less++;else if(x===value)equal++;}
    return (less+0.5*equal)/a.length;
  }

  function decisionLabelPrice(score){
    if(!Number.isFinite(score))return 'N/A';
    if(score<=0.20)return 'VERY LOW';
    if(score<=0.40)return 'LOW';
    if(score<=0.60)return 'NORMAL';
    if(score<=0.80)return 'HIGH';
    return 'VERY HIGH';
  }

  function decisionLabelRisk(score){
    if(!Number.isFinite(score))return 'N/A';
    if(score<=0.25)return 'LOW';
    if(score<=0.50)return 'MEDIUM';
    if(score<=0.75)return 'HIGH';
    return 'VERY HIGH';
  }

  async function decisionFetchKlinesRange(symbol,interval,startTime,endTime){
    const stepMs=interval==='5m'?5*60*1000:interval==='15m'?15*60*1000:NaN;
    if(!Number.isFinite(stepMs))throw new Error(`Unsupported decision-support interval: ${interval}`);
    const out=[];let cursor=Math.max(0,Math.floor(startTime/stepMs)*stepMs),guard=0;
    while(cursor<endTime&&guard++<8){
      const qs=new URLSearchParams({symbol,interval,startTime:String(cursor),endTime:String(endTime),limit:'1500'});
      const raw=await riskFetchJson(`${RISK_BASE}/fapi/v1/klines?${qs}`,{retries:2,timeout:15000});
      if(!Array.isArray(raw)||!raw.length)break;
      for(const k of raw){
        const c=riskKlineToCandle(k);
        if(Number.isFinite(c.closeTime)&&c.closeTime<endTime&&c.openTime>=startTime&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite))out.push(c);
      }
      const lastOpen=Number(raw.at(-1)?.[0]);
      if(!Number.isFinite(lastOpen))break;
      const next=lastOpen+stepMs;
      if(next<=cursor)break;
      cursor=next;
      if(raw.length<1500)break;
    }
    const dedup=new Map();for(const c of out)dedup.set(c.openTime,c);
    return [...dedup.values()].sort((a,b)=>a.openTime-b.openTime);
  }

  function decisionCoverage(candles,cutoff,toleranceMs){
    return Array.isArray(candles)&&candles.length>0&&candles[0].openTime<=cutoff+toleranceMs;
  }

  function computePriceLevel(c15,currentPrice,now){
    const cfg=RISK_CONFIG;
    if(!(currentPrice>0)||!Array.isArray(c15)||c15.length<cfg.minPriceCandles)return {score:NaN,label:'N/A',reason:'insufficient 15m history'};
    const closes=c15.map(c=>c.close).filter(Number.isFinite);
    if(closes.length<cfg.minPriceCandles)return {score:NaN,label:'N/A',reason:'insufficient 15m closes'};

    const cutoff24=now-24*60*60*1000,cutoff7=now-7*24*60*60*1000,cutoff30=now-30*24*60*60*1000;
    const rows24=c15.filter(c=>c.closeTime>=cutoff24),rows7=c15.filter(c=>c.closeTime>=cutoff7),rows30=c15.filter(c=>c.closeTime>=cutoff30);
    const p24=rows24.length>=cfg.minPriceCandles?decisionPercentile01(currentPrice,rows24.map(c=>c.close)):NaN;
    const has7=decisionCoverage(c15,cutoff7,30*60*1000);
    const has30=decisionCoverage(c15,cutoff30,30*60*1000);
    let p7=has7?decisionPercentile01(currentPrice,rows7.map(c=>c.close)):NaN;
    let p30=has30?decisionPercentile01(currentPrice,rows30.map(c=>c.close)):NaN;
    let lifetime=NaN;

    const span=c15.at(-1).closeTime-c15[0].openTime;
    if(!has7&&span>=24*60*60*1000){
      lifetime=decisionPercentile01(currentPrice,closes);
      p7=lifetime;
    }
    let parts=[];
    if(span<24*60*60*1000){
      lifetime=decisionPercentile01(currentPrice,closes);
      parts=[{value:lifetime,weight:1}];
    }else{
      parts=[
        {value:p24,weight:cfg.priceWeights.h24},
        {value:p7,weight:cfg.priceWeights.d7},
        {value:p30,weight:cfg.priceWeights.d30}
      ];
    }
    const score=decisionWeightedAverage(parts);
    return {score,label:decisionLabelPrice(score),p24,p7,p30,lifetime,historyCandles:c15.length};
  }

  function decisionAtrPctSeries(candles,period=14){
    const trPct=candles.map((c,i)=>{
      if(i===0||!(candles[i-1]?.close>0))return NaN;
      const pc=candles[i-1].close,tr=Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc));
      return tr/pc*100;
    });
    const out=new Array(candles.length).fill(NaN);
    for(let i=period;i<candles.length;i++){
      const w=trPct.slice(i-period+1,i+1).filter(Number.isFinite);
      if(w.length===period)out[i]=riskMean(w);
    }
    return out;
  }

  function decisionVolatilityWindow(c5,atrPctSeries,cutoff){
    const idx=[];for(let i=0;i<c5.length;i++)if(c5[i].closeTime>=cutoff)idx.push(i);
    if(idx.length<RISK_CONFIG.minRiskCandles)return NaN;
    const atrVals=idx.map(i=>atrPctSeries[i]).filter(Number.isFinite),atrPct=riskMean(atrVals);
    const rangeVals=idx.map(i=>c5[i].open>0?(c5[i].high-c5[i].low)/c5[i].open*100:NaN).filter(Number.isFinite);
    const returns=idx.map(i=>i>0&&c5[i-1].close>0?(c5[i].close/c5[i-1].close-1)*100:NaN).filter(Number.isFinite);
    const atrNorm=Number.isFinite(atrPct)?decisionClamp01(atrPct/3):NaN;
    const rangeP95=riskPercentile(rangeVals,.95),rangeNorm=Number.isFinite(rangeP95)?decisionClamp01(rangeP95/5):NaN;
    const std=decisionStdDev(returns),stdNorm=Number.isFinite(std)?decisionClamp01(std/2):NaN;
    return decisionWeightedAverage([{value:atrNorm,weight:.50},{value:rangeNorm,weight:.30},{value:stdNorm,weight:.20}]);
  }

  function decisionPumpDropWindow(c5,cutoff){
    const eligible=[];for(let i=0;i<c5.length;i++)if(c5[i].closeTime>=cutoff)eligible.push(i);
    if(eligible.length<RISK_CONFIG.minRiskCandles)return NaN;
    let max15=0,max60=0,maxRev=0;
    for(const i of eligible){
      if(i>=3&&c5[i-3].close>0){
        const signed15=(c5[i].close/c5[i-3].close-1)*100,abs15=Math.abs(signed15);if(abs15>max15)max15=abs15;
        const end=Math.min(c5.length-1,i+12);
        if(end>i&&c5[i].close>0){
          const future=c5.slice(i+1,end+1).map(x=>x.close).filter(Number.isFinite);
          if(future.length){
            let opposite=0;
            if(signed15>0){const lo=Math.min(...future);opposite=Math.max(0,(c5[i].close-lo)/c5[i].close*100);}
            else if(signed15<0){const hi=Math.max(...future);opposite=Math.max(0,(hi/c5[i].close-1)*100);}
            maxRev=Math.max(maxRev,Math.min(abs15,opposite));
          }
        }
      }
      if(i>=12&&c5[i-12].close>0){
        const abs60=Math.abs((c5[i].close/c5[i-12].close-1)*100);if(abs60>max60)max60=abs60;
      }
    }
    const move15Norm=decisionClamp01(max15/10),move1hNorm=decisionClamp01(max60/20),revNorm=decisionClamp01(maxRev/10);
    return decisionWeightedAverage([{value:move15Norm,weight:.40},{value:move1hNorm,weight:.35},{value:revNorm,weight:.25}]);
  }

  function computeVolumeBehaviour(c5,c15,now){
    if(!Array.isArray(c5)||c5.length<15||!Array.isArray(c15)||c15.length<3)return {score:NaN};
    const cur15=c15.at(-1),hist15=c15.filter(c=>c.closeTime<cur15.openTime&&c.closeTime>=now-7*24*60*60*1000);
    const curVol=Number.isFinite(cur15.quoteVolume)&&cur15.quoteVolume>0?cur15.quoteVolume:cur15.volume;
    const histVol=hist15.map(c=>Number.isFinite(c.quoteVolume)&&c.quoteVolume>0?c.quoteVolume:c.volume).filter(x=>x>0);
    const base=riskMedian(histVol),rvol=base>0?curVol/base:NaN;
    const rvolNorm=Number.isFinite(rvol)?decisionClamp01((rvol-1)/5):NaN;

    const vols=c5.map(c=>Number.isFinite(c.quoteVolume)&&c.quoteVolume>0?c.quoteVolume:c.volume);
    const last3=riskMean(vols.slice(-3)),prev12=riskMean(vols.slice(-15,-3)),va=prev12>0?last3/prev12:NaN;
    const vaNorm=Number.isFinite(va)?decisionClamp01((va-1)/4):NaN;

    const prev15=c15.at(-2),absReturn15=prev15?.close>0?Math.abs((cur15.close/prev15.close-1)*100):NaN;
    const pvShock=Number.isFinite(absReturn15)&&Number.isFinite(rvol)?absReturn15*rvol:NaN;
    const pvNorm=Number.isFinite(pvShock)?decisionClamp01(pvShock/20):NaN;
    const score=decisionWeightedAverage([{value:rvolNorm,weight:.35},{value:vaNorm,weight:.25},{value:pvNorm,weight:.40}]);
    return {score,rvol,va,pvShock,absReturn15};
  }

  function decisionOrderBookSlippage(book){
    const bids=(book?.bids||[]).map(([p,q])=>[riskNum(p),riskNum(q)]).filter(([p,q])=>p>0&&q>0);
    const asks=(book?.asks||[]).map(([p,q])=>[riskNum(p),riskNum(q)]).filter(([p,q])=>p>0&&q>0);
    if(!bids.length||!asks.length)return {score:NaN,spreadPct:NaN,slippagePct:NaN,depth:NaN,mid:NaN};
    const bestBid=bids[0][0],bestAsk=asks[0][0],mid=(bestBid+bestAsk)/2;
    const spread=(bestAsk-bestBid)/mid*100,spreadNorm=decisionClamp01(spread/0.20);

    const targetQuote=1000;
    let spent=0,buyQty=0;
    for(const [p,q] of asks){
      const room=targetQuote-spent;if(room<=0)break;
      const takeQty=Math.min(q,room/p);spent+=takeQty*p;buyQty+=takeQty;
    }
    const buySlip=spent>=targetQuote*0.999&&buyQty>0?Math.max(0,(spent/buyQty/bestAsk-1)*100):0.50;

    const targetQty=targetQuote/bestBid;let sold=0,proceeds=0;
    for(const [p,q] of bids){
      const take=Math.min(q,targetQty-sold);if(take<=0)break;
      sold+=take;proceeds+=take*p;
    }
    const sellSlip=sold>=targetQty*0.999&&sold>0?Math.max(0,(1-(proceeds/sold)/bestBid)*100):0.50;
    const slippage=Math.max(buySlip,sellSlip),slippageNorm=decisionClamp01(slippage/0.50);

    const band=.005;let bidDepth=0,askDepth=0;
    for(const [p,q] of bids)if(p>=mid*(1-band))bidDepth+=p*q;
    for(const [p,q] of asks)if(p<=mid*(1+band))askDepth+=p*q;
    const depth=Math.min(bidDepth,askDepth),depthRisk=depth>0?decisionClamp01(1000/depth):1;
    const score=decisionWeightedAverage([{value:spreadNorm,weight:.35},{value:slippageNorm,weight:.45},{value:depthRisk,weight:.20}]);
    return {score,spreadPct:spread,slippagePct:slippage,depth,mid};
  }

  function computeRiskLevel(c5,c15,liquidity,now){
    if(!Array.isArray(c5)||c5.length<RISK_CONFIG.minRiskCandles)return {score:NaN,label:'N/A',reason:'insufficient 5m history'};
    const atrPct=decisionAtrPctSeries(c5,14);
    const specs=[
      {key:'h1',ms:60*60*1000,weight:RISK_CONFIG.riskWindowWeights.h1},
      {key:'h4',ms:4*60*60*1000,weight:RISK_CONFIG.riskWindowWeights.h4},
      {key:'h24',ms:24*60*60*1000,weight:RISK_CONFIG.riskWindowWeights.h24},
      {key:'d7',ms:7*24*60*60*1000,weight:RISK_CONFIG.riskWindowWeights.d7}
    ];
    const vParts=[],pParts=[],windows={};
    for(const s of specs){
      const cutoff=now-s.ms;
      if(!decisionCoverage(c5,cutoff,10*60*1000)&&s.key!=='h1')continue;
      const v=decisionVolatilityWindow(c5,atrPct,cutoff),p=decisionPumpDropWindow(c5,cutoff);
      windows[s.key]={v,p};
      if(Number.isFinite(v))vParts.push({value:v,weight:s.weight});
      if(Number.isFinite(p))pParts.push({value:p,weight:s.weight});
    }
    const V=decisionWeightedAverage(vParts),P=decisionWeightedAverage(pParts),vol=computeVolumeBehaviour(c5,c15,now),VOL=vol.score,L=liquidity?.score;
    const score=decisionWeightedAverage([
      {value:V,weight:RISK_CONFIG.riskWeights.volatility},
      {value:P,weight:RISK_CONFIG.riskWeights.pumpDrop},
      {value:VOL,weight:RISK_CONFIG.riskWeights.volume},
      {value:L,weight:RISK_CONFIG.riskWeights.liquidity}
    ]);
    return {score,label:decisionLabelRisk(score),V,P,VOL,L,windows,volume:vol,liquidity};
  }

  async function computeDecisionSupport(row){
    const now=Date.now(),symbol=row.symbol,start15=now-RISK_CONFIG.priceLookbackMs,start5=now-RISK_CONFIG.riskLookbackMs;
    const [c15,c5,book]=await Promise.all([
      decisionFetchKlinesRange(symbol,'15m',start15,now),
      decisionFetchKlinesRange(symbol,'5m',start5,now),
      riskFetchJson(`${RISK_BASE}/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=100`,{retries:2,timeout:15000})
    ]);
    const liquidity=decisionOrderBookSlippage(book);
    const currentPrice=Number.isFinite(liquidity.mid)&&liquidity.mid>0?liquidity.mid:riskNum(row.snapshot2);
    const priceLevel=computePriceLevel(c15,currentPrice,now);
    const riskLevel=computeRiskLevel(c5,c15,liquidity,now);
    return {loadedAt:now,currentPrice,priceLevel,riskLevel};
  }

  function updateDecisionSupportUI(symbol,data,{loading=false,error=false}={}){
    const tr=riskRow(symbol);if(!tr)return;
    const p=tr.querySelector('[data-role="price-level"]'),r=tr.querySelector('[data-role="risk-level"]'),btn=tr.querySelector('[data-action="decision-support"]');
    if(btn)btn.disabled=loading;
    if(loading){
      if(p){p.textContent='…';p.className='decisionCell loading';p.title='PriceLevel hesaplanıyor…';}
      if(r){r.textContent='…';r.className='decisionCell loading';r.title='RiskLevel hesaplanıyor…';}
      return;
    }
    const pl=data?.priceLevel,rl=data?.riskLevel;
    if(p){
      p.textContent=pl?.label||'N/A';p.className=`decisionCell ${pl?.label==='N/A'?'na':''}`;
      p.title=Number.isFinite(pl?.score)?`PriceScore ${(pl.score*100).toFixed(1)}/100 • 24H ${Number.isFinite(pl.p24)?(pl.p24*100).toFixed(1)+'%':'N/A'} • 7D/Lifetime ${Number.isFinite(pl.p7)?(pl.p7*100).toFixed(1)+'%':'N/A'} • 30D ${Number.isFinite(pl.p30)?(pl.p30*100).toFixed(1)+'%':'N/A'} • Bilgi amaçlıdır; selection değişmez.`:'PriceLevel hesaplanamadı.';
    }
    if(r){
      r.textContent=rl?.label||'N/A';r.className=`decisionCell ${rl?.label==='N/A'?'na':''}`;
      r.title=Number.isFinite(rl?.score)?`RiskScore ${(rl.score*100).toFixed(1)}/100 • V ${Number.isFinite(rl.V)?(rl.V*100).toFixed(1):'N/A'} • P ${Number.isFinite(rl.P)?(rl.P*100).toFixed(1):'N/A'} • VOL ${Number.isFinite(rl.VOL)?(rl.VOL*100).toFixed(1):'N/A'} • L ${Number.isFinite(rl.L)?(rl.L*100).toFixed(1):'N/A'} • Yön tahmini değildir; selection değişmez.`:'RiskLevel hesaplanamadı.';
    }
    if(error&&btn)btn.title='Decision-support hesaplaması başarısız; tekrar tıklanabilir.';
  }

  async function loadDecisionSupport(symbol){
    const scan=riskScanState();if(scan?.running)return;
    const row=(scan?.results||[]).find(x=>x.symbol===symbol);if(!row)return;
    if(row.decisionSupport){updateDecisionSupportUI(symbol,row.decisionSupport);return;}
    if(decisionSupportInflight.has(symbol))return decisionSupportInflight.get(symbol);
    const before=Number(scan?.requestCount)||0;updateDecisionSupportUI(symbol,null,{loading:true});
    const task=(async()=>{
      try{
        const data=await computeDecisionSupport(row);row.decisionSupport=data;updateDecisionSupportUI(symbol,data);
        riskLog(`Lazy PriceLevel/RiskLevel ${symbol}: ${((Number(riskScanState()?.requestCount)||0)-before)} API request • Price=${data.priceLevel.label} (${Number.isFinite(data.priceLevel.score)?(data.priceLevel.score*100).toFixed(1):'N/A'}) • Risk=${data.riskLevel.label} (${Number.isFinite(data.riskLevel.score)?(data.riskLevel.score*100).toFixed(1):'N/A'}).`);
      }catch(e){
        if(e.name==='AbortError')return;
        riskLog(`Lazy PriceLevel/RiskLevel ${symbol} failed: ${e.message||e}`);
        updateDecisionSupportUI(symbol,{priceLevel:{label:'N/A'},riskLevel:{label:'N/A'}},{error:true});
      }finally{decisionSupportInflight.delete(symbol);}
    })();
    decisionSupportInflight.set(symbol,task);return task;
  }


  document.getElementById('candidateBody').addEventListener('click',e=>{
    const btn=e.target.closest?.('[data-action="decision-support"]');
    if(!btn)return;
    const symbol=btn.dataset.symbol;if(symbol)loadDecisionSupport(symbol);
  });
  document.addEventListener('cryptooffer:scan-start',()=>decisionSupportInflight.clear());

  window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V13.4',modules:{}};
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.riskManagement={config:RISK_CONFIG};
})();
