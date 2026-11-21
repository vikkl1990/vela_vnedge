import type {App} from '../app.ts';
import {DeltaFeed,toMs} from '../delta/ws.ts';
import {AdvisoryDepthPool} from './depthPool.ts';
import {OpenTradeMonitor,type WatchInput,type MarketObservation} from './openTradeMonitor.ts';
import {trendSide,type Position} from '../paper/logic.ts';
import type {ExitBook} from '../paper/exitExecution.ts';
import {logger} from '../log.ts';
import {EXIT_STUDY_SYMBOLS} from './focusedReplay.ts';
import {frozenSignalBar} from './shadowInvalidation.ts';
import {earlyExitPosition} from './scannerEarlyExit.ts';
const log=logger.scoped('trade-monitor');

export class MonitorRuntime {
 readonly monitor:OpenTradeMonitor;readonly depth:AdvisoryDepthPool;
 private app:App;private symbols:string[]=[];private markets=new Map<string,MarketObservation>();
 private timer:ReturnType<typeof setInterval>;private pump:ReturnType<typeof setInterval>;private stopped=false;
 private busy=new Set<string>();private lastFetch=new Map<string,number>();private nextFetch=0;private lastSample=0;
 private focusedSymbols=new Set<string>();
 private capturedContexts=new Set<string>();
 private recentPaperSymbols:string[]=[];private recentAt=0;private lastTick=0;
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
 /** Called after an actual entry commits. Capture must never affect the fill or invent its past. */
 captureEntry(position:Position,book:number,now=Date.now()){
  if(this.stopped||!(book===0||earlyExitPosition(position)||EXIT_STUDY_SYMBOLS.some(s=>s===position.symbol)))return;
  try{
   this.app.replayArchive?.includeStudy(position.symbol,now);
   if(!this.focusedSymbols.has(position.symbol)){this.depth.recorder.requestCheckpoint(position.symbol);this.focusedSymbols.add(position.symbol);}
   const engine=book===0?this.app.paper:this.app.shadow;
   const scope=book===0?'paper':this.app.db.get<{evidence_scope:string}>('SELECT evidence_scope FROM positions WHERE id=?',position.id)?.evidence_scope??'legacy-shadow';
   this.recordContext({position,book,scope,...engine.advisoryObservation(position)},now);
  }catch(e){log.warn(`entry capture unavailable: ${String(e)}`);}
 }
 captureClosed(position:Position,book:number,now=Date.now()){
  if(this.stopped||!(book===0||earlyExitPosition(position)))return;
  try{this.recentAt=0;this.app.replayArchive?.includeStudy(position.symbol,now);
   this.app.replayArchive?.record(position.symbol,'study_actual_close',{positionId:position.id,entryAt:position.entryAt,exitAt:position.exitAt,book,policyId:position.policy?.id??null},now,'trade-monitor');
  }catch(e){log.warn(`close capture unavailable: ${String(e)}`);}
 }
 private recordContext({position:p,book,scope,config}:WatchInput,now:number){
  const key=`${p.id}:${p.entryAt}`;if(this.capturedContexts.has(key))return;
  this.app.replayArchive?.record(p.symbol,'study_entry_context',{
   positionId:p.id,entryAt:p.entryAt,book,scope,scannerId:p.scannerId,tf:p.tf,side:p.side,entryPrice:p.entryPrice,
   originalStop:p.slOriginal,policyId:p.policy?.id??null,sourceHash:p.policy?.sourceHash??p.executionPlan?.sourceHash??null,
   executionPlan:p.executionPlan??null,qty:p.qty,contractValue:p.contractValue,riskAmount:p.riskAmount,
   entryFills:p.fills.filter(f=>f.reason==='entry'),exitConfig:config,signalBar:frozenSignalBar(this.app.db,p),
   observedAfterEntryMs:now-p.entryAt},now,'entry-invalidation-observer');
  this.capturedContexts.add(key);
 }
 tick(now=Date.now()){
  if(this.stopped)return;
  if(this.lastTick&&now-this.lastTick>10000)this.app.replayArchive?.record('*','observer_gap',{previousAt:this.lastTick,observedAt:now,delayMs:now-this.lastTick-5000},now,'trade-monitor');
  this.lastTick=now;
  const snapshot=new Map(this.app.marks.quoteSummary(10000,now).rows.map(q=>[q.symbol,q])),inputs=this.inputs();
  if(now-this.recentAt>=60000){
   // Keep the tape after the actual exit so a longer-hold candidate can be judged.
   // Restarts recover this selection from the journal, not a volatile timer.
   this.recentPaperSymbols=this.app.db.all<{symbol:string}>(`SELECT DISTINCT symbol FROM positions WHERE status='closed' AND exit_at>=? AND
    (bt=0 OR (bt=2 AND (scanner_id IN ('supertrend-cluster-zeiierman','ai-predictive-flow-zeiierman') OR (scanner_id='trend-impulse-channels-zeiierman-maker' AND symbol='SOLUSD' AND tf='15m'))))`,now-86400000).map(r=>r.symbol);this.recentAt=now;
   if(this.recentPaperSymbols.length)for(const channel of ['ob_l1','all_trades'])this.app.feed.subscribe(channel,this.recentPaperSymbols);
  }
  this.app.replayArchive?.setStudySymbols([...this.recentPaperSymbols,...inputs.filter(x=>x.book===0||earlyExitPosition(x.position)).map(x=>x.position.symbol),...this.app.paper.pendingEntries().map(p=>p.symbol)],now);
  const selected=new Set([...EXIT_STUDY_SYMBOLS,...this.recentPaperSymbols,...inputs.filter(x=>x.book===0||earlyExitPosition(x.position)).map(x=>x.position.symbol),...this.app.paper.pendingEntries().map(p=>p.symbol)]);
  for(const symbol of selected)if(!this.focusedSymbols.has(symbol))this.depth.recorder.requestCheckpoint(symbol);
  this.focusedSymbols=selected;
  // Selected research capture reuses advisory sockets; execution book sources stay unchanged.
  const capture=[...new Set(['BTCUSD','ETHUSD','SOLUSD',...EXIT_STUDY_SYMBOLS,...this.recentPaperSymbols,
   ...this.app.scanners.requiredSeries().map(s=>s.symbol),...inputs.map(x=>x.position.symbol),
   ...this.app.paper.pendingEntries().map(x=>x.symbol),...this.app.shadow.pendingEntries().map(x=>x.symbol),
   ...(this.app.config.get().executionPlans??[]).filter(p=>p.enabled).map(p=>p.symbol)])];
  this.app.replayArchive?.setSymbols(capture,now);
  const wanted=[...new Set([...this.symbols,...inputs.map(x=>x.position.symbol),...capture])];
  if(wanted.length!==this.symbols.length)this.setSymbols(wanted);
  for(const symbol of this.symbols){
   const q=snapshot.get(symbol),fresh=q?.fresh&&q.exchangeAt!==null&&q.exchangeAt<=now&&q.receivedAt<=now;
   this.markets.set(symbol,{symbol,at:now,price:fresh?(q.bid+q.ask)/2:null,priceAt:fresh?q.receivedAt:null,
    // Retain observed context for quieter pairs with its age. Executable quotes/fills
    // still apply their own stricter one-second limit in priceExit.
    depth:this.depth.recorder.bookAt(symbol,now,10000),depthAt:this.depth.recorder.observedAt(symbol),flow:this.app.orderFlow.summary(symbol,now),funding:this.app.marks.funding(symbol)??null});
  }
  for(const symbol of this.symbols){
   if(!this.app.replayArchive?.capturesStudy(symbol))continue;
   const m=this.markets.get(symbol),q=snapshot.get(symbol);if(m)this.app.replayArchive.record(symbol,'study_market_sample',{...m,depth:undefined,priceExchangeAt:q?.exchangeAt??null,priceReceivedAt:q?.receivedAt??null},now,'entry-invalidation-observer');
  }
  const currentContexts=new Set<string>();
  for(const {position:p,book,scope,exitPending,marketQty,config} of inputs){
   if(!this.app.replayArchive?.capturesStudy(p.symbol))continue;
   const key=`${p.id}:${p.entryAt}`;currentContexts.add(key);
   this.recordContext({position:p,book,scope,exitPending,marketQty,config},now);
   this.app.replayArchive?.record(p.symbol,'study_position_sample',{positionId:p.id,entryAt:p.entryAt,book,scope,
    quote:this.markets.get(p.symbol)?{price:this.markets.get(p.symbol)!.price,at:this.markets.get(p.symbol)!.priceAt}:null,
    stop:p.sl,qtyOpen:p.qtyOpen,marketQty,exitPending},now,'entry-invalidation-observer');
  }
  this.capturedContexts=currentContexts;
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
   const observedAt=Date.now();
   // Persist the exact public REST book offered to the hypothetical fill. Do not
   // replace its exchange/receipt time with the observation clock.
   this.app.replayArchive?.record(t.symbol,'study_exit_book',{book,observedAt},observedAt,'advisory-rest');
   this.monitor.settle(t.symbol,book,observedAt,this.current);
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
  return {...monitor,generatedAt:now,pairs,connections:this.depth.summary(),marketError,replay:this.app.replayArchive?.status(),retention:'Compact flow/depth: 72h, up to 500k rows each. Checkpoints/trials: 90d, up to 200k/50k. Broad replay: 14-day target / 16 GiB. Focused studies and active/recent paper pairs: 21-day target / 4 GiB, 4 GiB free-disk reserve. Recent paper pairs remain captured for 24h after closure; gaps remain explicit.'};
 }
 stop(){this.stopped=true;clearInterval(this.timer);clearInterval(this.pump);this.depth.stop();}
}
