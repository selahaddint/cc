/* Browser-only line scanners + candlestick visualization. No Watch/Follow integration. */
(function(global){
  'use strict';
  const Core=global.FrozenLineCore;
  const configs=Core.STRATEGIES;
  const ids=['4h1h','1h15m','15m5m'];
  const shell=document.getElementById('frozenLineChart');
  const chartTitle=document.getElementById('frozenLineChartTitle');
  const chartStatus=document.getElementById('frozenLineChartStatus');
  const chartCanvas=document.getElementById('frozenLineChartGraphic');
  const chartLevels=document.getElementById('frozenLineChartLevels');
  const candidateBody=document.getElementById('candidateBody');
  const status=document.getElementById('mainStatus');
  const progress=document.getElementById('progressBar');
  const progressText=document.getElementById('progressText');
  const stage=document.getElementById('stageText');
  const title=document.getElementById('candidateResponseTitle');
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const formatPrice=v=>Number.isFinite(v)&&v>0?Number(v.toPrecision(12)).toString():'—';
  const time=t=>new Date(t).toLocaleString('tr-TR',{timeZone:'Europe/Istanbul',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const sellNames=['sell1','sell2','sell3','sell4'];
  // FROZEN equations produce raw HH/LH levels, not an ordered support/resistance ladder.
  // Preserve all raw prices; only SELL strictly ABOVE BUY1 is an upper resistance line.
  function sellPositions(levels){
    if(!levels)return [];
    return sellNames.map(name=>({name,price:levels[name],position:
      levels[name]>levels.buy1?'above':levels[name]>=levels.buy2?'inside':'below'}));
  }
  function sourceStrategy(source){
    const value=String(source||'').trim();
    return ids.find(id=>configs[id].source===value)||null;
  }
  let selectedSymbol='';
  let activeTab='4h1h';
  let chartRequest=0;
  let scanController=null;
  let scanRunning=false;
  let scannerResults=[];

  function statusText(text,cls='info') {
    if(status) {status.textContent=text;status.classList.remove('good','warn','bad','info');status.classList.add(cls);}
  }
  function progressUpdate(p,text){
    const value=Math.max(0,Math.min(100,p));
    if(progress)progress.style.width=`${value}%`;
    if(progressText)progressText.textContent=`${Math.round(value)}%`;
    if(stage)stage.textContent=text;
  }
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function scan(id,signal,report=()=>{}) {
    const universe=await global.CoinUniverse.getAllowedCoinsArray();
    const config=configs[id];
    if(!config)throw Error('Scan stratejisi bulunamadı.');
    const found=[];
    const errors=[];
    let checked=0, next=0, stopped=false;
    const worker=async()=>{
      while(!signal.aborted&&!stopped){
        const pos=next++;
        if(pos>=universe.length)break;
        const symbol=universe[pos];
        try{
          // A low-weight 2-candle REST prescreen avoids fetching two full
          // histories for every coin. This is an exact prerequisite of SELECT.
          const tail=await Core.loadPrescreen(symbol,config.lower,signal);
          const last=tail[tail.length-1];
          if(last && last.close>last.open){
            const {levels}=await Core.load(symbol,id,signal);
            if(levels && Core.qualifies(levels)){
              // Browser has no trustworthy live position without a valid current ASK.
              // Never substitute the previous candle close for a missing quote.
              const ask=await Core.bestAsk(symbol,signal);
              const entryType=ask!==null?Core.entryMode(levels,ask):null;
              if(entryType){
                found.push({symbol,result:'SELECT',scanSource:config.source,strategy:id,
                  price:ask,levels,entryType,distanceFromBuy2Pct:((ask/levels.buy2)-1)*100,
                  setupTime:levels.setupTime,profitRoom:levels.target(ask)/ask});
              }
            }
          }
        }catch(error){
          if(signal.aborted)break;
          errors.push({symbol,message:String(error?.message||error)});
          if(/Binance REST (418|429)\b/.test(String(error?.message||''))){stopped=true;break;}
        }finally{
          checked++;
          if(checked%5===0||checked===universe.length)report({checked,total:universe.length,found:found.length,errors:errors.length});
        }
        // Throttle as each deep-history call has nontrivial Binance request weight.
        if(!signal.aborted)await pause(700);
      }
    };
    await Promise.all(Array.from({length:3},()=>worker()));
    found.sort((a,b)=>b.profitRoom-a.profitRoom || a.symbol.localeCompare(b.symbol));
    return {found,errors,checked,total:universe.length,limited:stopped,aborted:signal.aborted};
  }

  function renderCandidates(rows,id){
    if(!candidateBody)return;
    const config=configs[id];
    // This is a display-only result: no inputs, follow buttons, or Watch kickoff.
    const html=rows.map((r,i)=>{
      const l=r.levels;
      return `<tr data-symbol="${escape(r.symbol)}" data-scan-source="${escape(config.source)}" data-line-only="true">
        <td>${i+1}</td><td class="symbol"><button class="symbolBtn" data-action="decision-support" type="button">${escape(r.symbol)}</button></td>
        <td data-role="ys">—</td><td data-role="watch-status"><span class="watchSignal off">—</span></td>
        <td><span class="pill select" title="Grafiği aç">SELECT</span></td><td>—</td><td>—</td>
        <td class="num">${escape(formatPrice(l.buy1))}</td><td class="num">${escape(formatPrice(l.buy2))}</td>
        <td class="num" data-role="current-price">${escape(formatPrice(r.price))}</td>
        <td>—</td><td>—</td>
        <td class="monitorReason"><span class="reasonText" title="Son kapanmış mum + güncel ASK, BUY2 ±%15 penceresinde; BUY2 altında kırmızıdan yeşile dönüş zorunlu; üstte BUY1 sınırı ve geçerli SELL hedefi korunur">${r.entryType==='RECOVERY_BELOW_BUY2'?'BUY2 Recovery':'BUY Zone'} • BUY2 ${r.distanceFromBuy2Pct>=0?'+':''}${escape(r.distanceFromBuy2Pct.toFixed(2))}%</span></td>
        <td class="liveChangeCell">—</td><td class="liveResultCell">SELL target: ${escape(formatPrice(l.target(r.price)))}</td>
        <td data-role="scan-source">${escape(config.source)}</td></tr>`;
    }).join('');
    candidateBody.innerHTML=html||'<tr><td colspan="16" class="empty">FROZEN90 için SELECT bulunamadı.</td></tr>';
    title.textContent=`${config.source} · ${rows.length} SELECT`;
    // Existing app uses this event to keep old rows and source cells consistent.
    // It does not launch Watch or Follow; these scan rows contain no Follow action.
    document.dispatchEvent(new CustomEvent('cryptooffer:candidates-rendered'));
  }

  async function startScan(id){
    if(scanRunning) {statusText('FROZEN90 taraması devam ediyor. Önce Cancel kullan.','warn');return;}
    closeChart();
    scannerResults=[];
    scanController=new AbortController();
    scanRunning=true;
    for(const i of ids){const b=document.getElementById('frozen'+i+'ScanBtn');if(b)b.disabled=true;}
    const cfg=configs[id];
    statusText(`${cfg.source}: AllowedCoins taranıyor. Bu yalnızca görsel SELECT taramasıdır, emir göndermez.`);
    progressUpdate(0,`${cfg.source} scanning`);
    try{
      const result=await scan(id,scanController.signal,({checked,total,found,errors})=>{
        progressUpdate(total?Math.round(100*checked/total):0,`${cfg.source} ${checked}/${total}`);
        statusText(`${cfg.source}: ${checked}/${total} coin • SELECT ${found} • Hata ${errors}`);
      });
      scannerResults=result.found;
      renderCandidates(scannerResults,id);
      global.CryptoOfferData=global.CryptoOfferData||{};
      global.CryptoOfferData.frozenLineScanState={startedAt:Date.now(),completedAt:Date.now(),source:cfg.source,results:result.found};
      progressUpdate(result.aborted||result.limited?Math.round(100*result.checked/Math.max(1,result.total)):100, result.aborted?'Cancelled':result.limited?'Rate limited':'Completed');
      const outcome=result.aborted?'iptal edildi':result.limited?'Binance hız sınırı nedeniyle kısmen tamamlandı':'tamamlandı';
      statusText(`${cfg.source} ${outcome} • Kontrol ${result.checked}/${result.total} • SELECT ${scannerResults.length} • Hata ${result.errors.length}${result.limited?' (418/429)': ''}`,result.limited||result.errors.length?'warn':scannerResults.length?'good':'info');
      if(result.errors.length){console.warn('[FROZEN90][SCAN] errors',result.errors.slice(0,25));}
    }catch(err){
      statusText(`${cfg.source} başarısız: ${err?.message||err}`,'bad');
      console.error('[FROZEN90][SCAN]',err);
    }finally{
      scanRunning=false;scanController=null;
      for(const i of ids){const b=document.getElementById('frozen'+i+'ScanBtn');if(b)b.disabled=false;}
    }
  }

  function plotSvg(bars, levels, cfg) {
    // Original inline SVG: no external CDN, no dependencies, no synthetic prices.
    const data=bars.slice(-125);
    if(!data.length)return '<div class="frozenChartEmpty">Mum verisi yok.</div>';
    const W=1050,H=420,left=15,right=170,top=18,bottom=35;
    const plotW=W-left-right,plotH=H-top-bottom;
    const names=['sell1','sell2','sell3','sell4','buy1','buy2'];
    const visibleSells=sellPositions(levels).filter(x=>x.position==='above');
    const prices=levels?[levels.buy1,levels.buy2,...visibleSells.map(x=>x.price)]:[];
    const min=Math.min(...data.map(x=>x.low),...prices),max=Math.max(...data.map(x=>x.high),...prices);
    const range=Math.max(max-min,Math.max(max,0.0000001)*0.0005);
    const lo=min-range*.045,hi=max+range*.045;
    const y=p=>top+(hi-p)/(hi-lo)*plotH;
    const dx=plotW/data.length;
    let svg=`<svg class="frozenCandleSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(cfg.lower)} kapanmış mumlar ve FROZEN90 destek direnç seviyeleri"><rect x="0" y="0" width="${W}" height="${H}" fill="#0b1626"/>`;
    for(let j=0;j<=5;j++){
      const py=top+j*plotH/5,price=hi-(hi-lo)*j/5;
      svg+=`<line x1="${left}" y1="${py}" x2="${W-right+6}" y2="${py}" stroke="#293b50" stroke-dasharray="3 5"/><text x="${W-right+13}" y="${py+3}" font-size="10" fill="#90a4b8">${escape(formatPrice(price))}</text>`;
    }
    if(levels){
      const y1=y(levels.buy1),y2=y(levels.buy2);
      svg+=`<rect x="${left}" y="${Math.min(y1,y2)}" width="${plotW}" height="${Math.abs(y2-y1)}" fill="#16a34a" opacity=".14"/>`;
    }
    data.forEach((b,i)=>{
      const x=left+(i+.5)*dx,up=b.close>=b.open,color=up?'#4ade80':'#fb7185';
      const yt=y(b.high),yb=y(b.low),o=y(b.open),c=y(b.close);
      svg+=`<g><title>${escape(time(b.openTime))} · O ${formatPrice(b.open)} H ${formatPrice(b.high)} L ${formatPrice(b.low)} C ${formatPrice(b.close)}</title><line x1="${x}" x2="${x}" y1="${yt}" y2="${yb}" stroke="${color}" stroke-width="1.2"/><rect x="${x-Math.max(1,dx*.32)}" y="${Math.min(o,c)}" width="${Math.max(2,dx*.64)}" height="${Math.max(1.5,Math.abs(o-c))}" fill="${color}"/></g>`;
    });
    if(levels){
      // A SELL inside/below the BUY zone is NOT drawn as a yellow resistance.
      // Its FROZEN price remains visible in the levels table with a diagnostic label.
      ['buy1','buy2',...visibleSells.map(x=>x.name)].forEach(name=>{
        const py=y(levels[name]),sell=name.startsWith('sell'),color=sell?'#fbbf24':'#4ade80';
        svg+=`<line x1="${left}" x2="${W-right+5}" y1="${py}" y2="${py}" stroke="${color}" stroke-width="1.4" stroke-dasharray="${sell?'6 3':'0'}"/><circle cx="${W-right+5}" cy="${py}" r="2" fill="${color}"/>`;
      });
    }
    for(let j=0;j<6;j++){
      const idx=Math.min(data.length-1,Math.round(j*(data.length-1)/5));
      const x=left+(idx+.5)*dx;
      svg+=`<text x="${x}" y="${H-10}" font-size="10" fill="#90a4b8" text-anchor="middle">${escape(time(data[idx].openTime))}</text>`;
    }
    return svg+'</svg>';
  }

  function levelCells(levels){
    if(!levels)return '<div class="frozenChartEmpty">Altı FROZEN seviyesinin tamamı henüz oluşmadı. Onaysız HH/LH kullanılarak çizgi üretilmez.</div>';
    const positions=new Map(sellPositions(levels).map(item=>[item.name,item.position]));
    return ['buy1','buy2','sell1','sell2','sell3','sell4'].map(n=>{
      const position=positions.get(n);
      const invalid=position&&position!=='above';
      const cls=n.startsWith('buy')?'buy':invalid?'invalidSell':'sell';
      const hint=!position?'Alım bölgesi':position==='above'?'Üst direnç':position==='inside'?'BUY bölgesi içinde · direnç değil':'BUY2 altında · direnç değil';
      const anchor=levels.anchors?.[n];
      const anchorText=anchor?.openTime?`<small>HH/LH: ${escape(time(anchor.openTime))}</small>`:'';
      return `<div class="frozenLevelItem ${cls}"><span>${n.toUpperCase()}</span><strong>${escape(formatPrice(levels[n]))}</strong><small>${escape(hint)}</small>${anchorText}</div>`;
    }).join('');
  }
  async function showChart(symbol,id){
    const coin=String(symbol||'').trim().toUpperCase();
    if(!/^[A-Z0-9]{2,25}USDT$/.test(coin))return;
    selectedSymbol=coin;activeTab=id;
    const seq=++chartRequest;
    shell.hidden=false;
    shell.querySelectorAll('[data-frozen-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.frozenTab===id)));
    chartTitle.textContent=`${coin} · ${configs[id].name}`;
    chartStatus.textContent='Binance Futures kapanmış mumları yükleniyor…';
    chartCanvas.innerHTML='';chartLevels.innerHTML='';
    try{
      const {levels,lower,config}=await Core.load(coin,id);
      if(seq!==chartRequest)return;
      chartCanvas.innerHTML=plotSvg(lower,levels,config);
      chartLevels.innerHTML=levelCells(levels);
      const invalid=levels?sellPositions(levels).filter(x=>x.position!=='above'):[];
      const valid=levels?sellPositions(levels).filter(x=>x.position==='above'):[];
      chartStatus.textContent=levels?
        `${config.name} • 90 kapanmış ${config.upper} mum • Alt grafik: ${config.lower} • Son kapanış: ${time(levels.setupTime)} • BUY bölgesi ${formatPrice(levels.buy2)} – ${formatPrice(levels.buy1)}`+
        (invalid.length?` • UYARI: ${invalid.map(x=>x.name.toUpperCase()).join(', ')} BUY1 üzerinde değil; ham FROZEN fiyatları tabloda, sarı direnç çizgisi çizilmedi.`:'')+
        (!valid.length?' • Bu zaman diliminde BUY1 üstünde SELL hedefi YOK.':''):
        'Gerekli onaylanmış HH/LH noktaları veya kesintisiz geçmiş yok; geçersiz çizgi oluşturulmadı.';
    }catch(e){
      if(seq!==chartRequest)return;
      chartStatus.textContent=`Veri alınamadı: ${e?.message||e}`;
      chartCanvas.innerHTML='';chartLevels.innerHTML='';
    }
  }
  function openChart(symbol,scanSource=''){
    // When a result comes from one of the new FROZEN scanners, open THAT strategy first.
    // The three tabs remain independent and can be changed afterward.
    showChart(symbol,sourceStrategy(scanSource)||activeTab);
    shell.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function closeChart(){chartRequest++;shell.hidden=true;selectedSymbol='';}

  // Capturing handlers only intercept SELECT and coin-name clicks for the chart.
  // Old CAUTION/YS/modal and unrelated controls retain their existing behavior.
  candidateBody?.addEventListener('click',e=>{
    const target=e.target.closest('button.symbolBtn,.pill.select');
    if(!target||!candidateBody.contains(target))return;
    const row=target.closest('tr[data-symbol]');
    if(!row || !row.querySelector('.pill.select'))return;
    e.preventDefault();e.stopImmediatePropagation();
    openChart(row.dataset.symbol,row.dataset.scanSource||row.querySelector('[data-role=scan-source]')?.textContent);
  },true);
  candidateBody?.addEventListener('keydown',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const target=e.target.closest('button.symbolBtn,.pill.select');
    if(!target)return;
    const row=target.closest('tr[data-symbol]');if(!row || !row.querySelector('.pill.select'))return;
    e.preventDefault();e.stopImmediatePropagation();openChart(row.dataset.symbol,row.dataset.scanSource||row.querySelector('[data-role=scan-source]')?.textContent);
  },true);
  shell?.querySelectorAll('[data-frozen-tab]').forEach(button=>button.addEventListener('click',()=>{
    if(selectedSymbol)showChart(selectedSymbol,button.dataset.frozenTab);
  }));
  document.getElementById('frozenCloseChartBtn')?.addEventListener('click',closeChart);
  for(const [id,btnId] of [['4h1h','frozen4h1hScanBtn'],['1h15m','frozen1h15mScanBtn'],['15m5m','frozen15m5mScanBtn']]){
    document.getElementById(btnId)?.addEventListener('click',()=>startScan(id));
  }
  document.getElementById('cancelBtn')?.addEventListener('click',()=>scanController?.abort(),true);
  // Future independent scanners may replace the candidate grid; stale chart is closed.
  document.addEventListener('cryptooffer:candidates-rendered',()=>{
    if(selectedSymbol && !candidateBody?.querySelector(`tr[data-symbol="${selectedSymbol}"]`))closeChart();
  });
  global.FrozenLineBrowser=Object.freeze({scan,startScan,openChart,showChart,closeChart,getResults:()=>scannerResults.slice()});
})(window);
