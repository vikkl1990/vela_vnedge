import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Db} from '../db.ts';
import {FundingJournal} from '../execution/fundingJournal.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,tradePolicyIdFor,stablePolicy} from '../paper/tradePolicy.ts';
import {requireReadinessMaintenance,importReadinessReceipts} from './readinessReplayImport.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {currentPolicyEvidence} from './policyHealth.ts';
import {executionReplayEvidence,executionPolicyCompatible,replayReadinessExecution,recordExecutionReplay,type ExecutionReplayEvent} from './readinessExecutionReplay.ts';

const T=1800000060000;
function fixture(t:any,kind:'loss'|'winner'|'changed'|'candle'='loss',side:'long'|'short'='long'){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,minRiskFeeRatio:0,maxSignalAgeSec:0,minSizeShare:0,
  slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,useSpread:false,requireQuote:false,
  liquidation:false,fillSource:'candles',latencyMs:1500,skipScriptStops:false,allowReversal:true,
  trailAfterR:.5,floorAtR:0,trailGiveBackPct:20,trailSteps:[],trailStall:undefined,trailAtrMult:0,staleBars:0,earlyCut:undefined,earlyStall:undefined,
  tpSplit:[0,0,1],limitEntry:{enabled:false,tfs:[],atr:0,bars:2,books:[]}});
 let now=T-2000;const engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.sourceHashFor=()=> 'source';engine.causalExits=true;
 engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?98:102,tp:side==='long'?[104,108,112]:[96,92,88],source:'alert',label:side,message:'',barTime:T-900000,barIndex:0},
  {scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{contractValue:1,tickSize:.01},atr:1,refPrice:100,at:now,signalId:null,exitMode:'both'});
 const events:ExecutionReplayEvent[]=[];let sequence=0;
 const tick=(at:number,price:number)=>{now=at;price=side==='long'?price:200-price;const payload={price,qty:1000,timeMs:at,id:String(at)};events.push({version:1,receivedAt:at,archiveSequence:++sequence,symbol:'BTCUSD',kind:'trade',source:'execution-feed',payload});engine.onTrade('BTCUSD',price,1000,at,at,String(at));};
 tick(T-1000,100);now=T;engine.onBar('BTCUSD',{time:T,close:100,low:100,high:100,volume:100},now);
 const p=engine.openPositions()[0];assert.ok(p,'fixture entered');
 const current=structuredClone(p.policy!),previous=structuredClone(current);previous.sim=211;previous.strategyId=strategyIdFor(previous);previous.id=tradePolicyIdFor(previous);
 saveTradePolicy(db,previous);p.policy=previous;db.run('UPDATE positions SET policy_id=? WHERE id=?',previous.id,p.id);db.run('UPDATE paper_execution_positions SET version=211 WHERE position_id=?',p.id);
 now=T+100;const bar={time:T,close:100,low:100,high:100,volume:100};events.push({version:1,receivedAt:now,archiveSequence:++sequence,symbol:p.symbol,kind:'paper_bar',source:'paper-input',payload:{book:0,bar,historical:false}});engine.onBar(p.symbol,bar,now);
 if(kind==='candle'){
  now=T+120000;const candle={time:T+60000,open:100,high:100,low:97,close:100,volume:100};
  events.push({version:1,receivedAt:now,archiveSequence:++sequence,symbol:p.symbol,kind:'paper_bar',source:'paper-input',payload:{book:0,bar:candle,historical:false}});
  engine.onBar(p.symbol,candle,now);assert.equal(p.status,'open');tick(T+121000,97.9);
 }else if(kind==='loss')tick(T+3000,97.9);
 else{
  tick(T+1000,101.2);
  if(kind==='changed')tick(T+1200,101.8);
  tick(T+3000,kind==='changed'?101.2:100.9);
  if(kind==='changed')tick(T+4000,100.9);
 }
 now=kind==='candle'?T+124000:T+6000;const bid=['loss','candle'].includes(kind)?97.8:100.8,ask=bid+.1;
 engine.settleExits(p.symbol,{receivedAt:now,exchangeAt:now-10,bids:[{price:side==='long'?bid:200-ask,size:10000}],asks:[{price:side==='long'?ask:200-bid,size:10000}]},now);
 assert.equal(p.status,'closed');
 const coverage={from:T-60000,to:now,segments:1,verified:true,sha256:'a'.repeat(64)};
 return {db,engine,p,previous,current,events,coverage,run:()=>replayReadinessExecution(db,p.id,previous,current,events,coverage)};
}
for(const side of ['long','short'] as const)for(const kind of ['loss','winner'] as const)test(`verified identical ${side} ${kind} counts without rewriting history`,t=>{
 const x=fixture(t,kind,side),before=JSON.stringify({p:x.db.all('SELECT * FROM positions'),o:x.db.all('SELECT * FROM orders'),policies:x.db.all('SELECT * FROM trade_policies')});
 const result=x.run();assert.equal(result.outcome,'identical',JSON.stringify(result));
 assert.equal(currentPolicyEvidence(x.db,x.engine).ids.size,0);
 recordExecutionReplay(x.db,result);assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),'identical');
 const evidence=currentPolicyEvidence(x.db,x.engine);assert.ok(evidence.executionCompatibleIds.has(x.p.id));assert.equal(evidence.exactIds.size,0);
 assert.equal(JSON.stringify({p:x.db.all('SELECT * FROM positions'),o:x.db.all('SELECT * FROM orders'),policies:x.db.all('SELECT * FROM trade_policies')}),before);
 recordExecutionReplay(x.db,result);assert.equal(x.db.get<any>('SELECT count(*) n FROM readiness_execution_replays').n,1);
});
test('tighter queued amendment changes execution and must not count',t=>{
 const x=fixture(t,'changed'),result=x.run();assert.equal(result.outcome,'changed',JSON.stringify(result));recordExecutionReplay(x.db,result);
 assert.equal(currentPolicyEvidence(x.db,x.engine).ids.size,0);
 assert.equal(currentPolicyEvidence(x.db,x.engine).excludedReasons.get(x.p.id),'execution-replay-changed');
});
test('observed quiet-tape wick changes 212 and is not silently restored',t=>{
 const x=fixture(t,'candle'),result=x.run();assert.equal(result.outcome,'changed',JSON.stringify(result));
 assert.equal(result.reason,'candle-or-amendment-changed');
});
test('missing candles, coverage, pre-roll and process gaps cannot become equivalence',t=>{
 const x=fixture(t);
 for(const [name,events,coverage] of [
  ['candles',x.events.filter(e=>e.kind!=='paper_bar'),x.coverage],
  ['preroll',x.events.filter(e=>e.receivedAt>=T),x.coverage],
  ['coverage',x.events,{...x.coverage,from:T}],
  ['verification',x.events,{...x.coverage,verified:false}],
  ['order',[...x.events].reverse(),x.coverage],
  ['gap',x.events.map((e,i)=>i===1?{...e,symbol:'*',kind:'gap',source:'archive',payload:{reason:'process start'}}:e),x.coverage],
 ] as const){const result=replayReadinessExecution(x.db,x.p.id,x.previous,x.current,[...events],coverage);assert.equal(result.outcome,'unverified',name);}
});
test('baseline mismatch fails even if both replay arms agree',t=>{
 const x=fixture(t);x.events[x.events.length-1].payload.price=97.5;
 const result=x.run();assert.equal(result.reason,'baseline-mismatch');assert.equal(result.outcome,'unverified');
});
test('one millisecond trigger drift is a mismatch, not a floating point tolerance',t=>{
 const x=fixture(t);const tick=x.events.at(-1)!;tick.receivedAt++;tick.payload.timeMs++;
 assert.equal(x.run().reason,'baseline-mismatch');
});
test('capture loss reported after closure invalidates its retained prefix',t=>{
 const x=fixture(t);x.coverage=Object.assign(x.coverage,{gaps:[{from:T+2000,to:T+10000}]});
 assert.equal(x.run().reason,'archive-gap');
});
test('receipt fails after journal correction, policy change or receipt tampering',t=>{
 const x=fixture(t),proof=x.run();recordExecutionReplay(x.db,proof);
 x.db.run('UPDATE positions SET fees=fees+1 WHERE id=?',x.p.id);
 assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),null);
 assert.throws(()=>recordExecutionReplay(x.db,proof),/subject changed/);
 x.db.run('UPDATE positions SET fees=fees-1 WHERE id=?',x.p.id);
 x.db.run("UPDATE readiness_execution_replays SET result='{}'");assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),null);
});
test('later advisory feature enrichment does not erase verified execution history',t=>{
 const x=fixture(t),proof=x.run();recordExecutionReplay(x.db,proof);
 x.db.run("UPDATE positions SET fills=json_set(fills,'$.features.new_context',123,'$.mlProb',0.75),scanner_name='Renamed display' WHERE id=?",x.p.id);
 assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),'identical');
});
test('risk, fees, source, reader and 210 history cannot bypass evidence requirements',t=>{
 const x=fixture(t);
 for(const change of [(p:any)=>p.paper.maxStopLossPct++, (p:any)=>p.paper.feeRatePct++, (p:any)=>p.sourceHash='new', (p:any)=>p.reading.reader=2,(p:any)=>p.risk.maxDailyLossPct++]){
  const current=structuredClone(x.current);change(current);current.strategyId=strategyIdFor(current);current.id=tradePolicyIdFor(current);
  assert.equal(executionPolicyCompatible(x.db,x.p.id,x.previous,current),false);
 }
 const old=structuredClone(x.previous);old.sim=210;old.strategyId=strategyIdFor(old);old.id=tradePolicyIdFor(old);
 assert.equal(executionPolicyCompatible(x.db,x.p.id,old,x.current),false);
});
test('quarantined or research trades never count, even with an earlier valid receipt',t=>{
 const x=fixture(t),proof=x.run();recordExecutionReplay(x.db,proof);
 x.db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",x.p.id,x.p.entryAt,T);
 assert.equal(x.run().reason,'quarantined');assert.equal(currentPolicyEvidence(x.db,x.engine).ids.size,0);
 x.db.run('DELETE FROM evidence_flags');x.db.run("UPDATE positions SET evidence_scope='experiment' WHERE id=?",x.p.id);
 assert.equal(x.run().outcome,'unverified');assert.equal(currentPolicyEvidence(x.db,x.engine).ids.size,0);
});

