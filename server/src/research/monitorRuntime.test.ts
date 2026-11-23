import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {MonitorRuntime} from './monitorRuntime.ts';
import type {App} from '../app.ts';
import {DeltaFeed} from '../delta/ws.ts';
import {crc32} from '../execution/depthRecorder.ts';
const T=1800000000000;
test('UI depth freshness uses response time after awaited market discovery, without changing execution',async t=>{
 const x=setup(t),cfg=JSON.stringify(x.cfg),position=JSON.stringify(x.p);
 Object.assign(x.app.replayArchive!,{status:()=>({ready:true})});
 x.runtime.setSymbols(['BLESSUSD']);
 x.app.markets=async()=>{
  t.mock.timers.setTime(T+2000);
  x.runtime.depth.recorder.onDepth({sy:'BLESSUSD',action:'snapshot',seq:1,ts:(T+2000)*1000,
   a:[['101','2']],b:[['100','3']],cs:crc32('101:2|100:3')},T+2000);
  return [] as any;
 };
 const view=await x.runtime.view();
 assert.equal(view.generatedAt,T+2000);assert.equal(view.pairs.find(p=>p.symbol==='BLESSUSD')!.depthFresh,true);
 assert.equal(JSON.stringify(x.cfg),cfg);assert.equal(JSON.stringify(x.p),position);
});
function setup(t:any){
 t.mock.timers.enable({apis:['Date'],now:T});
 const db=new Db(':memory:'),cfg=structuredClone(DEFAULT_CONFIG);t.after(()=>db.db.close());let now=T;
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'risk',riskPerTradePct:1,maxStopLossPct:0,maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:100,trailAfterR:0,floorAtR:0,limitEntry:undefined});
 const engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'source';
 const d=engine.onEntry({kind:'entry',side:'long',price:100,sl:95,tp:[],label:'entry',message:'',source:'alert',barTime:0,barIndex:0},{scannerId:'ai-predictive-flow-zeiierman',scannerName:'AI',symbol:'BLESSUSD',tf:'1h',market:{tickSize:.01,contractValue:1},refPrice:100,at:now,signalId:null,exitMode:'both'});
 now+=200;engine.onBar('BLESSUSD',{time:T,high:100,low:100,close:100},now);const p=engine.position(d.pendingId??d.position!.id)!;
 const selected=new Set<string>(),rows:any[]=[],subscriptions:any[]=[];
 const replay={includeStudy:(s:string)=>selected.add(s),setStudySymbols:(ss:string[])=>{selected.clear();ss.forEach(s=>selected.add(s));},setSymbols:()=>{},capturesStudy:(s:string)=>selected.has(s),record:(symbol:string,kind:string,payload:any,at:number)=>rows.push({symbol,kind,payload,at})};
 const app={db,paper:engine,shadow:{book:2,openPositions:()=>[],pendingEntries:()=>[]},replayArchive:replay,marks:{quoteSummary:()=>({rows:[{symbol:'BLESSUSD',fresh:true,bid:100,ask:101,exchangeAt:T+100,receivedAt:T+150}]}),funding:()=>null},
  orderFlow:{observeSymbols:()=>{},summary:()=>({covered:false,imbalance:null,throughAt:null,availableAt:null,minutes:0})},config:{get:()=>cfg},scanners:{requiredSeries:()=>[]},candles:{get:()=>[]},feed:{subscribe:(ch:string,sy:string[])=>subscriptions.push([ch,sy])}} as unknown as App;
 const factory=()=>Object.assign(new EventEmitter(),{start(){},stop(){},subscribe(){},unsubscribe(){}}) as unknown as DeltaFeed;
 const runtime=new MonitorRuntime(app,factory);t.after(()=>runtime.stop());
 return {app,db,cfg,p,engine,runtime,rows,selected,subscriptions};
}
test('entry-time capture binds a new non-fixed study pair immediately and preserves account policy/orders',t=>{
 const x=setup(t),before=JSON.stringify(x.p),config=JSON.stringify(x.cfg),orders=x.db.all('SELECT * FROM orders');
 x.runtime.captureEntry(x.p,0,T+200);x.runtime.captureEntry(x.p,0,T+201);
 assert.ok(x.selected.has('BLESSUSD'));const contexts=x.rows.filter(r=>r.kind==='study_entry_context');assert.equal(contexts.length,1);
 assert.equal(contexts[0].payload.positionId,x.p.id);assert.equal(contexts[0].payload.policyId,x.p.policy!.id);assert.equal(contexts[0].payload.observedAfterEntryMs,0);
 x.runtime.tick(T+5000);assert.equal(x.rows.filter(r=>r.kind==='study_entry_context').length,1);
 const sample=x.rows.find(r=>r.kind==='study_market_sample'&&r.symbol==='BLESSUSD');assert.equal(sample.payload.priceExchangeAt,T+100);assert.equal(sample.payload.priceReceivedAt,T+150);
 assert.equal(JSON.stringify(x.p),before);assert.equal(JSON.stringify(x.cfg),config);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);assert.equal(x.engine.pendingExits().length,0);
});
test('recent reference capture survives restart and retains the post-close horizon, while observation pauses stay explicit',t=>{
 const x=setup(t);x.db.run("UPDATE positions SET status='closed',exit_at=? WHERE id=?",T+1000,x.p.id);
 // DB is the restart source, not an in-memory active position or a backdated replay.
 x.engine.openPositions=()=>[];x.runtime.tick(T+5000);assert.ok(x.selected.has('BLESSUSD'));
 assert.ok(x.subscriptions.some(([ch,sy])=>ch==='ob_l1'&&sy.includes('BLESSUSD')));
 x.runtime.tick(T+25000);assert.ok(x.rows.some(r=>r.kind==='observer_gap'&&r.payload.delayMs===15000));
 x.runtime.tick(T+86400000+61000);assert.ok(!x.selected.has('BLESSUSD'));
});
test('capture failure cannot prevent a real position from remaining intact',t=>{
 const x=setup(t),before=JSON.stringify(x.p);x.db.db.exec('DROP TABLE decision_trace');
 assert.doesNotThrow(()=>x.runtime.captureEntry(x.p,0,T+200));assert.equal(JSON.stringify(x.p),before);assert.equal(x.p.status,'open');
});


