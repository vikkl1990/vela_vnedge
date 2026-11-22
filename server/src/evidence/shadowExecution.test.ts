import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,T} from '../analytics/executionReplayFixture.ts';
import {replayReadinessExecution} from '../analytics/readinessExecutionReplay.ts';
import {tradePolicyIdFor} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {readEvidence,qualifiedEvidence,evidenceCoverage} from './trades.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {importShadowCohorts,shadowReplayDigest,replayShadowExecution,shadowExecutionCompatible,shadowExecutionEvidence,validateShadowCohort,type ShadowExecutionCohort} from './shadowExecution.ts';

function shadow(t:any,kind:'winner'|'loss'|'changed'|'candle'='loss',side:'long'|'short'='long') {
 const x=fixture(t,kind,side,2);
 const run=()=>replayShadowExecution(x.db,x.p.id,x.previous,x.current,x.events,x.coverage);
 const cohort=():ShadowExecutionCohort=>({version:1,from:T-60000,to:x.p.exitAt!,policy:x.current,results:[run()]});
 const cell={scannerId:x.p.scannerId,symbol:x.p.symbol,tf:x.p.tf};
 const install=(cs=[cohort()])=>importShadowCohorts(x.db,cs,shadowReplayDigest(cs),()=>{},T+200000);
 return {...x,run,cohort,cell,install};
}
for(const side of ['long','short'] as const)for(const kind of ['winner','loss'] as const)test(`shadow ${side} ${kind}: dual replay restores shared evidence without rewriting fills`,t=>{
 const x=shadow(t,kind,side),before=JSON.stringify(x.db.all('SELECT * FROM positions'));
 assert.equal(x.run().outcome,'identical',JSON.stringify(x.run()));
 assert.equal(readEvidence(x.db,x.cell,x.current,{at:T+200000}).length,0);
 assert.deepEqual(x.install(),{cohorts:1,trades:1});
 const evidence=qualifiedEvidence(x.db,x.cell,x.current,{at:T+200000});
 assert.equal(evidence.length,1);assert.equal(evidence[0].basis,'execution-replay');
 assert.equal(evidence[0].r,(x.p.realizedPnl-x.p.fees)/x.p.riskAmount);
 assert.equal(evidenceCoverage(x.db,x.cell,2,x.current,T+200000).matching,1);
 assert.equal(JSON.stringify(x.db.all('SELECT * FROM positions')),before);
 assert.equal(readEvidence(x.db,x.cell,x.current,{book:0,at:T+200000}).length,0);
 assert.equal(readEvidence(x.db,x.cell,x.current,{at:T}).length,0);
 assert.equal(readEvidence(x.db,x.cell,x.current,{at:T+200000,limit:1}).length,1);
 assert.deepEqual(x.install(),{cohorts:1,trades:1});
});
for(const kind of ['changed','candle'] as const)test(`changed ${kind} exits cannot qualify`,t=>{
 const x=shadow(t,kind);assert.equal(x.run().outcome,'changed');
 assert.throws(()=>x.install(),/incomplete or incompatible/);assert.equal(shadowExecutionEvidence(x.db,x.current).size,0);
});
test('one missing/changed loss blocks the whole cohort, not only that trade',t=>{
 const x=shadow(t,'winner');x.install();
 const row=x.db.get<any>('SELECT * FROM positions WHERE id=?',x.p.id);row.id+=100;row.realized_pnl=-100;
 const keys=Object.keys(row);x.db.run(`INSERT INTO positions (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,...keys.map(k=>row[k]));
 assert.equal(shadowExecutionEvidence(x.db,x.current,T+200000).size,0);
 assert.throws(()=>x.install(),/incomplete or incompatible/);
});
test('wrong-book callbacks, missing coverage and feed gaps are not evidence',t=>{
 const x=shadow(t);
 assert.equal(replayReadinessExecution(x.db,x.p.id,x.previous,x.current,x.events,x.coverage).outcome,'unverified');
 const events=x.events.map(e=>e.kind==='paper_bar'?{...e,payload:{...e.payload,book:0}}:e);
 assert.equal(replayShadowExecution(x.db,x.p.id,x.previous,x.current,events,x.coverage).reason,'missing-candle-inputs');
 assert.equal(replayShadowExecution(x.db,x.p.id,x.previous,x.current,x.events,{...x.coverage,verified:false}).outcome,'unverified');
 x.events.splice(1,0,{version:1,receivedAt:T,archiveSequence:2,symbol:x.p.symbol,kind:'gap',source:'execution-feed',payload:{}});x.events.forEach((e,i)=>e.archiveSequence=i+1);
 assert.equal(x.run().reason,'archive-gap');
});
test('policy identities must match the existing strategy boundary; no reader/fee/exit alias',t=>{
 const x=shadow(t);
 for(const change of [(p:any)=>p.reading.reader=2,(p:any)=>p.sourceHash='different',(p:any)=>p.paper.feeRatePct++,(p:any)=>p.paper.trailAfterR++,(p:any)=>p.risk.regime.minScore++]){
  const current=structuredClone(x.current);change(current);current.strategyId=strategyIdFor(current);current.id=tradePolicyIdFor(current);
  assert.equal(shadowExecutionCompatible(x.previous,current),false);
 }
 const current=structuredClone(x.current);current.paper.marginPerTrade=(current.paper.marginPerTrade??150)+1;
 assert.equal(shadowExecutionCompatible(x.previous,current),false,'malformed hashes');
});
test('ledger changes, quarantine, research scope and bad receipts revoke the whole proof',t=>{
 const x=shadow(t);x.install();
 x.db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",x.p.id,x.p.entryAt,T);
 assert.equal(qualifiedEvidence(x.db,x.cell,x.current,{at:T+200000}).length,0);
 x.db.run('DELETE FROM evidence_flags');x.db.run('UPDATE positions SET fees=fees+1');
 assert.equal(shadowExecutionEvidence(x.db,x.current).size,0);x.db.run('UPDATE positions SET fees=fees-1');
 x.db.run("UPDATE positions SET evidence_scope='experiment'");assert.equal(shadowExecutionEvidence(x.db,x.current).size,0);
 x.db.run("UPDATE positions SET evidence_scope='shadow'");x.db.run("UPDATE shadow_execution_cohorts SET proof='{}'");assert.equal(shadowExecutionEvidence(x.db,x.current).size,0);
});
test('forward restoration remains mandatory after an execution proof',t=>{
 const x=shadow(t,'winner');x.install();
 x.db.run('INSERT INTO evidence_restorations VALUES(?,?,?,?,?,?,?)',x.current.strategyId,x.cell.scannerId,x.cell.symbol,x.cell.tf,T+10000,JSON.stringify({version:1,stressBps:5,gate:{minTrades:20,minDays:14}}),'{}');
 assert.equal(readEvidence(x.db,x.cell,x.current,{at:T+200000}).length,1);
 assert.equal(qualifiedEvidence(x.db,x.cell,x.current,{at:T+200000}).length,0);
});
test('import is offline, checksummed, atomic, duplicate-safe and cannot shrink a window',t=>{
 const x=shadow(t),c=x.cohort();
 assert.throws(()=>importShadowCohorts(x.db,[c],shadowReplayDigest([c]),()=>{throw Error('active');}),/active/);
 assert.throws(()=>importShadowCohorts(x.db,[c],'0'.repeat(64),()=>{}),/checksum mismatch/);
 assert.throws(()=>x.install([c,c]),/duplicate/);assert.equal(shadowExecutionEvidence(x.db,x.current).size,0);
 x.install();assert.throws(()=>x.install([{...c,from:c.from+1}]),/cannot shrink/);
 assert.deepEqual(validateShadowCohort(x.db,{...c,results:[c.results[0],c.results[0]]},x.current),[]);
});

test('per-trade backwards receipt time remains unverified even with increasing archive order',t=>{
 const x=shadow(t);x.events[1].receivedAt=T+4000;
 assert.equal(x.run().reason,'input-order');assert.equal(x.run().outcome,'unverified');
});

test('copy display counts restored trades without treating one restored cell as a qualifying sample',t=>{
 const x=shadow(t,'winner');x.install();
 const store=new IncubatorStore(x.db);store.policyFor=()=>x.current;
 const before=JSON.stringify(x.db.all('SELECT * FROM positions'));
 const mirror={enabled:true,minTrades:5,minNetR:0};
 const view=store.copyReadiness(x.cell,mirror,1e8,T+200000).evidence;
 assert.equal(view.stats.trades,1);assert.equal(view.replayed,1);assert.equal(view.exact,0);
 assert.equal(view.availableReplayed,1);assert.equal(view.minTrades,5);
 assert.equal(view.stats.netR,qualifiedEvidence(x.db,x.cell,x.current,{at:T+200000})[0].r);
 assert.match(store.copyRefusal(x.cell,mirror,1e8,T+200000,{readOnly:true})!,/1\/5 shadow closes/);
 assert.equal(JSON.stringify(x.db.all('SELECT * FROM positions')),before);
 x.db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",x.p.id,x.p.entryAt,T);
 const quarantined=store.copyReadiness(x.cell,mirror,1e8,T+200000).evidence;
 assert.equal(quarantined.stats.trades,0);assert.equal(quarantined.replayed,0);
});

test('qualification validates exact replay evidence once and preserves limit semantics',t=>{
 const x=shadow(t,'winner');x.install();
 const get=x.db.get.bind(x.db);let proofs=0;
 x.db.get=((query:string,...args:any[])=>{if(query.includes('FROM shadow_execution_cohorts'))proofs++;return get(query,...args);}) as typeof x.db.get;
 for(const limit of [undefined,0,-1,.5,1,2,Infinity]){
  proofs=0;
  const actual=qualifiedEvidence(x.db,x.cell,x.current,{at:T+200000,limit});
  assert.equal(proofs,1,'no duplicate complete-cohort validation in one synchronous qualification');
  assert.deepEqual(actual,readEvidence(x.db,x.cell,x.current,{at:T+200000,limit}));
 }
});
