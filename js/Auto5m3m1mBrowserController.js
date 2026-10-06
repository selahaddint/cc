(() => {
'use strict';
if(!globalThis.BinanceStreamService?.BinanceStreamService||!globalThis.WatchService||!globalThis.Auto5m3m1mCore||!globalThis.AutoScanUI){console.error('Auto5m3m1m dependencies missing');return;}
const ui=new AutoScanUI();
const stream=new BinanceStreamService.BinanceStreamService({log:m=>ui.log(m)});
const core=Auto5m3m1mCore;
const follow=window.CryptoFlowScanner?.modules?.follow||null;
const followGateway={
 getActiveSymbols:()=>follow?.getActiveSymbols?.()||[], isFollowing:s=>!!follow?.isFollowing?.(s),
 prepareInputs:(s,p)=>ui.prepareFollowInputs(s,p), startFollow:async s=>{if(typeof follow?.startFollow==='function')return follow.startFollow(s);const b=[...document.querySelectorAll('#candidateBody [data-action="follow"]')].find(x=>x.dataset.symbol===s);if(b){b.click();return true;}return false;}
};
let watch;
watch=new WatchService({marketDataStore:stream.store,getSettings:()=>core.settings,getCapacity:()=>core.openSlots,onGreen:e=>{const w=watch.get(e.symbol);if(w&&!core.state.greenQueue.includes(e.symbol))core.state.greenQueue.push(e.symbol);document.dispatchEvent(new CustomEvent('cryptooffer:auto5m3m1m-watch-green',{detail:e}));},formatPrice:x=>String(Number(x.toPrecision?.(10)??x))});
if(window.BTCImpact5m3m1m?.setMarketDataProvider){window.BTCImpact5m3m1m.setMarketDataProvider(symbol=>{const normalized=String(symbol||'').trim().toUpperCase();if(!normalized||!stream.store.isReady(normalized,['5m','3m','1m'])||!stream.store.isReady('BTCUSDT',['5m','3m','1m']))return null;const at=Date.now()+Number(core.state.serverOffsetMs||0),side=sym=>{const intervals={};for(const tf of ['1m','3m','5m']){const snap=stream.store.getSnapshot(sym,tf,at);intervals[tf]={closed:snap.closed,current:snap.current};}const b=stream.store.book(sym),bid=Number(b?.bidPrice),ask=Number(b?.askPrice),price=bid>0&&ask>0?(bid+ask)/2:Number(intervals['1m']?.current?.close||intervals['1m']?.closed?.at(-1)?.close);return {price,intervals};};return {at,source:'AUTO531_WS_CACHE',btc:side('BTCUSDT'),coin:side(normalized)};});}
core.configure({streamService:stream,watchService:watch,settingsProvider:()=>window.ApiSettings||{},persistence:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v),removeItem:k=>localStorage.removeItem(k)},universeProvider:async()=>{if(!window.CoinUniverse?.getAllowedCoins)throw new Error('CoinUniverse.js yüklenmedi.');return window.CoinUniverse.getAllowedCoins();},followGateway,btcImpactGateway:window.BTCImpact5m3m1m||null,eventSink:e=>ui.handle(e)});
const api={scan:()=>core.scan(),start:()=>core.start(),cancel:()=>core.cancel(),stop:()=>core.stop(),get running(){return core.running;},state:core.state,source:core.source,timeframes:core.timeframes,get settings(){return core.settings;},get watchedSymbols(){return core.watchedSymbols;},get activeFollowSymbols(){return core.activeFollowSymbols;},get openSlots(){return core.openSlots;}};
window.Auto5m3m1mScan=api;window.CryptoFlowScanner=window.CryptoFlowScanner||{version:'V14.19',modules:{}};window.CryptoFlowScanner.modules=window.CryptoFlowScanner.modules||{};window.CryptoFlowScanner.modules.auto5m3m1mScan=api;
document.getElementById('auto5m3m1mScanBtn')?.addEventListener('click',e=>{e.preventDefault();if(core.running)core.cancel();else void core.start();});
document.getElementById('cancelBtn')?.addEventListener('click',()=>{if(core.running)core.cancel();});
document.addEventListener('cryptooffer:follow-complete',e=>core.onFollowComplete(e?.detail?.symbol));
})();