test('REST advisory settlement archives original exchange and receipt times before offering depth',async t=>{
 const x=setup(t);x.app.paper.pendingExits=()=>[];x.app.shadow.pendingExits=()=>[];
 const raw={timestamp:(T-1500)*1000,buy:[{price:'99',size:'100'}],sell:[{price:'101',size:'100'}]};
 Object.assign(x.app,{rest:{orderbook:async()=>raw}});
 let offered:any;
 x.runtime.monitor.due=()=>[{symbol:'BLESSUSD'}] as any;
 x.runtime.monitor.settle=(_s,b,at)=>{offered={b,at};assert.ok(x.rows.some(r=>r.kind==='study_exit_book'));return undefined as any;};
 x.runtime['settle']();await new Promise<void>(resolve=>setImmediate(resolve));
 const event=x.rows.find(r=>r.kind==='study_exit_book');assert.ok(event);assert.equal(event.payload.book.exchangeAt,T-1500);
 assert.equal(event.payload.book.receivedAt,T);assert.deepEqual(event.payload.book,offered.b);assert.equal(event.at,offered.at);
});

test('intrabar research yields between bounded groups so execution callbacks can run first',async t=>{
 const x=setup(t);x.db.run("UPDATE positions SET bt=2,evidence_scope='shadow' WHERE id=?",x.p.id);
 const positions=Array.from({length:24},()=>({...x.p,entryAt:T,status:'open' as const}));
 Object.assign(x.app.shadow,{openPositions:()=>positions,advisoryObservation:()=>({config:x.cfg.paper,marketQty:1,exitPending:false})});
 const order:string[]=[];x.runtime.monitor.observeIntrabar=()=>{order.push('research');};
 setImmediate(()=>order.push('execution'));
 await x.runtime.intrabarTick();assert.equal(order.indexOf('execution'),8);assert.equal(order.filter(s=>s==='research').length,24);
});