test('same-millisecond entry candle must be insensitive to its commit boundary',t=>{
 const x=fixture(t,'winner');
 // Last pre-roll is beyond fallback age. The possible post-fill candle close
 // can trigger a stop even though skipping it reproduces the ledger.
 x.events[0].receivedAt=T-10000;x.events[0].payload.timeMs=T-10000;
 x.events.splice(1,0,{version:1,receivedAt:T,archiveSequence:2,symbol:'BTCUSD',kind:'paper_bar',source:'paper-input',payload:{book:0,historical:false,bar:{time:T,close:97,low:97,high:100,volume:100}}});
 x.events.forEach((e,i)=>e.archiveSequence=i+1);
 assert.equal(x.run().reason,'entry-boundary-sensitive');assert.equal(x.run().outcome,'unverified');
});
test('harmless entry candle retains credit and prior algorithm receipts expire',t=>{
 const x=fixture(t);x.events.splice(1,0,{version:1,receivedAt:T,archiveSequence:2,symbol:'BTCUSD',kind:'paper_bar',source:'paper-input',payload:{book:0,historical:false,bar:{time:T,close:100,low:100,high:100,volume:100}}});
 x.events.forEach((e,i)=>e.archiveSequence=i+1);
 const proof=x.run();assert.equal(proof.outcome,'identical');recordExecutionReplay(x.db,proof);
 x.db.run("UPDATE readiness_execution_replays SET result=json_set(result,'$.version',1)");
 assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),null);
});

