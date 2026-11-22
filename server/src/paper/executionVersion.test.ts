import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,tradePolicyIdFor,saveTradePolicy,loadTradePolicy} from './tradePolicy.ts';
import {strategyIdFor} from './strategyIdentity.ts';
import {additionalReadinessCompatibility,capacityExpansionCompatible} from '../analytics/readinessCompatibility.ts';
import {fullFeeCompatible} from '../evidence/compatibility.ts';
import {planSnapshot} from './executionPlans.ts';
import {CAUSAL_CANDLE_VERSION,CAUSAL_EXIT_VERSION,PaperExitExecution} from './exitExecution.ts';
import {SIM_VERSION} from './fingerprint.ts';
import type {Position} from './logic.ts';

const reidentify=(p:ReturnType<typeof resolveTradePolicy>)=>{p.strategyId=strategyIdFor(p);p.id=tradePolicyIdFor(p);return p;};
test('corrected execution changes trade, strategy and research identities, without reidentifying old policies',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
 const current=resolveTradePolicy(cfg,cell,'source');
 const old=reidentify({...structuredClone(current),sim:CAUSAL_EXIT_VERSION});
 assert.equal(current.sim,CAUSAL_CANDLE_VERSION);assert.equal(SIM_VERSION,CAUSAL_CANDLE_VERSION);
 assert.notEqual(old.id,current.id);assert.notEqual(old.strategyId,current.strategyId);
 assert.equal(additionalReadinessCompatibility(old,current),null);
 assert.equal(capacityExpansionCompatible(old,current),false);
 assert.equal(fullFeeCompatible(old,current,Date.now()),false);
 const db=new Db(':memory:');try{
  saveTradePolicy(db,old);saveTradePolicy(db,current);
  assert.deepEqual(loadTradePolicy(db,old.id),JSON.parse(JSON.stringify(old)));
  assert.deepEqual(loadTradePolicy(db,current.id),JSON.parse(JSON.stringify(current)));
 }finally{db.db.close();}
 const plan={id:'test',enabled:true,scannerId:'s',symbol:'BTCUSD',tf:'15m',variant:'current' as const,revision:1,referenceEquity:1000};
 const snapshot=planSnapshot(cfg,plan,'source');
 assert.equal(snapshot.executionVersion,CAUSAL_CANDLE_VERSION);
});

test('legacy execution tables migrate idempotently without changing an in-flight stop or its model',()=>{
 const db=new Db(':memory:');try{
  db.db.exec('CREATE TABLE paper_execution_positions(position_id INTEGER PRIMARY KEY,book INTEGER NOT NULL,version INTEGER NOT NULL,market_qty INTEGER NOT NULL,desired_stop REAL,ack_at INTEGER)');
  db.run('INSERT INTO paper_execution_positions VALUES(1,0,211,2,100,500)');
  const store=new PaperExitExecution(db,0);
  new PaperExitExecution(db,0);
  assert.deepEqual({...store.state(1)},{position_id:1,book:0,version:211,market_qty:2,desired_stop:100,ack_at:500,queued_stop:null,queued_ack_at:null,stop_active_at:null});
  const p={id:1,side:'long',sl:95,entryAt:100} as Position;
  assert.equal(store.acknowledge(p,499),false);assert.equal(p.sl,95);
  assert.equal(store.acknowledge(p,500),true);assert.equal(p.sl,100);
  assert.equal(store.view(1)!.version,211);
 }finally{db.db.close();}
});

test('sizing compatibility stays within each execution version and never bridges 211 to 212',()=>{
 for(const version of [211,212]){
  const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
  cfg.risk.enabled=true;cfg.risk.ddFrom='capital';cfg.risk.ddScale=[{ddPct:0,leverageMult:.5}];
  const old=reidentify({...resolveTradePolicy(cfg,cell,'source'),sim:version});
  cfg.risk.ddScale=[];
  const current=reidentify({...resolveTradePolicy(cfg,cell,'source'),sim:version});
  assert.equal(additionalReadinessCompatibility(old,current),'sizing-proof');
  current.sim=version===211?212:211;reidentify(current);
  assert.equal(additionalReadinessCompatibility(old,current),null);
 }
});
