import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {MonitorRuntime} from './monitorRuntime.ts';
import type {App} from '../app.ts';
import {DeltaFeed} from '../delta/ws.ts';
const T=1800000000000;
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
 return {db,cfg,p,engine,runtime,rows,selected,subscriptions};
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
