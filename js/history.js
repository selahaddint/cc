(() => {
'use strict';

const API_BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com'
];
const DB_NAME='CoinHistoryDB';
const DB_VERSION=1;
const STORE='datasets';
const LATEST_KEY='latest';
const SCHEMA_VERSION=3;
const DAILY_LIMIT=180;
const FIVE_MIN_LIMIT=1000;
const WORKERS=3;
const SYMBOL_PAUSE_MS=140;
const PARTIAL_SAVE_EVERY=20;
const PRODUCT_META_URL='https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';
const FUTURES_API_BASES=['https://fapi.binance.com','https://fapi1.binance.com','https://fapi2.binance.com','https://fapi3.binance.com'];
const ALPHA_TOKEN_LIST_URL='https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const SUPPLY_PRICE_RATIO_MIN=.80,SUPPLY_PRICE_RATIO_MAX=1.20;
const FIAT_BASES=new Set(['EUR','TRY','GBP','AUD','BRL','PLN','RON','UAH','ZAR','ARS','MXN','JPY','RUB','NGN','IDR','INR','PHP','VND','THB','CZK','HUF','AED','SAR','KZT','COP','CLP','PEN']);
const MEME_FALLBACK=new Set(['DOGE','SHIB','PEPE','BONK','FLOKI','WIF','BOME','MEME','NEIRO','TURBO','PENGU','PNUT','ACT','MOG','TRUMP','BRETT','BABYDOGE','1000SATS','SATS']);

const $=id=>document.getElementById(id);
const state={running:false,stop:false,dataset:null,sorts:[{key:'symbol',dir:1}],errors:[]};

function num(v){const n=Number(v);return Number.isFinite(n)?n:NaN}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function median(a){return percentile(a,.5)}
function percentile(arr,p){const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y);if(!a.length)return NaN;if(a.length===1)return a[0];const x=(a.length-1)*p,i=Math.floor(x),j=Math.ceil(x),w=x-i;return a[i]*(1-w)+a[j]*w}
function mean(a){const x=a.filter(Number.isFinite);return x.length?x.reduce((s,v)=>s+v,0)/x.length:NaN}
function fmt(n,d=2){return Number.isFinite(n)?n.toLocaleString('tr-TR',{maximumFractionDigits:d,minimumFractionDigits:0}):'—'}
function fmtPct(n,d=2){return Number.isFinite(n)?`${fmt(n,d)}%`:'—'}
function fmtX(n,d=2){return Number.isFinite(n)?`${fmt(n,d)}x`:'—'}
function fmtPrice(n){if(!Number.isFinite(n))return '—';const a=Math.abs(n);const d=a>=100?2:a>=1?4:a>=.01?6:8;return n.toLocaleString('en-US',{maximumFractionDigits:d})}
function fmtVolume(n){if(!Number.isFinite(n))return '—';return new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(n)}
function fmtSupply(n){if(!Number.isFinite(n))return '—';return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n)}
function ysResult(totalSupply,price){if(!(Number.isFinite(totalSupply)&&totalSupply>=1&&Number.isFinite(price)&&price>0))return null;const rules=[[100000,100,500,false],[1000000,30,100,false],[10000000,1,10,false],[100000000,1,5,false],[1000000000,.01,.10,true],[10000000000,.001,.01,true]];return rules.some(([sMax,pMin,pMax,upperExclusive])=>totalSupply<=sMax&&price>=pMin&&(upperExclusive?price<pMax:price<=pMax))}
function ysHtml(v){return v===true?'<span class="ysTrue" title="YS True">✓</span>':v===false?'<span class="ysFalse" title="YS False">✕</span>':'—'}
function fmtDate(ms){return Number.isFinite(ms)?new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)):'—'}
function fmtDateTime(ms){return Number.isFinite(ms)?new Intl.DateTimeFormat('tr-TR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(ms)):'—'}
function fmtAge(days){if(!Number.isFinite(days))return '—';if(days<60)return `${Math.round(days)} gün`;const years=Math.floor(days/365),months=Math.floor((days-years*365)/30.44);if(years>0)return `${years}y ${months}a`;return `${Math.floor(days/30.44)} ay`}
function escapeHtml(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}

function setStatus(msg,kind=''){const e=$('status');if(!e)return;e.textContent=msg;e.className=`status ${kind}`.trim()}
function setProgress(done,total,label=''){const p=total?100*done/total:0;$('progressBar').style.width=`${clamp(p,0,100)}%`;if(label)setStatus(`${label} • ${done}/${total} • ${p.toFixed(1)}%`)}
function setButtons(){ $('buildBtn').disabled=state.running; $('stopBtn').disabled=!state.running; $('saveBtn').disabled=!state.dataset?.profiles?.length; }

async function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function dbPut(key,value){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(value,key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
async function dbGet(key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(key);req.onsuccess=()=>{db.close();resolve(req.result)};req.onerror=()=>{db.close();reject(req.error)}})}
async function dbDelete(key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}

async function fetchJson(path,{retries=4,timeout=20000}={}){
  let lastErr;
  for(let attempt=0;attempt<=retries;attempt++){
    if(state.stop)throw new DOMException('Stopped','AbortError');
    for(let b=0;b<API_BASES.length;b++){
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
      try{
        const res=await fetch(API_BASES[b]+path,{signal:ctrl.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        clearTimeout(timer);
        if(res.status===429||res.status===418){const ra=Number(res.headers.get('Retry-After'));const e=new Error(`HTTP ${res.status}`);e.retryMs=Number.isFinite(ra)?ra*1000:1500*Math.pow(2,attempt);throw e}
        if(!res.ok)throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }catch(e){clearTimeout(timer);lastErr=e;if(e.name==='AbortError'&&state.stop)throw e}
    }
    await sleep(lastErr?.retryMs||Math.min(8000,700*Math.pow(2,attempt)));
  }
  throw lastErr||new Error('Binance request failed');
}

async function fetchFuturesJson(path,{retries=4,timeout=20000}={}){
  let lastErr;
  for(let attempt=0;attempt<=retries;attempt++){
    if(state.stop)throw new DOMException('Stopped','AbortError');
    for(const base of FUTURES_API_BASES){
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
      try{
        const res=await fetch(base+path,{signal:ctrl.signal,cache:'no-store',headers:{'Accept':'application/json'}});
        clearTimeout(timer);
        if(res.status===429||res.status===418){const ra=Number(res.headers.get('Retry-After'));const e=new Error(`HTTP ${res.status}`);e.retryMs=Number.isFinite(ra)?ra*1000:1500*Math.pow(2,attempt);throw e}
        if(!res.ok)throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }catch(e){clearTimeout(timer);lastErr=e;if(e.name==='AbortError'&&state.stop)throw e}
    }
    await sleep(lastErr?.retryMs||Math.min(8000,700*Math.pow(2,attempt)));
  }
  throw lastErr||new Error('Binance Futures request failed');
}

async function fetchAbsoluteJson(url,{retries=2,timeout=20000}={}){
  let lastErr;
  for(let attempt=0;attempt<=retries;attempt++){
    if(state.stop)throw new DOMException('Stopped','AbortError');
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
    try{
      const res=await fetch(url,{signal:ctrl.signal,cache:'no-store',headers:{'Accept':'application/json'}});
      clearTimeout(timer);
      if(res.status===429||res.status===418){const ra=Number(res.headers.get('Retry-After'));const e=new Error(`HTTP ${res.status}`);e.retryMs=Number.isFinite(ra)?ra*1000:1200*Math.pow(2,attempt);throw e}
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){clearTimeout(timer);lastErr=e;if(e.name==='AbortError'&&state.stop)throw e}
    await sleep(lastErr?.retryMs||Math.min(5000,600*Math.pow(2,attempt)));
  }
  throw lastErr||new Error('Binance product metadata request failed');
}

function productRows(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.data))return payload.data;
  if(Array.isArray(payload?.data?.data))return payload.data.data;
  if(Array.isArray(payload?.data?.list))return payload.data.list;
  return [];
}
function normalizeName(v){return String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/\b(token|coin|protocol|network|finance|official)\b/g,' ').replace(/\s+/g,' ').trim()}
function namesCompatible(a,b){const x=normalizeName(a),y=normalizeName(b);if(!x||!y)return true;return x===y||x.includes(y)||y.includes(x)}
function ratioInRange(a,b,min,max){if(!(Number.isFinite(a)&&a>0&&Number.isFinite(b)&&b>0))return false;const r=a/b;return r>=min&&r<=max}
function alphaRows(payload){if(Array.isArray(payload))return payload;if(Array.isArray(payload?.data))return payload.data;if(Array.isArray(payload?.data?.data))return payload.data.data;if(Array.isArray(payload?.data?.list))return payload.data.list;return []}
function makeAlphaMap(payload){const map=new Map();for(const a of alphaRows(payload)){const sym=String(a?.symbol||'').toUpperCase();if(!sym)continue;if(!map.has(sym))map.set(sym,[]);map.get(sym).push(a)}return map}
function chooseAlphaSupply(baseAsset,price,productMeta,alphaMap){
  const base=String(baseAsset||'').toUpperCase(),rows=(alphaMap?.get(base)||[]).slice();
  if(!rows.length)return null;
  const expectedName=String(productMeta?.an||productMeta?.name||'').trim();
  const candidates=rows.map(a=>({a,p:num(a?.price),mc:num(a?.marketCap)||0,listingCex:a?.listingCex===true||String(a?.listingCex).toLowerCase()==='true'}))
    .filter(x=>!Number.isFinite(price)||!(price>0)||!(x.p>0)||ratioInRange(x.p,price,SUPPLY_PRICE_RATIO_MIN,SUPPLY_PRICE_RATIO_MAX))
    .filter(x=>!expectedName||namesCompatible(expectedName,x.a?.name)||String(x.a?.cexCoinName||'').toUpperCase()===base)
    .sort((a,b)=>Number(b.listingCex)-Number(a.listingCex)||b.mc-a.mc);
  for(const x of candidates){
    const cir=num(x.a?.circulatingSupply),tot=num(x.a?.totalSupply),ap=num(x.a?.price),mc=num(x.a?.marketCap),fdv=num(x.a?.fdv);
    if(!(cir>0&&tot>0&&tot+1e-9>=cir&&ap>0&&mc>=0&&fdv>=0))continue;
    const mcCirc=mc>0?mc/ap:NaN,fdvTotal=fdv>0?fdv/ap:NaN;
    const circOk=mc===0?true:ratioInRange(mcCirc,cir,.98,1.02),totalOk=fdv===0?true:ratioInRange(fdvTotal,tot,.98,1.02);
    if(!circOk||!totalOk)continue;
    return {circulatingSupply:cir,totalSupply:tot,supplySource:'Binance Alpha token-list (MC/FDV checked)',supplyVerified:true,alphaId:String(x.a?.alphaId||'')};
  }
  return null;
}
function resolveSupply(baseAsset,price,productMeta,alphaMap){
  const a=chooseAlphaSupply(baseAsset,price,productMeta,alphaMap);if(a)return a;
  return {circulatingSupply:NaN,totalSupply:NaN,supplySource:'Unavailable — no verified Info-compatible fields',supplyVerified:false,alphaId:''};
}

function canonicalTokenInfo(base){const b=String(base||'').toUpperCase();const m=b.match(/^(1000|10000|100000|1000000)([A-Z].*)$/);return m?{tokenBase:m[2],multiplier:Number(m[1])}:{tokenBase:b,multiplier:1}}

function productTags(meta){return Array.isArray(meta?.tags)?meta.tags.map(x=>String(x).toLowerCase().trim()).filter(Boolean):[]}
function isEquityLikeProduct(meta){
  if(!meta)return false;
  const tags=productTags(meta).join(' '),name=String(meta?.an||meta?.name||'').toLowerCase();
  return /(^|[\s_-])(stock|stocks|equity|equities|xstock|tokenized-stock|tokenised-stock|bstocks|pre-stock|alpha-stock)([\s_-]|$)/i.test(tags)||/tokeni[sz]ed stock|stock token|equity token/i.test(name);
}
function classifyCoinType(meta,baseAsset,futuresInfo=null){
  const base=String(baseAsset||'').toUpperCase(),tags=productTags(meta),sub=Array.isArray(futuresInfo?.underlyingSubType)?futuresInfo.underlyingSubType.map(x=>String(x).toLowerCase()):[],t=` ${[...tags,...sub].join(' ')} `;
  const has=(re)=>re.test(t);
  if(has(/meme|animal-meme|four-meme|pump-fun|pumpfun/)||MEME_FALLBACK.has(base))return 'Meme Coin';
  if(has(/stablecoin|stable-coin/))return 'Stablecoin';
  if(has(/layer-?1|layer_?1|\bl1\b/))return 'Layer 1';
  if(has(/layer-?2|layer_?2|\bl2\b/))return 'Layer 2';
  if(has(/defi/))return 'DeFi';
  if(has(/artificial-intelligence|\bai\b|ai-zone|ai-token/))return 'AI';
  if(has(/gamefi|gaming|game-token|games/))return 'Gaming';
  if(has(/real-world-asset|\brwa\b/))return 'RWA';
  if(has(/fan-token|fantoken/))return 'Fan Token';
  if(has(/privacy/))return 'Privacy';
  if(has(/storage/))return 'Storage';
  if(has(/oracle/))return 'Oracle';
  if(has(/metaverse/))return 'Metaverse';
  if(has(/\bnft\b|nft-token/))return 'NFT';
  if(has(/dex|decentralized-exchange/))return 'DEX';
  if(has(/payment|payments/))return 'Payment';
  if(has(/exchange-token|cex-token/))return 'Exchange Token';
  if(has(/pow|mining-zone/))return 'PoW';
  return 'Diğer Coin';
}

function isCryptoSpotProduct(symbolInfo,meta){
  const base=String(symbolInfo?.baseAsset||'').toUpperCase();
  if(!base||FIAT_BASES.has(base))return false;
  if(meta?.etf===true||String(meta?.etf).toLowerCase()==='true')return false;
  if(isEquityLikeProduct(meta))return false;
  return true;
}

function klineObj(k){return {openTime:num(k?.[0]),open:num(k?.[1]),high:num(k?.[2]),low:num(k?.[3]),close:num(k?.[4]),volume:num(k?.[5]),closeTime:num(k?.[6]),quoteVolume:num(k?.[7])}}
function validCandle(c){return [c.openTime,c.open,c.high,c.low,c.close,c.closeTime].every(Number.isFinite)&&c.open>0&&c.high>0&&c.low>0&&c.close>0}
async function klines(symbol,interval,{startTime=null,limit=500}={}){const q=new URLSearchParams({symbol,interval,limit:String(limit)});if(Number.isFinite(startTime))q.set('startTime',String(Math.floor(startTime)));const x=await fetchJson(`/api/v3/klines?${q}`);if(!Array.isArray(x))throw new Error(`${symbol} ${interval} kline format`);return x.map(klineObj).filter(validCandle)}
async function futuresKlines(symbol,interval,{startTime=null,limit=500}={}){const q=new URLSearchParams({symbol,interval,limit:String(limit)});if(Number.isFinite(startTime))q.set('startTime',String(Math.floor(startTime)));const x=await fetchFuturesJson(`/fapi/v1/klines?${q}`);if(!Array.isArray(x))throw new Error(`${symbol} ${interval} futures kline format`);return x.map(klineObj).filter(validCandle)}
async function marketKlines(entry,interval,opts={}){return entry.spotSymbol?klines(entry.spotSymbol,interval,opts):futuresKlines(entry.futuresSymbol,interval,opts)}

function maxDrawdownPct(closes){let peak=-Infinity,maxDd=0;for(const c of closes){if(!Number.isFinite(c)||c<=0)continue;if(c>peak)peak=c;if(peak>0){const dd=(peak-c)/peak*100;if(dd>maxDd)maxDd=dd}}return maxDd}
function efficiencyRatio(closes){const x=closes.filter(Number.isFinite);if(x.length<3)return NaN;let path=0;for(let i=1;i<x.length;i++)path+=Math.abs(x[i]-x[i-1]);return path>0?Math.abs(x.at(-1)-x[0])/path:0}
function robustPumpAnalysis(days){
  if(days.length<30)return {thresholdPct:NaN,pumpEvents:0,pumpRate30d:NaN,retracementRatePct:NaN,continuationRatePct:NaN};
  const rets=[];for(let i=1;i<days.length;i++)rets.push((days[i].close/days[i-1].close-1)*100);
  const med=median(rets),mad=median(rets.map(r=>Math.abs(r-med))),sigma=Number.isFinite(mad)?1.4826*mad:NaN,pos=rets.filter(r=>r>0),p90pos=percentile(pos,.90);
  const robust=Number.isFinite(med)&&Number.isFinite(sigma)?med+2.5*sigma:NaN;
  const threshold=Math.max(0,Number.isFinite(robust)?robust:0,Number.isFinite(p90pos)?p90pos:0);
  let events=0,retrace=0,cont=0;
  for(let i=1;i<days.length-3;i++){
    const r=(days[i].close/days[i-1].close-1)*100;if(!(r>0&&r>=threshold))continue;
    const pumpAbs=days[i].close-days[i-1].close;if(!(pumpAbs>0))continue;events++;
    const next=days.slice(i+1,i+4),minLow=Math.min(...next.map(x=>x.low)),maxHigh=Math.max(...next.map(x=>x.high));
    if(minLow<=days[i].close-.5*pumpAbs)retrace++;
    if(maxHigh>=days[i].close+.5*pumpAbs)cont++;
  }
  return {thresholdPct:threshold,pumpEvents:events,pumpRate30d:rets.length?events/rets.length*30:NaN,retracementRatePct:events?100*retrace/events:NaN,continuationRatePct:events?100*cont/events:NaN};
}

async function buildProfile(entry,ticker,now,productMeta=null,alphaMap=null){
  const historySymbol=entry.spotSymbol||entry.futuresSymbol;
  const monthly=await marketKlines(entry,'1M',{startTime:0,limit:1000});
  if(!monthly.length)throw new Error('monthly history unavailable');
  const firstMonth=monthly[0].openTime;
  const [firstDays,dailyRaw,fiveRaw]=await Promise.all([
    marketKlines(entry,'1d',{startTime:firstMonth,limit:40}),
    marketKlines(entry,'1d',{limit:DAILY_LIMIT+2}),
    marketKlines(entry,'5m',{limit:FIVE_MIN_LIMIT})
  ]);
  const daily=dailyRaw.filter(c=>c.closeTime<now).slice(-DAILY_LIMIT);
  const five=fiveRaw.filter(c=>c.closeTime<now);
  const firstDaily=firstDays.find(c=>c.openTime>=firstMonth)||firstDays[0]||monthly[0];
  const listingTime=firstDaily?.openTime;
  const unitScale=entry.spotSymbol?1:(Number(entry.futuresMultiplier)||1);
  let ath=-Infinity,atl=Infinity;for(const c of monthly){const h=c.high/unitScale,l=c.low/unitScale;if(h>ath)ath=h;if(l<atl)atl=l}
  const rawPrice=num(ticker?.lastPrice),price=Number.isFinite(rawPrice)?rawPrice/unitScale:NaN,volume24h=num(ticker?.quoteVolume);
  const priceLocationPct=price>0&&ath>atl?clamp(100*(price-atl)/(ath-atl),0,100):NaN;
  const distanceFromMaxPct=price>0&&ath>0?(price/ath-1)*100:NaN;
  const distanceFromMinPct=price>0&&atl>0?(price/atl-1)*100:NaN;
  const fiveMoves=[];for(let i=1;i<five.length;i++)fiveMoves.push(Math.abs((five[i].close/five[i-1].close-1)*100));
  const normal5mMovePct=median(fiveMoves),p90_5mMovePct=percentile(fiveMoves,.90);
  const dailyRanges=daily.map(c=>(c.high-c.low)/c.open*100).filter(Number.isFinite);
  const medianDailyRangePct=median(dailyRanges);
  const dailyAbs=[];for(let i=1;i<daily.length;i++)dailyAbs.push(Math.abs((daily[i].close/daily[i-1].close-1)*100));
  const medianDailyAbsReturnPct=median(dailyAbs);
  const vols=daily.slice(-30).map(c=>c.quoteVolume).filter(v=>Number.isFinite(v)&&v>=0),historicalMedianVolume30d=median(vols),volumeRatio=historicalMedianVolume30d>0?volume24h/historicalMedianVolume30d:NaN;
  const maxDrawdown180dPct=maxDrawdownPct(daily.map(c=>c.close));
  const sideWindow=daily.slice(-Math.min(60,daily.length)).map(c=>c.close),er=efficiencyRatio(sideWindow);
  const directionEfficiency60dPct=Number.isFinite(er)?100*er:NaN;const directionalCharacter=!Number.isFinite(er)?'INSUFFICIENT':er<.25?'CHOPPY':er<.50?'MIXED':'DIRECTIONAL';
  const pump=robustPumpAnalysis(daily);
  const historyDays=Number.isFinite(listingTime)?Math.max(0,(now-listingTime)/86400000):NaN;
  const supply=resolveSupply(entry.tokenBase,price,productMeta,alphaMap);
  const ys=supply.supplyVerified?ysResult(supply.totalSupply,price):null;
  return {
    symbol:historySymbol,baseAsset:entry.tokenBase,spotSymbol:entry.spotSymbol||null,futuresSymbol:entry.futuresSymbol||null,futuresMultiplier:Number(entry.futuresMultiplier)||1,
    spotEligible:!!entry.spotSymbol,futuresEligible:!!entry.futuresSymbol,marketType:entry.spotSymbol&&entry.futuresSymbol?'Spot + Futures':entry.futuresSymbol?'Futures':'Spot',historyMarket:entry.spotSymbol?'Spot':'Futures',
    coinType:classifyCoinType(productMeta,entry.tokenBase,entry.futuresInfo),price,volume24h,totalSupply:supply.totalSupply,circulatingSupply:supply.circulatingSupply,supplySource:supply.supplySource,supplyVerified:supply.supplyVerified,alphaId:supply.alphaId||'',ys,
    listingTime,historyDays,allTimeHigh:ath,allTimeLow:atl,priceLocationPct,distanceFromMaxPct,distanceFromMinPct,
    normal5mMovePct,p90_5mMovePct,medianDailyRangePct,medianDailyAbsReturnPct,
    historicalMedianVolume30d,volumeRatio,maxDrawdown180dPct,directionEfficiency60dPct,directionalCharacter,
    pumpThresholdPct:pump.thresholdPct,pumpEvents:pump.pumpEvents,pumpRate30d:pump.pumpRate30d,
    retracementRatePct:pump.retracementRatePct,continuationRatePct:pump.continuationRatePct,
    fiveMinuteSamples:fiveMoves.length,dailySamples:daily.length,
    updatedAt:now,volatilityCharacter:'—',pumpCharacter:'—',riskCharacter:'—',historyRiskScore:NaN,historyComment:''
  };
}

function rankPercentiles(profiles,key){const valid=profiles.filter(p=>Number.isFinite(p[key])).slice().sort((a,b)=>a[key]-b[key]);const n=valid.length;if(!n)return new Map();const out=new Map();let i=0;while(i<n){let j=i+1;while(j<n&&valid[j][key]===valid[i][key])j++;const mid=(i+j-1)/2,pct=n===1?50:100*mid/(n-1);for(let k=i;k<j;k++)out.set(valid[k].symbol,pct);i=j}return out}
function band(v){return v>=90?'VERY HIGH':v>=72?'HIGH':v>=30?'NORMAL':'LOW'}
function trLabel(x){return x==='VERY HIGH'?'ÇOK YÜKSEK':x==='HIGH'?'YÜKSEK':x==='LOW'?'DÜŞÜK':x==='NORMAL'?'NORMAL':x}
function enrichCrossSection(profiles){
  const p5=rankPercentiles(profiles,'normal5mMovePct'),pd=rankPercentiles(profiles,'medianDailyRangePct'),pdd=rankPercentiles(profiles,'maxDrawdown180dPct'),pp=rankPercentiles(profiles,'pumpRate30d');
  const retraceEligible=profiles.filter(p=>p.pumpEvents>=5&&Number.isFinite(p.retracementRatePct));
  const pr=rankPercentiles(retraceEligible,'retracementRatePct');
  const raw=[];
  for(const p of profiles){
    const v5=p5.get(p.symbol),vd=pd.get(p.symbol),dd=pdd.get(p.symbol),pu=pp.get(p.symbol),rp=pr.get(p.symbol);
    const vol=mean([v5,vd]);p.volatilityPercentile=vol;p.volatilityCharacter=Number.isFinite(vol)?band(vol):'INSUFFICIENT';
    p.pumpPercentile=pu;p.pumpCharacter=Number.isFinite(pu)?band(pu):'INSUFFICIENT';
    const risk=mean([Number.isFinite(vol)?vol:NaN,Number.isFinite(dd)?dd:NaN,Number.isFinite(pu)?pu:NaN,Number.isFinite(rp)?rp:NaN]);
    p.historyRiskScore=risk;if(Number.isFinite(risk))raw.push(risk);
  }
  const sorted=raw.slice().sort((a,b)=>a-b);
  for(const p of profiles){const r=p.historyRiskScore;if(!Number.isFinite(r)){p.riskCharacter='INSUFFICIENT';continue}let less=0,equal=0;for(const x of sorted){if(x<r)less++;else if(x===r)equal++;}const pct=sorted.length<=1?50:100*(less+.5*equal)/(sorted.length);p.riskPercentile=pct;p.riskCharacter=band(pct)}
  for(const p of profiles)p.historyComment=makeComment(p);
}

function makeComment(p){
  const s=[];
  if(Number.isFinite(p.historyDays)&&p.historyDays<60)s.push(`Binance ${p.historyMarket||'market'} geçmişi yalnızca ${Math.round(p.historyDays)} gün; uzun vadeli karakter yorumu sınırlı.`);
  else{
    if(p.volatilityCharacter==='VERY HIGH')s.push('Tarihsel volatilitesi coin evrenine göre çok yüksek; hızlı yükseliş ve düşüşler sık görülebilir.');
    else if(p.volatilityCharacter==='HIGH')s.push('Tarihsel volatilitesi yüksek; kısa vadeli hareketleri agresif olabilir.');
    else if(p.volatilityCharacter==='LOW')s.push('Tarihsel olarak görece sakin hareket ediyor.');
    else s.push('Tarihsel volatilitesi genel coin evrenine yakın.');
  }
  if(p.directionalCharacter==='CHOPPY')s.push('Son yaklaşık 60 günlük kapanışlarda yön verimliliği düşük; hareket choppy/iki yönlü.');
  else if(p.directionalCharacter==='MIXED')s.push('Son yaklaşık 60 günlük kapanışlarda yönlülük orta seviyede.');
  else if(p.directionalCharacter==='DIRECTIONAL')s.push('Son yaklaşık 60 günlük kapanışlarda yönlülük belirgin.');
  if(p.pumpEvents>=5&&Number.isFinite(p.retracementRatePct)){
    if(p.retracementRatePct>=65)s.push(`Geçmiş pump örneklerinde sert geri çekilme eğilimi yüksek (${fmt(p.retracementRatePct,0)}%).`);
    else if(p.retracementRatePct>=40)s.push(`Pump sonrası geri çekilme eğilimi orta (${fmt(p.retracementRatePct,0)}%).`);
    else s.push(`Pump sonrası güçlü geri çekilme oranı görece düşük (${fmt(p.retracementRatePct,0)}%).`);
  }else s.push('Pump/retracement karakteri için yeterli örnek sayısı yok.');
  if(Number.isFinite(p.priceLocationPct)){
    if(p.priceLocationPct>=80)s.push('Fiyat Binance tarihsel aralığının üst bölümünde.');
    else if(p.priceLocationPct<=20)s.push('Fiyat Binance tarihsel aralığının alt bölümünde.');
    else s.push('Fiyat Binance tarihsel aralığının orta bölümünde.');
  }
  if(Number.isFinite(p.volumeRatio)){
    if(p.volumeRatio>=2)s.push(`Mevcut 24s hacim son 30 günlük medyanın ${fmt(p.volumeRatio,1)} katı.`);
    else if(p.volumeRatio<=.5)s.push('Mevcut 24s hacim tarihsel 30 günlük medyanın belirgin altında.');
  }
  return s.slice(0,5).join(' ');
}

function pill(text,type){const cls=type==='VERY HIGH'?'veryhigh':type==='HIGH'?'high':type==='LOW'?'low':'normal';return `<span class="pill ${cls}">${escapeHtml(trLabel(text))}</span>`}
function directionLabel(p){if(!Number.isFinite(p?.directionEfficiency60dPct))return '—';return `${fmtPct(p.directionEfficiency60dPct,1)} (${p.directionalCharacter==='CHOPPY'?'CHOPPY':p.directionalCharacter==='DIRECTIONAL'?'YÖNLÜ':'KARIŞIK'})`}

function compareValues(A,B,dir){
  if(typeof A==='boolean'||typeof B==='boolean'){const av=A===true?1:A===false?0:NaN,bv=B===true?1:B===false?0:NaN;if(!Number.isFinite(av)&&!Number.isFinite(bv))return 0;if(!Number.isFinite(av))return 1;if(!Number.isFinite(bv))return -1;return dir*(av-bv)}
  if(typeof A==='string'||typeof B==='string')return dir*String(A??'').localeCompare(String(B??''),'tr',{numeric:true,sensitivity:'base'});
  const an=Number(A),bn=Number(B);if(!Number.isFinite(an)&&!Number.isFinite(bn))return 0;if(!Number.isFinite(an))return 1;if(!Number.isFinite(bn))return -1;return dir*(an-bn)
}
function filteredProfiles(){
  const all=state.dataset?.profiles||[],q=$('searchInput').value.trim().toUpperCase();
  let a=q?all.filter(p=>p.symbol.includes(q)||String(p.baseAsset||'').includes(q)||String(p.coinType||'').toUpperCase().includes(q)||String(p.marketType||'').toUpperCase().includes(q)):all.slice();
  const sorts=state.sorts?.length?state.sorts:[{key:'symbol',dir:1}];
  a.sort((x,y)=>{for(const s of sorts){const c=compareValues(x[s.key],y[s.key],s.dir);if(c!==0)return c}return String(x.symbol).localeCompare(String(y.symbol),'tr',{numeric:true})});
  return a
}
function updateSortHeaders(){
  document.querySelectorAll('th[data-key]').forEach(th=>{const i=(state.sorts||[]).findIndex(s=>s.key===th.dataset.key);th.classList.toggle('sortActive',i>=0);let mark=th.querySelector('.sortMark');if(!mark){mark=document.createElement('span');mark.className='sortMark';th.appendChild(mark)}mark.textContent=i>=0?`${i+1}${state.sorts[i].dir>0?'▲':'▼'}`:'';});
}
function render(){
  const body=$('historyBody'),rows=filteredProfiles();
  if(!rows.length){body.innerHTML='<tr><td colspan="29" class="empty">Aramaya uygun coin bulunamadı veya veri henüz yok.</td></tr>';updateSortHeaders();setButtons();return}
  body.innerHTML=rows.map(p=>`<tr>
    <td class="coin" title="History: ${escapeHtml(p.historyMarket||'—')}">${escapeHtml(p.symbol)}</td>
    <td class="coinType">${escapeHtml(p.coinType||'Diğer Coin')}</td>
    <td class="marketTag">${escapeHtml(p.marketType||'Spot')}</td>
    <td class="num">${ysHtml(p.ys)}</td>
    <td class="num">${fmtPrice(p.price)}</td>
    <td class="num">${fmtSupply(p.totalSupply)}</td>
    <td class="num">${fmtSupply(p.circulatingSupply)}</td>
    <td class="num">${fmtVolume(p.volume24h)}</td>
    <td class="num" title="${fmtDate(p.listingTime)} • History kaynağı: ${escapeHtml(p.historyMarket||'—')}">${escapeHtml(fmtAge(p.historyDays))}</td>
    <td class="num">${fmtPrice(p.allTimeHigh)}</td>
    <td class="num">${fmtPrice(p.allTimeLow)}</td>
    <td class="num">${fmtPct(p.priceLocationPct,1)}</td>
    <td class="num">${fmtPct(p.normal5mMovePct,3)}</td>
    <td class="num">${fmtPct(p.p90_5mMovePct,3)}</td>
    <td class="num">${fmtPct(p.medianDailyRangePct,2)}</td>
    <td class="num">${fmtPct(p.medianDailyAbsReturnPct,2)}</td>
    <td class="num">${fmtVolume(p.historicalMedianVolume30d)}</td>
    <td class="num">${fmtX(p.volumeRatio,2)}</td>
    <td class="num" title="Dynamic pump threshold: ${fmtPct(p.pumpThresholdPct,2)}">${fmt(p.pumpEvents,0)}</td>
    <td class="num">${fmt(p.pumpRate30d,2)}</td>
    <td class="num">${p.pumpEvents>=5?fmtPct(p.retracementRatePct,0):'—'}</td>
    <td class="num">${p.pumpEvents>=5?fmtPct(p.continuationRatePct,0):'—'}</td>
    <td>${escapeHtml(directionLabel(p))}</td>
    <td class="num">${fmtPct(p.maxDrawdown180dPct,1)}</td>
    <td>${pill(p.volatilityCharacter,p.volatilityCharacter)}</td>
    <td>${pill(p.pumpCharacter,p.pumpCharacter)}</td>
    <td>${pill(p.riskCharacter,p.riskCharacter)}</td>
    <td class="comment">${escapeHtml(p.historyComment||'—')}</td>
    <td>${fmtDateTime(p.updatedAt)}</td>
  </tr>`).join('');
  updateSortHeaders();setButtons();
}

async function persist(dataset){try{await dbPut(LATEST_KEY,dataset)}catch(e){console.warn('IndexedDB save failed',e)}}
function migrateProfile(p){
  const base=String(p?.baseAsset||String(p?.symbol||'').replace(/USDT$/,'')).toUpperCase();p.baseAsset=base;
  if(!p.coinType)p.coinType=MEME_FALLBACK.has(base)?'Meme Coin':'Diğer Coin';
  if(!('spotEligible' in p))p.spotEligible=true;if(!('futuresEligible' in p))p.futuresEligible=false;
  if(!p.marketType)p.marketType=p.spotEligible&&p.futuresEligible?'Spot + Futures':p.futuresEligible?'Futures':'Spot';
  if(!p.historyMarket)p.historyMarket=p.spotEligible?'Spot':'Futures';
  if(!('totalSupply' in p))p.totalSupply=NaN;if(!('circulatingSupply' in p))p.circulatingSupply=NaN;if(!p.supplySource)p.supplySource='Legacy / not verified';if(!('supplyVerified' in p))p.supplyVerified=false;
  if(!Number.isFinite(p.medianDailyRangePct)&&Number.isFinite(p.dailyVolatilityPct))p.medianDailyRangePct=p.dailyVolatilityPct;if(!Number.isFinite(p.directionEfficiency60dPct)&&Number.isFinite(p.sidewaysEfficiency))p.directionEfficiency60dPct=100*p.sidewaysEfficiency;
  p.ys=p.supplyVerified?ysResult(num(p.totalSupply),num(p.price)):null;return p;
}
async function loadAuto(){
  try{const d=await dbGet(LATEST_KEY);if(d?.profiles?.length){d.profiles=d.profiles.filter(p=>!FIAT_BASES.has(String(p?.baseAsset||String(p?.symbol||'').replace(/USDT$/,'')).toUpperCase())).map(migrateProfile);state.dataset=d;render();setStatus(`Yerel CoinHistory verisi otomatik yüklendi: ${d.profiles.length} profil. Son güncelleme ${fmtDateTime(d.generatedAt)}.`,'good')}else render()}catch(e){setStatus(`Yerel veri otomatik yüklenemedi: ${e.message}`,'warn');render()}
}

async function buildAll(){
  if(state.running)return;state.running=true;state.stop=false;state.errors=[];setButtons();setProgress(0,1);setStatus('Binance Spot + Futures universe yükleniyor...');
  const startedAt=Date.now();
  try{
    const [spotExchange,spotTickers,futuresExchange,futuresTickers]=await Promise.all([
      fetchJson('/api/v3/exchangeInfo'),fetchJson('/api/v3/ticker/24hr?type=MINI'),fetchFuturesJson('/fapi/v1/exchangeInfo'),fetchFuturesJson('/fapi/v1/ticker/24hr')
    ]);
    let productMetaPayload=null,alphaTokenPayload=null;
    try{productMetaPayload=await fetchAbsoluteJson(PRODUCT_META_URL)}catch(e){console.warn('Binance product metadata unavailable; type fallback will be used.',e)}
    try{alphaTokenPayload=await fetchAbsoluteJson(ALPHA_TOKEN_LIST_URL)}catch(e){console.warn('Binance Alpha token-list unavailable; Info-compatible total/max supply will remain unavailable where no verified source exists.',e)}
    const productMap=new Map(productRows(productMetaPayload).map(p=>[String(p?.s||p?.symbol||'').toUpperCase(),p]).filter(x=>x[0]));
    const alphaMap=makeAlphaMap(alphaTokenPayload);
    const spotInfos=(spotExchange?.symbols||[]).filter(s=>String(s.status).toUpperCase()==='TRADING'&&String(s.quoteAsset).toUpperCase()==='USDT'&&s.isSpotTradingAllowed!==false).filter(s=>isCryptoSpotProduct(s,productMap.get(String(s.symbol).toUpperCase())));
    const futuresInfos=(futuresExchange?.symbols||[]).filter(s=>String(s.status).toUpperCase()==='TRADING'&&String(s.contractType).toUpperCase()==='PERPETUAL'&&String(s.quoteAsset).toUpperCase()==='USDT'&&String(s.marginAsset).toUpperCase()==='USDT'&&String(s.underlyingType).toUpperCase()==='COIN');
    const entries=new Map();
    for(const x of spotInfos){const tokenBase=String(x.baseAsset||'').toUpperCase();entries.set(tokenBase,{tokenBase,spotSymbol:String(x.symbol).toUpperCase(),futuresSymbol:null,futuresMultiplier:1})}
    for(const x of futuresInfos){const rawBase=String(x.baseAsset||String(x.symbol||'').replace(/USDT$/,'')).toUpperCase(),info=canonicalTokenInfo(rawBase),tokenBase=info.tokenBase;const e=entries.get(tokenBase)||{tokenBase,spotSymbol:null,futuresSymbol:null,futuresMultiplier:1};e.futuresSymbol=String(x.symbol).toUpperCase();e.futuresMultiplier=info.multiplier;e.futuresInfo=x;entries.set(tokenBase,e)}
    const universe=[...entries.values()].filter(e=>e.spotSymbol||e.futuresSymbol).sort((a,b)=>a.tokenBase.localeCompare(b.tokenBase));
    const spotTickerMap=new Map((Array.isArray(spotTickers)?spotTickers:[]).map(t=>[String(t.symbol).toUpperCase(),t]));
    const futuresTickerMap=new Map((Array.isArray(futuresTickers)?futuresTickers:[]).map(t=>[String(t.symbol).toUpperCase(),t]));
    const profiles=[];let next=0,done=0;
    state.dataset={schemaVersion:SCHEMA_VERSION,source:'Binance Global public market data + Binance Alpha token-list supply metadata',universe:'CRYPTO_SPOT_USDT_UNION_USDSM_PERPETUAL',universeCount:universe.length,generatedAt:null,startedAt,profileWindows:{dailyDays:DAILY_LIMIT,fiveMinuteBars:FIVE_MIN_LIMIT,volumeDays:30,sidewaysDays:60,pumpForwardDays:3},profiles,errors:[]};
    render();
    async function worker(){
      while(true){
        if(state.stop)return;const i=next++;if(i>=universe.length)return;const entry=universe[i],display=entry.spotSymbol||entry.futuresSymbol;
        const ticker=entry.spotSymbol?(spotTickerMap.get(entry.spotSymbol)||{}):(futuresTickerMap.get(entry.futuresSymbol)||{});
        const productMeta=productMap.get(entry.spotSymbol||`${entry.tokenBase}USDT`)||productMap.get(`${entry.tokenBase}USDT`)||null;
        try{const profile=await buildProfile(entry,ticker,Date.now(),productMeta,alphaMap);profiles.push(profile)}catch(e){state.errors.push({symbol:display,error:e?.message||String(e),at:Date.now()})}
        done++;state.dataset.errors=state.errors.slice();setProgress(done,universe.length,`History oluşturuluyor: ${display}`);
        if(done%PARTIAL_SAVE_EVERY===0){enrichCrossSection(profiles);state.dataset.generatedAt=Date.now();await persist(state.dataset);render()}
        await sleep(SYMBOL_PAUSE_MS);
      }
    }
    await Promise.all(Array.from({length:WORKERS},worker));
    enrichCrossSection(profiles);profiles.sort((a,b)=>a.symbol.localeCompare(b.symbol));state.dataset.generatedAt=Date.now();state.dataset.errors=state.errors.slice();await persist(state.dataset);render();
    if(state.stop)setStatus(`İşlem durduruldu. Tamamlanan ${profiles.length} profil yerel veriye kaydedildi.`,'warn');
    else{setProgress(universe.length,universe.length);setStatus(`Tamamlandı. ${profiles.length}/${universe.length} profil oluşturuldu. Hata: ${state.errors.length}. Spot ve USDⓈ-M Perpetual coin evreni birlikte tarandı. Web3 contract supply kullanılmadı.`,'good')}
  }catch(e){if(e.name==='AbortError')setStatus('İşlem durduruldu.','warn');else setStatus(`History build başarısız: ${e.message}`,'bad')}
  finally{state.running=false;setButtons()}
}

function downloadJson(){if(!state.dataset?.profiles?.length)return;const payload=JSON.stringify(state.dataset,null,2),blob=new Blob([payload],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');const d=new Date(state.dataset.generatedAt||Date.now()),ds=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;a.href=url;a.download=`CoinHistory_${ds}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
async function importJson(file){try{const text=await file.text(),d=JSON.parse(text);if(!Array.isArray(d?.profiles))throw new Error('profiles array bulunamadı');d.profiles=d.profiles.filter(p=>!FIAT_BASES.has(String(p?.baseAsset||String(p?.symbol||'').replace(/USDT$/,'')).toUpperCase())).map(migrateProfile);d.schemaVersion=SCHEMA_VERSION;enrichCrossSection(d.profiles);d.generatedAt=Number(d.generatedAt)||Date.now();d.universeCount=Number(d.universeCount)||d.profiles.length;d.errors=Array.isArray(d.errors)?d.errors:[];state.dataset=d;await persist(d);render();setStatus(`JSON yüklendi ve yerel veriye kaydedildi: ${d.profiles.length} profil.`,'good')}catch(e){setStatus(`JSON yüklenemedi: ${e.message}`,'bad')}}

$('buildBtn').addEventListener('click',buildAll);
$('stopBtn').addEventListener('click',()=>{state.stop=true;setStatus('Durdurma istendi; çalışan istekler tamamlandıktan sonra duracak.','warn')});
$('saveBtn').addEventListener('click',downloadJson);
$('loadFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)importJson(f);e.target.value=''});
$('clearBtn').addEventListener('click',async()=>{if(state.running)return;await dbDelete(LATEST_KEY);state.dataset=null;state.errors=[];$('progressBar').style.width='0%';render();setStatus('Yerel CoinHistory verisi temizlendi.','warn')});
$('searchInput').addEventListener('input',render);
document.querySelectorAll('th[data-key]').forEach(th=>th.addEventListener('click',e=>{const key=th.dataset.key,multi=e.shiftKey||e.ctrlKey||e.metaKey;let sorts=(state.sorts||[]).slice(),i=sorts.findIndex(s=>s.key===key);if(!multi){if(i===0&&sorts.length===1)sorts[0].dir*=-1;else sorts=[{key,dir:i>=0?sorts[i].dir:1}]}else{if(i>=0)sorts[i].dir*=-1;else{if(sorts.length>=3)sorts=sorts.slice(0,2);sorts.push({key,dir:1})}}state.sorts=sorts;render()}));
$('sortResetBtn').addEventListener('click',()=>{state.sorts=[{key:'symbol',dir:1}];render()});

loadAuto();
})();

(() => {
  'use strict';
  const section = document.getElementById('historySection');
  const button = document.getElementById('historyFullscreenBtn');
  if (!section || !button) return;
  function syncFullscreenButton(){
    const active = document.fullscreenElement === section;
    button.textContent = active ? '×' : '⛶';
    button.title = active ? 'Tam ekrandan çık' : 'Gridi tam ekran yap';
    button.setAttribute('aria-label', active ? 'Tam ekrandan çık' : 'Gridi tam ekran yap');
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  button.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === section) await document.exitFullscreen();
      else if (!document.fullscreenElement) await section.requestFullscreen();
    } catch (_) {}
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  syncFullscreenButton();
})();