function addFunding(x:ReturnType<typeof fixture>,rate=.01){
 new FundingJournal(x.db);
 const at=T+2000;
 x.db.run("INSERT INTO funding_settlements(symbol,at,rate,rate_at,mark,mark_at,status,source) VALUES(?,?,?,?,?,?,'applied','observed-websocket')",x.p.symbol,at,rate,at-1000,100,at);
 // Late accounting reconciliation is deliberately after the recorded close.
 assert.equal(x.engine.reconcileFunding(x.p.symbol,rate,100,at),1);
}
for(const side of ['long','short'] as const)test(`verified ${side} funding survives replay without changing the price exit`,t=>{
 const x=fixture(t,'winner',side);addFunding(x);
 const result=x.run();assert.equal(result.outcome,'identical',JSON.stringify(result));assert.equal(result.extensions?.funding,1);
 recordExecutionReplay(x.db,result);assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),'identical');
 x.db.run('UPDATE funding_settlements SET mark=101');
 assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),null);
 assert.equal(x.run().reason,'funding-unverified');
});
test('funding evidence must be fresh, applied and complete; changed exits still do not count',t=>{
 const x=fixture(t,'changed');addFunding(x);assert.equal(x.run().outcome,'changed');
 x.db.run("INSERT INTO funding_settlements(symbol,at,status,source) VALUES(?,?,'unresolved','missed-feed')",x.p.symbol,T+2500);
 assert.equal(x.run().reason,'funding-unverified');x.db.run('DELETE FROM funding_settlements WHERE at=?',T+2500);
 x.db.run("UPDATE funding_settlements SET status='unresolved'");assert.equal(x.run().reason,'funding-unverified');
 x.db.run("UPDATE funding_settlements SET status='applied',rate_at=at-120001");assert.equal(x.run().reason,'funding-unverified');
 x.db.run('DELETE FROM funding_settlements');assert.equal(x.run().reason,'funding-unverified');
});
test('verified quiet capture replaces a missing seed tick, never missing capture',t=>{
 const x=fixture(t);
 x.events[0]={...x.events[0],receivedAt:T-20000,kind:'mark',payload:{markPrice:100,timeMs:T-20000}};
 const coverage={...x.coverage,selectionWindow:{symbol:x.p.symbol,from:T-60000,to:x.p.exitAt!}};
 const run=()=>replayReadinessExecution(x.db,x.p.id,x.previous,x.current,x.events,coverage);
 assert.equal(run().outcome,'identical');assert.equal(run().extensions?.quietTape,1);
 assert.equal(x.run().reason,'missing-tape-preroll');
 x.events[0].receivedAt=T-6000;assert.equal(run().reason,'missing-tape-preroll');
 x.events[0].receivedAt=T-20000;coverage.selectionWindow.from=T-10000;assert.equal(run().outcome,'unverified');
});
test('filtered capture windows must contain the trade even with a seed tick',t=>{
 const x=fixture(t);
 for(const window of [{symbol:'ETHUSD',from:T-60000,to:T+6000},{symbol:'BTCUSD',from:NaN,to:T+6000},{symbol:'BTCUSD',from:T-60000,to:T+1000}]){
  assert.equal(replayReadinessExecution(x.db,x.p.id,x.previous,x.current,x.events,{...x.coverage,selectionWindow:window}).reason,'archive-coverage');
 }
});
test('funding replay extension preserves existing no-funding version-2 receipts',t=>{
 const x=fixture(t);recordExecutionReplay(x.db,x.run());
 new FundingJournal(x.db);
 x.db.run("INSERT INTO funding_settlements(symbol,at,status,source) VALUES(?,?,'unresolved','missed-feed')",x.p.symbol,T-100000);
 assert.equal(executionReplayEvidence(x.db,x.p.id,x.previous,x.current),'identical');
});
test('audit writes refuse every service state except verified inactive',()=>{
 for(const state of ['active','activating','deactivating','reloading','failed','unknown',''])assert.throws(()=>requireReadinessMaintenance(()=>state),/Stop vnedge/);
 assert.throws(()=>requireReadinessMaintenance(()=>{throw Error('unavailable');}),/Cannot verify/);
 assert.doesNotThrow(()=>requireReadinessMaintenance(()=> 'inactive\n'));
});
test('receipt importer refuses active services and unreviewed reports before writing',t=>{
 const x=fixture(t),results=[x.run()],catalog=new Map([[x.p.id,x.current]]),digest=createHash('sha256').update(stablePolicy(results)).digest('hex');
 assert.throws(()=>importReadinessReceipts(x.db,results,catalog,digest,()=>requireReadinessMaintenance(()=> 'active')),/Stop vnedge/);
 assert.throws(()=>importReadinessReceipts(x.db,results,catalog,'0'.repeat(64),()=>{}),/checksum mismatch/);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM readiness_execution_replays').n,0);
});
test('offline receipt import is atomic and idempotent and never overwrites trades',t=>{
 const x=fixture(t),proof=x.run(),catalog=new Map([[x.p.id,x.current]]),digest=(r:unknown)=>createHash('sha256').update(stablePolicy(r)).digest('hex');
 const before=JSON.stringify(x.db.all('SELECT * FROM positions'));
 assert.throws(()=>importReadinessReceipts(x.db,[proof,proof],catalog,digest([proof,proof]),()=>{}),/duplicate replay subject/);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM readiness_execution_replays').n,0);
 assert.deepEqual(importReadinessReceipts(x.db,[proof],catalog,digest([proof]),()=>{}),{recorded:1,retained:0,identical:1});
 assert.deepEqual(importReadinessReceipts(x.db,[proof],catalog,digest([proof]),()=>{}),{recorded:0,retained:1,identical:1});
 assert.equal(JSON.stringify(x.db.all('SELECT * FROM positions')),before);
 x.db.run('UPDATE positions SET fees=fees+1 WHERE id=?',x.p.id);
 assert.throws(()=>importReadinessReceipts(x.db,[proof],catalog,digest([proof]),()=>{}),/subject changed/);
});
