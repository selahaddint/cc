(() => {
  'use strict';
  const n=v=>{const x=Number(v);return Number.isFinite(x)?x:NaN;};
  class WatchService{
    constructor({marketDataStore,getSettings,getCapacity=()=>1,onGreen=()=>{},formatPrice=x=>String(x)}={}){if(!marketDataStore)throw new Error('WatchService requires marketDataStore');this.marketDataStore=marketDataStore;this.getSettings=getSettings||(()=>({watchSampleMs:1000,watchMinRisePct:0,entryConfirmationCount:2}));this.getCapacity=getCapacity;this.onGreen=onGreen;this.formatPrice=formatPrice;this.states=new Map();}
    add(symbol){let w=this.states.get(symbol);if(!w){w={symbol,status:'WAIT',samples:[],lastSampleAt:0,latestPrice:NaN,reason:'SELECT • WebSocket giriş zamanını bekliyor',greenAt:0,confirmCount:0,confirmed:false,btcImpact:null,btcImpactError:null,btcCheckedAt:0};this.states.set(symbol,w);}return w;}
    remove(symbol){this.states.delete(symbol);}
    clear(){this.states.clear();}
    get(symbol){return this.states.get(symbol)||null;}
    has(symbol){return this.states.has(symbol);}
    symbols(){return [...this.states.keys()];}
    values(){return [...this.states.values()];}
    reconcile(symbols,{activeSymbols=new Set(),allowDuplicate=false}={}){const eligible=new Set(symbols||[]);for(const symbol of this.symbols())if(!eligible.has(symbol)&&!activeSymbols.has(symbol))this.remove(symbol);for(const symbol of eligible){if(activeSymbols.has(symbol)&&!allowDuplicate)continue;this.add(symbol);}}
    evaluate(symbol,referenceTime=Date.now()){const w=this.states.get(symbol);if(!w||w.status==='GREEN'||(w.status==='ARMED'&&w.confirmed))return w;const cfg=this.getSettings(),b=this.marketDataStore.book(symbol);if(!b)return w;const bid=n(b.bidPrice),ask=n(b.askPrice),price=bid>0&&ask>0?(bid+ask)/2:NaN;if(!(price>0))return w;if(w.lastSampleAt&&referenceTime-w.lastSampleAt<cfg.watchSampleMs)return w;w.lastSampleAt=referenceTime;w.latestPrice=price;w.samples.push({price,time:referenceTime});while(w.samples.length>3)w.samples.shift();if(w.samples.length<3){w.status='WAIT';w.reason=`Watch ${w.samples.length}/3 • ${w.samples.map(x=>this.formatPrice(x.price)).join(' → ')}`;return w;}const [p0,p1,p2]=w.samples.map(x=>x.price),rise=p0>0?(p2/p0-1)*100:0;if(p1>p0&&p2>p1&&rise>=cfg.watchMinRisePct){w.confirmCount=Math.min(cfg.entryConfirmationCount,(Number(w.confirmCount)||0)+1);if(w.confirmCount>=cfg.entryConfirmationCount){w.confirmed=true;w.status=this.getCapacity()>0?'GREEN':'ARMED';w.greenAt=referenceTime;w.reason=`P0 < P1 < P2 • confirm ${w.confirmCount}/${cfg.entryConfirmationCount} • ${this.formatPrice(p0)} → ${this.formatPrice(p1)} → ${this.formatPrice(p2)} • ${rise>=0?'+':''}${rise.toFixed(4)}%${this.getCapacity()>0?'':' • slot bekliyor'}`;this.onGreen({symbol,p0,p1,p2,rise,confirmation:w.confirmCount,required:cfg.entryConfirmationCount,state:w});}else{w.confirmed=false;w.status='ARMED';w.reason=`P0 < P1 < P2 • confirm ${w.confirmCount}/${cfg.entryConfirmationCount} • bir sonraki WebSocket teyidi bekleniyor`;}}else{w.confirmCount=0;w.confirmed=false;w.status='WAIT';w.reason=`WAIT • ${this.formatPrice(p0)} → ${this.formatPrice(p1)} → ${this.formatPrice(p2)}`;}return w;}
    evaluateAll(referenceTime=Date.now()){for(const symbol of this.symbols())this.evaluate(symbol,referenceTime);return this.values();}
  }
  globalThis.WatchService=WatchService;
})();
