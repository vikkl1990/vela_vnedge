import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {fullFeeCompatible,paidFullCommissions} from './compatibility.ts';
import {qualifiedEvidence,readEvidence} from './trades.ts';

const cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
function policies(){
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.skipScriptStops=false;cfg.paper.marginPerTrade=150;cfg.paper.maxStopLossPct=3;
 cfg.paper.scalperOffer={enabled:true,majors:['BTCUSD','ETHUSD'],majorsMinutes:30,othersMinutes:15,excluded:[]};
 const previous=resolveTradePolicy(cfg,cell,'source');
 cfg.paper.scalperOffer.verification={source:'delta-india-trading-preferences',accountHash:'a'.repeat(64),connectionRevision:'test',verifiedAt:200,effectiveFrom:200};
 const current=resolveTradePolicy(cfg,cell,'source');return {cfg,previous,current};
}
const fills=()=>[
 {at:100,price:100,qty:10,reason:'entry',fee:.59,liquidity:'taker',feeWaived:false},
 {at:150,price:102,qty:10,reason:'trail',fee:.6018,liquidity:'taker',feeWaived:false},
];
const paidRow=()=>({fills:JSON.stringify({fills:fills()}),fees:1.1918,qty:10,contract_value:1,entry_at:100,exit_at:150});

test('verification can reuse otherwise identical full-fee evidence only in the conservative direction and after verification',()=>{
 const {cfg,previous,current}=policies(),before=JSON.stringify({cfg,previous,current});
 assert.equal(fullFeeCompatible(previous,current,250),true);
 assert.equal(fullFeeCompatible(previous,current,199),false,'no future eligibility evidence');
 assert.equal(fullFeeCompatible(current,previous,250),false,'discounted history is not full-fee evidence');
 assert.equal(fullFeeCompatible({...previous,adoptedAt:1},current,250),false);
 assert.equal(JSON.stringify({cfg,previous,current}),before,'no mutation or backdated fee credit');
 assert.equal(paidFullCommissions(paidRow(),previous),true);
});

for(const field of ['source','sim','tf','stop','target','entry','makerFee','takerFee','tax','regime','reading','window','exclusions','unknown'])test(`conservative compatibility refuses changed ${field}`,()=>{
 const {previous,current}=policies();const p=structuredClone(current);
 switch(field){
  case 'source':p.sourceHash='changed';break;case 'sim':p.sim++;break;case 'tf':p.tf='1h';break;
  case 'stop':p.paper.fallbackAtrSl++;break;case 'target':p.paper.fallbackRR=[7,8,9];break;
  case 'entry':p.paper.entryBatchMs=999;break;case 'makerFee':p.paper.makerFeeRatePct=.03;break;
  case 'takerFee':p.paper.feeRatePct=.06;break;case 'tax':p.paper.feeTaxPct=19;break;
  case 'regime':p.risk.regime.minAtrPct++;break;case 'reading':p.reading.invert=true;break;
  case 'window':p.paper.scalperOffer!.majorsMinutes=60;break;case 'exclusions':p.paper.scalperOffer!.excluded=['BTCUSD'];break;
  case 'unknown':(p.paper as any).futureExecutionRule=true;break;
 }
 p.strategyId=strategyIdFor(p);assert.equal(fullFeeCompatible(previous,p,250),false);
});

test('tampered snapshots, enrollment changes and another verified offer cannot pass as full-fee provenance',()=>{
 const {previous,current}=policies();
 assert.equal(fullFeeCompatible({...previous,strategyId:'wrong'},current,250),false);
 const old=structuredClone(previous);old.paper.scalperOffer!.joinedAt=1;old.strategyId=strategyIdFor(old);
 assert.equal(fullFeeCompatible(old,current,250),false);
 const other=structuredClone(current);other.paper.scalperOffer!.verification!.accountHash='b'.repeat(64);other.strategyId=strategyIdFor(other);
 assert.equal(fullFeeCompatible(current,other,250),false);
 const unknown=structuredClone(current);unknown.paper.scalperOffer!.verification!.accountHash='invalid';unknown.strategyId=strategyIdFor(unknown);
 assert.equal(fullFeeCompatible(previous,unknown,250),false);
});

for(const fault of ['waived','discount','undercharged','missing','duplicates','wrongTotal','badTime','missingLiquidity','corrupt'])test(`commission proof rejects ${fault} fills`,()=>{
 const {previous}=policies(),row=paidRow(),f=fills() as any[];
 switch(fault){
  case 'waived':f[1].feeWaived=true;break;case 'discount':f[1].feeDiscount=.1;break;
  case 'undercharged':f[1].fee=.5;row.fees=1.09;break;case 'missing':f.pop();row.fees=.59;break;
  case 'duplicates':f.push({...f[1]});row.fees+=.6018;break;case 'wrongTotal':row.fees=0;break;
  case 'badTime':f[1].at=99;break;case 'missingLiquidity':delete f[1].liquidity;break;
 }
 row.fills=fault==='corrupt'?'bad json':JSON.stringify({fills:f});
 assert.equal(paidFullCommissions(row,previous),false);
});

test('shared reader keeps strict mode by default; opt-in full-fee research preserves costs, losses, exclusions and ordering',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const {cfg,previous,current}=policies(),before=JSON.stringify(cfg);
 saveTradePolicy(db,previous);saveTradePolicy(db,current);
 const add=(policy:string|null,overrides:any={})=>{
  const r={...paidRow(),scanner_id:'s',scanner_name:'s',symbol:'BTCUSD',tf:'15m',side:'long',status:'closed',bt:2,
   qty_open:0,entry_price:100,risk_amount:10,realized_pnl:20,policy_id:policy,...overrides};
  return Number(db.run(`INSERT INTO positions(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(()=>'?').join(',')})`,...Object.values(r)).lastInsertRowid);
 };
 const old=add(previous.id,{realized_pnl:-10});const exact=add(current.id);
 add(null);add(previous.id,{policy_adopted_at:1});add(previous.id,{evidence_scope:'tracker'});
 const bad=add(previous.id);db.run("INSERT INTO evidence_flags VALUES(?,100,'quarantined','test','test',200)",bad);
 add(previous.id,{fees:0});
 const rowsBefore=db.all('SELECT id,fees,realized_pnl,policy_id FROM positions');
 assert.deepEqual(qualifiedEvidence(db,cell,current,{at:250}).map(r=>r.positionId),[exact]);
 const result=readEvidence(db,cell,current,{at:250,compatibility:'full-fee'});
 assert.deepEqual(result.map(r=>[r.positionId,r.basis]),[[old,'full-fee'],[exact,'exact']]);
 assert.equal(result[0].r,(-10-1.1918)/10,'keep losses and full fees exactly');
 assert.deepEqual(readEvidence(db,cell,current,{at:250,compatibility:'full-fee',limit:1}).map(r=>r.positionId),[exact]);
 assert.deepEqual(db.all('SELECT id,fees,realized_pnl,policy_id FROM positions'),rowsBefore);
 assert.equal(JSON.stringify(cfg),before);
});
