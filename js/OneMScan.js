(() => {
  'use strict';

  // ================================================================
  // ONE MINUTE SCAN MODULE
  // Independent from StartScan. It does not call or modify StartScan rules.
  // Entry discovery rule:
  //   1) last 3 CLOSED 1m candles are UP (Close > Open)
  //   2) closes are rising: C1 < C2 < C3
  //   3) C3 body is not an abnormal late expansion
  // Results are sorted by total 3-candle rise, strongest first.
  // ================================================================

  const BASE='https://fapi.binance.com';
  const CONCURRENCY=6;
  const THIRD_BODY_FLOOR_PCT=0.30;
  const THIRD_BODY_MAX_MULTIPLE=3.0;
  const STABLE_BASES=new Set(['USDC','FDUSD','TUSD','USDP','DAI','USDE','USDS','BUSD','AEUR']);

  const state={running:false,controller:null,startedAt:0,completedAt:0,requestCount:0,results:[],errors:[],activeView:false};
  const $=id=>document.getElementById(id);
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:NaN;};
  const esc=s=>String(s??'').replace(/[&<>\'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  function priceFmt(x){
    if(!Number.isFinite(x))return '—';
    const a=Math.abs(x),d=a>=1000?2:a>=1?4:a>=0.01?6:8;
    return x.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
  }
  function pct(x,d=3){return Number.isFinite(x)?`${x>=0?'+':''}${x.toFixed(d)}%`:'—';}
  function bodyPct(c){return c?.open>0?((c.close/c.open)-1)*100:NaN;}
  function totalRisePct(c1,c3){return c1?.open>0?((c3.close/c1.open)-1)*100:NaN;}
  function requestTime(){return new Intl.DateTimeFormat('tr-TR',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());}

  function setStatus(text,cls='info'){
    const el=$('mainStatus');if(!el)return;
    el.textContent=text;el.className=`status ${cls}`;
  }
  function setProgress(done,total,label='OneM Scan'){
    const p=total>0?Math.max(0,Math.min(100,(done/total)*100)):0;
    const bar=$('progressBar'),pt=$('progressText'),stage=$('stageText');
    if(bar)bar.style.width=`${p.toFixed(1)}%`;
    if(pt)pt.textContent=`${Math.round(p)}%`;
    if(stage)stage.textContent=`${label} ${done}/${total}`;
  }
  function setButtons(running){
    const one=$('oneMScanBtn'),start=$('startBtn'),cancel=$('cancelBtn');
    if(one)one.disabled=running;
    if(start)start.disabled=running||!!$('autoScan')?.checked;
    if(cancel)cancel.disabled=!running;
  }

  function startScanModule(){return window.CryptoFlowScanner?.modules?.startScan||null;}
  function followModule(){return window.CryptoFlowScanner?.modules?.follow||null;}

  async function fetchJson(url,{retries=1,timeout=12000}={}){
    let lastErr;
    for(let attempt=0;attempt<=retries;attempt++){
      if(state.controller?.signal.aborted)throw new DOMException('Aborted','AbortError');
      const local=new AbortController();
      const timer=setTimeout(()=>local.abort(),timeout);
      const onAbort=()=>local.abort();
      state.controller?.signal.addEventListener('abort',onAbort,{once:true});
      try{
        state.requestCount++;
        const res=await fetch(url,{signal:local.signal,cache:'no-store',headers:{Accept:'application/json'}});
        if(res.status===429||res.status===418){
          const retryAfter=Number(res.headers.get('Retry-After'));
          const err=new Error(`HTTP ${res.status}`);
          err.retryDelay=Number.isFinite(retryAfter)?retryAfter*1000:1200*Math.pow(2,attempt);
          throw err;
        }
        if(!res.ok)throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return await res.json();
      }catch(e){
        lastErr=e;
        if(state.controller?.signal.aborted)throw new DOMException('Aborted','AbortError');
        if(attempt<retries)await new Promise(r=>setTimeout(r,Number.isFinite(e.retryDelay)?e.retryDelay:350));
      }finally{
        clearTimeout(timer);
        state.controller?.signal.removeEventListener('abort',onAbort);
      }
    }
    throw lastErr||new Error('Request failed');
  }

  function eligibleSymbols(exchangeInfo){
    const rows=Array.isArray(exchangeInfo?.symbols)?exchangeInfo.symbols:[];
    return rows.filter(s=>
      s?.status==='TRADING' &&
      s?.quoteAsset==='USDT' &&
      s?.contractType==='PERPETUAL' &&
      typeof s?.symbol==='string' &&
      !STABLE_BASES.has(String(s.baseAsset||'').toUpperCase())
    ).map(s=>s.symbol);
  }

  function klineToCandle(k){
    return {openTime:Number(k[0]),open:num(k[1]),high:num(k[2]),low:num(k[3]),close:num(k[4]),volume:num(k[5]),closeTime:Number(k[6])};
  }

  function analyzeLastThree(raw,serverTime,currentPrice){
    if(!Array.isArray(raw))return null;
    const closed=raw.map(klineToCandle)
      .filter(c=>Number.isFinite(c.closeTime)&&c.closeTime<serverTime&&[c.open,c.high,c.low,c.close].every(Number.isFinite));
    if(closed.length<3)return null;
    const [c1,c2,c3]=closed.slice(-3);
    const b1=bodyPct(c1),b2=bodyPct(c2),b3=bodyPct(c3);
    if(!(b1>0&&b2>0&&b3>0))return null;
    if(!(c2.close>c1.close&&c3.close>c2.close))return null;

    // Late-pump guard: C3 may accelerate, but not explode relative to C1/C2.
    // A 0.30% floor avoids rejecting healthy acceleration after two tiny bodies.
    const avg12=(b1+b2)/2;
    const c3Limit=Math.max(THIRD_BODY_FLOOR_PCT,avg12*THIRD_BODY_MAX_MULTIPLE);
    if(b3>c3Limit)return null;

    const rise=totalRisePct(c1,c3);
    const price=Number.isFinite(currentPrice)&&currentPrice>0?currentPrice:c3.close;
    const reason=`3 closed 1m UP • closes rising • 3m ${pct(rise)} • bodies ${pct(b1)}/${pct(b2)}/${pct(b3)} • C3 limit ${pct(c3Limit)}`;
    return {c1,c2,c3,b1,b2,b3,c3Limit,rise,currentPrice:price,reason};
  }

  function buildRow(symbol,a){
    return {
      symbol,
      result:'SELECT',
      decisionPrice:a.currentPrice,
      snapshot2:a.currentPrice,
      oneMScan:{...a},
      gridMeta:{requestTime:requestTime()},
      baseCautions:[a.reason]
    };
  }

  function rowReason(r){
    if(r?.oneMScan?.reason)return r.oneMScan.reason;
    if(r?.chartAnalysis?.reason)return r.chartAnalysis.reason;
    if(r?.result==='SELECT')return 'Active Follow — preserved from previous scan';
    if(r?.result==='CAUTION')return 'Active Follow — preserved from previous scan';
    return 'Active Follow';
  }

  function rowPrice(r){
    const p=Number.isFinite(num(r?.decisionPrice))?num(r.decisionPrice):num(r?.snapshot2);
    return priceFmt(p);
  }

  function renderRow(r,index,isOneM=false){
    const symbol=esc(r.symbol);
    const resultHtml=isOneM
      ? '<span class="pill ready" title="OneMScan: 3 closed 1m UP candles">1M</span>'
      : `<span class="pill ${esc(String(r.result||'SELECT').toLowerCase())}">${esc(r.result||'SELECT')}</span>`;
    const symbolHtml=isOneM
      ? `<span class="symbol">${symbol}</span>`
      : `<button class="symbolBtn" data-action="decision-support" data-symbol="${symbol}" type="button">${symbol}</button>`;
    return `<tr data-symbol="${symbol}">
      <td>${index+1}</td>
      <td class="symbol">${symbolHtml}</td>
      <td data-role="ys"><span class="ysMark unknown">?</span></td>
      <td>${resultHtml}</td>
      <td class="decisionCell na" data-role="price-level">—</td>
      <td class="decisionCell na" data-role="risk-level">—</td>
      <td><input class="monitorInput entryPriceInput" data-role="entry" type="number" min="0" step="any" placeholder="Entry Price" inputmode="decimal"></td>
      <td><input class="monitorInput stopPriceInput" data-role="stop" type="number" min="0" step="any" placeholder="Stop Price" inputmode="decimal"></td>
      <td class="num" data-role="current-price">${esc(rowPrice(r))}</td>
      <td><button class="followBtn" data-action="follow" data-symbol="${symbol}" type="button">Follow</button></td>
      <td class="monitorCell"><span class="monitorDot off" title="OFF" aria-label="OFF"></span></td>
      <td class="monitorReason"><span class="reasonText" title="${esc(rowReason(r))}">${esc(rowReason(r))}</span><div class="monitorTime"></div></td>
      <td class="liveChangeCell" data-role="live-change"></td>
      <td class="liveResultCell" data-role="live-result"></td>
      <td class="num" data-role="meta-volume">—</td>
      <td class="num" data-role="meta-total-supply">—</td>
      <td class="num" data-role="meta-circ-supply">—</td>
      <td class="metaAge" data-role="meta-age">—</td>
      <td class="num" data-role="meta-max">—</td>
      <td class="num" data-role="meta-min">—</td>
      <td data-role="meta-hour">${esc(r?.gridMeta?.requestTime||'—')}</td>
    </tr>`;
  }

  function renderResults(rows){
    const body=$('candidateBody');if(!body)return;
    const preserved=followModule()?.getPreservedRows?.();
    const keep=Array.isArray(preserved)?preserved.filter(r=>r&&typeof r.symbol==='string'):[];
    const keepSymbols=new Set(keep.map(r=>r.symbol));
    const oneOnly=(Array.isArray(rows)?rows:[]).filter(r=>!keepSymbols.has(r.symbol));
    const merged=[...keep,...oneOnly];

    if(!merged.length){
      body.innerHTML='<tr><td colspan="21" class="empty">OneMScan: son 3 kapanmış 1m mum koşulunu sağlayan coin yok.</td></tr>';
    }else{
      body.innerHTML=merged.map((r,i)=>renderRow(r,i,!!r.oneMScan)).join('');
    }
    document.dispatchEvent(new CustomEvent('cryptooffer:candidates-rendered'));
    const title=$('candidateResponseTitle');
    if(title)setTimeout(()=>{if(state.activeView)title.textContent=`OneM Response - ${requestTime().slice(0,5)}`;},0);
  }

  async function mapLimit(items,limit,worker,onProgress){
    const out=new Array(items.length);let next=0,done=0;
    async function run(){
      while(true){
        if(state.controller?.signal.aborted)throw new DOMException('Aborted','AbortError');
        const i=next++;if(i>=items.length)return;
        try{out[i]=await worker(items[i],i);}catch(e){
          if(e?.name==='AbortError')throw e;
          state.errors.push(`${items[i]}: ${e?.message||e}`);out[i]=null;
        }
        done++;onProgress?.(done,items.length);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
    return out;
  }

  async function start(){
    if(state.running)return;
    const normal=startScanModule()?.state;
    if(normal?.running){setStatus('Start Scan çalışırken OneMScan başlatılamaz.','warn');return;}

    state.running=true;state.controller=new AbortController();state.startedAt=Date.now();state.completedAt=0;state.requestCount=0;state.results=[];state.errors=[];state.activeView=true;
    window.CryptoOfferData=window.CryptoOfferData||{};
    window.CryptoOfferData.oneMScanState=state;

    // Prevent an Auto 2m Start Scan from racing this independent scan.
    startScanModule()?.autoScan?.cancel?.();
    setButtons(true);setStatus('OneMScan başlıyor…','info');setProgress(0,1,'OneM Scan');

    try{
      const [server,exchange,pricesRaw]=await Promise.all([
        fetchJson(`${BASE}/fapi/v1/time`,{retries:1}),
        fetchJson(`${BASE}/fapi/v1/exchangeInfo`,{retries:1}),
        fetchJson(`${BASE}/fapi/v1/ticker/price`,{retries:1})
      ]);
      const serverTime=Number(server?.serverTime)||Date.now();
      const symbols=eligibleSymbols(exchange);
      const priceMap=new Map((Array.isArray(pricesRaw)?pricesRaw:[]).map(x=>[x.symbol,num(x.price)]));
      if(!symbols.length)throw new Error('Aktif USDT-M coin bulunamadı.');

      setStatus(`OneMScan: ${symbols.length} coin üzerinde son 3 kapanmış 1m mum kontrol ediliyor…`,'info');
      setProgress(0,symbols.length,'OneM Scan');

      const analyzed=await mapLimit(symbols,CONCURRENCY,async symbol=>{
        const raw=await fetchJson(`${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=4`,{retries:1,timeout:10000});
        const a=analyzeLastThree(raw,serverTime,priceMap.get(symbol));
        return a?buildRow(symbol,a):null;
      },(done,total)=>setProgress(done,total,'OneM Scan'));

      const rows=analyzed.filter(Boolean).sort((a,b)=>(b.oneMScan?.rise??-Infinity)-(a.oneMScan?.rise??-Infinity));
      state.results=rows;state.completedAt=Date.now();
      renderResults(rows);
      setProgress(symbols.length,symbols.length,'OneM Scan');
      setStatus(`OneMScan tamamlandı: ${rows.length} coin bulundu • ${symbols.length} coin kontrol edildi • ${state.requestCount} request${state.errors.length?` • ${state.errors.length} hata`:''}.`,'good');
    }catch(e){
      if(e?.name==='AbortError'){
        setStatus('OneMScan iptal edildi.','warn');
      }else{
        setStatus(`OneMScan hata: ${e?.message||e}`,'bad');
      }
    }finally{
      state.running=false;state.controller=null;setButtons(false);
      if($('autoScan')?.checked)startScanModule()?.autoScan?.schedule?.();
    }
  }

  function cancel(){if(state.running&&state.controller&&!state.controller.signal.aborted)state.controller.abort();}

  const oneBtn=$('oneMScanBtn');if(oneBtn)oneBtn.addEventListener('click',()=>void start());
  const cancelBtn=$('cancelBtn');if(cancelBtn)cancelBtn.addEventListener('click',cancel);
  document.addEventListener('cryptooffer:scan-start',()=>{state.activeView=false;});

  window.CryptoOfferData=window.CryptoOfferData||{};
  window.CryptoOfferData.oneMScanState=state;
  window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V14.23',modules:{}};
  window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};
  window.CryptoFlowScanner.modules.oneMScan={state,start,cancel,config:{concurrency:CONCURRENCY,thirdBodyFloorPct:THIRD_BODY_FLOOR_PCT,thirdBodyMaxMultiple:THIRD_BODY_MAX_MULTIPLE}};
})();
