import type {App} from '../app.ts';
import {DeltaFeed,toMs} from '../delta/ws.ts';
import {AdvisoryDepthPool} from './depthPool.ts';
import {OpenTradeMonitor,type WatchInput,type MarketObservation} from './openTradeMonitor.ts';
import {trendSide,type Position} from '../paper/logic.ts';
import type {ExitBook} from '../paper/exitExecution.ts';
import {logger} from '../log.ts';
const log=logger.scoped('trade-monitor');

export class MonitorRuntime {
 readonly monitor:OpenTradeMonitor;readonly depth:AdvisoryDepthPool;
 private app:App;private symbols:string[]=[];private markets=new Map<string,MarketObservation>();
 private timer:ReturnType<typeof setInterval>;private pump:ReturnType<typeof setInterval>;private stopped=false;
 private busy=new Set<string>();private lastFetch=new Map<string,number>();private nextFetch=0;private lastSample=0;
 constructor(app:App,factory?:()=>DeltaFeed){
  this.app=app;this.monitor=new OpenTradeMonitor(app.db);this.depth=new AdvisoryDepthPool(app.db,factory);
  app.db.db.exec(`CREATE TABLE IF NOT EXISTS advisory_market_samples(symbol TEXT NOT NULL,bucket INTEGER NOT NULL,observed_at INTEGER NOT NULL,depth_at INTEGER,
   bid REAL,ask REAL,bid_qty10 REAL,ask_qty10 REAL,flow_imbalance REAL,flow_covered INTEGER NOT NULL,flow_through INTEGER,PRIMARY KEY(symbol,bucket));
   CREATE INDEX IF NOT EXISTS advisory_market_time ON advisory_market_samples(bucket);`);
  this.timer=setInterval(()=>{try{this.tick();}catch(e){log.warn(`observation failed: ${String(e)}`);}},5000);this.timer.unref();
  this.pump=setInterval(()=>this.settle(),250);this.pump.unref();
 }
 setSymbols(symbols:string[]){
  this.symbols=[...new Set(symbols)].sort();this.depth.setSymbols(this.symbols);this.app.orderFlow.observeSymbols(this.symbols);
  for(const s of this.markets.keys())if(!this.symbols.includes(s))this.markets.delete(s);
 }
 private inputs():WatchInput[]{
  const scopes=new Map(this.app.db.all<{id:number;evidence_scope:string|null}>("SELECT id,evidence_scope FROM positions WHERE status='open' AND bt IN (0,2)").map(x=>[x.id,x.evidence_scope]));
  return [this.app.paper,this.app.shadow].flatMap(b=>b.openPositions().map(position=>({position,book:b.book,scope:b.book===0?'paper':scopes.get(position.id)??'legacy-shadow',...b.advisoryObservation(position)})));
 }
 private setup(p:Position){
  const bars=this.app.candles.get(p.symbol,p.tf,{closedOnly:true,limit:200});
  return {kind:'closed-bar context; not a scanner invalidation verdict',lastClosedBarAt:bars.at(-1)?.time??null,lastClose:bars.at(-1)?.close??null,
   trend21:bars.length>=21?trendSide(bars.map(b=>b.close),21):null,trend50:bars.length>=50?trendSide(bars.map(b=>b.close),50):null,availableAt:Date.now()};
 }
 tick(now=Date.now()){
  if(this.stopped)return;
  const snapshot=new Map(this.app.marks.quoteSummary(10000,now).rows.map(q=>[q.symbol,q])),inputs=this.inputs();
  const wanted=[...new Set([...this.symbols,...inputs.map(x=>x.position.symbol)])];
  if(wanted.length!==this.symbols.length)this.setSymbols(wanted);
  for(const symbol of this.symbols){
   const q=snapshot.get(symbol),fresh=q?.fresh&&q.exchangeAt!==null&&q.exchangeAt<=now&&q.receivedAt<=now;
   this.markets.set(symbol,{symbol,at:now,price:fresh?(q.bid+q.ask)/2:null,priceAt:fresh?q.receivedAt:null,
    // Retain observed context for quieter pairs with its age. Executable quotes/fills
    // still apply their own stricter one-second limit in priceExit.
    depth:this.depth.recorder.bookAt(symbol,now,10000),depthAt:this.depth.recorder.observedAt(symbol),flow:this.app.orderFlow.summary(symbol,now),funding:this.app.marks.funding(symbol)??null});
  }
  this.monitor.observe(inputs,this.markets,p=>this.setup(p),now);
  if(now-this.lastSample>=60000){
   this.app.db.transaction(()=>{
    for(const m of this.markets.values()){
     const b=m.depth;this.app.db.run('INSERT OR IGNORE INTO advisory_market_samples VALUES(?,?,?,?,?,?,?,?,?,?,?)',m.symbol,Math.floor(now/60000)*60000,now,m.depthAt,
      b?.bids[0]?.price??null,b?.asks[0]?.price??null,b?b.bids.slice(0,10).reduce((a,x)=>a+x.size,0):null,b?b.asks.slice(0,10).reduce((a,x)=>a+x.size,0):null,m.flow.imbalance,Number(m.flow.covered),m.flow.throughAt);
    }
    this.app.db.run('DELETE FROM advisory_market_samples WHERE bucket<?',now-3*86400000);
    this.app.db.run('DELETE FROM advisory_market_samples WHERE rowid IN (SELECT rowid FROM advisory_market_samples ORDER BY bucket DESC LIMIT -1 OFFSET 500000)');
   });this.lastSample=now;
  }
 }
 private current=(id:number)=>this.app.paper.position(id)??this.app.shadow.position(id);
 private settle(){
  if(this.stopped)return;
  const now=Date.now();
  const due=this.monitor.due(now);
  // Streaming observations can settle multiple independent trials without another REST request.
  for(const symbol of new Set(due.map(t=>t.symbol))){
   const book=this.depth.recorder.bookAt(symbol,now,1000);
   if(book)try{this.monitor.settle(symbol,book,now,this.current);}catch(e){log.warn(`hypothetical settlement: ${String(e)}`);}
  }
  if(this.busy.size>=2||now<this.nextFetch)return;
  if(this.app.paper.pendingExits().length||this.app.shadow.pendingExits().length)return;
  const t=this.monitor.due(now).find(t=>!this.busy.has(t.symbol)&&now-(this.lastFetch.get(t.symbol)??0)>=5000);
  if(!t)return;
  this.busy.add(t.symbol);this.lastFetch.set(t.symbol,now);this.nextFetch=now+1000;
  // Public reads only, bounded and below the real exit pump's priority/rate. Never hold its queue.
  void this.app.rest.orderbook(t.symbol,100,{retries:0,timeoutMs:1500}).then(raw=>{
   if(this.stopped)return;
   const book:ExitBook={receivedAt:Date.now(),exchangeAt:toMs(raw.timestamp??raw.last_updated_at,0),bids:raw.buy.map(x=>({price:Number(x.price),size:Number(x.size)})),asks:raw.sell.map(x=>({price:Number(x.price),size:Number(x.size)}))};
   this.monitor.settle(t.symbol,book,Date.now(),this.current);
  }).catch(e=>log.debug(`advisory depth unavailable: ${String(e)}`)).finally(()=>this.busy.delete(t.symbol));
 }
 async view(now=Date.now()){
  let listed:Array<{symbol:string;change24hPct:number;volume24h:number}>=[];let marketError:string|null=null;
  try{listed=await this.app.markets();}catch{marketError='Market list unavailable; showing retained active pairs';}
  const monitor=this.monitor.view();
  const totals=this.app.db.all<any>(`SELECT symbol,bt,count(*) trades,sum(realized_pnl-fees) net,sum((realized_pnl-fees)/risk_amount) r,sum(exit_reason='sl') stops
   FROM positions WHERE status='closed' AND exit_at>=? AND risk_amount>0 AND (bt=0 OR (bt=2 AND evidence_scope IN ('shadow','legacy-shadow'))) GROUP BY symbol,bt`,now-86400000);
  const all=[...new Set([...listed.map(m=>m.symbol),...this.symbols,...totals.map(t=>t.symbol)])].sort();
  const pairs=all.map(symbol=>{
   const m=this.markets.get(symbol),info=listed.find(x=>x.symbol===symbol),positions=monitor.positions.filter(p=>p.symbol===symbol);
   const book=(bt:number)=>{const x=totals.find(t=>t.symbol===symbol&&t.bt===bt);return {trades:x?.trades??0,stops:x?.stops??0,net:bt===0?(x?.net??0):null,r:x?.r??0};};
   return {symbol,active:this.symbols.includes(symbol),change24hPct:info?.change24hPct??null,volume24h:info?.volume24h??null,
    depthAt:m?.depthAt??null,depthFresh:!!this.depth.recorder.bookAt(symbol,now,10000),flow:m?.flow??null,priceAt:m?.priceAt??null,
    paper:book(0),shadow:book(2),paperOpen:positions.filter(p=>p.book===0).length,shadowOpen:positions.filter(p=>p.book===2&&['shadow','legacy-shadow'].includes(p.scope)).length,
    researchOpen:positions.filter(p=>p.book===2&&!['shadow','legacy-shadow'].includes(p.scope)).length,
    worstOpenR:positions.length&&positions.some(p=>p.r!==null)?Math.min(...positions.filter(p=>p.r!==null).map(p=>p.r!)):null};
  });
  return {...monitor,generatedAt:now,pairs,connections:this.depth.summary(),marketError,retention:'Compact flow/depth: 72h, up to 500k rows each. Checkpoints/trials: 90d, up to 200k/50k. Raw execution tape unchanged.'};
 }
 stop(){this.stopped=true;clearInterval(this.timer);clearInterval(this.pump);this.depth.stop();}
}
