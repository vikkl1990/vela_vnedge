import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {IncubatorStore} from './store.ts';
import {evaluate} from './cycle.ts';

const DAY=86400_000,T=Date.UTC(2026,10,14),cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
function setup(t:any){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.paper.skipScriptStops=false;cfg.incubator.gate.pool='pair';cfg.incubator.maxShadow=1;
 const policy=resolveTradePolicy(cfg,cell,'current'),old=resolveTradePolicy(cfg,cell,'previous');
 saveTradePolicy(db,policy);saveTradePolicy(db,old);
 const store=new IncubatorStore(db);store.policyFor=()=>policy;
 const row=store.move(cell,'shadow','test',null,null,T-15*DAY);
 store.setScreen(row.id,{at:T-10*DAY,pass:false,trades:30,profitFactor:.9},T-10*DAY);
 const add=(r:number,{policyId=policy.id,scope='shadow',at=T-DAY,adopted=null as number|null}={})=>{
  const x={scanner_id:'s',scanner_name:'s',symbol:'BTCUSD',tf:'15m',status:'closed',side:'long',bt:2,
   qty:1,qty_open:0,contract_value:1,entry_price:100,entry_at:at,exit_at:at+1000,realized_pnl:r,fees:0,risk_amount:1,
   policy_id:policyId,evidence_scope:scope,policy_adopted_at:adopted};
  return Number(db.run(`INSERT INTO positions(${Object.keys(x).join(',')}) VALUES(${Object.keys(x).map(()=>'?').join(',')})`,...Object.values(x)).lastInsertRowid);
 };
 return {db,cfg,store,row,add,policy,old};
}
test('retirement cannot mix old-policy losses into a positive current forward sample',t=>{
 const f=setup(t);for(let i=0;i<20;i++)f.add(-1,{policyId:f.old.id,at:T-2*DAY-i*2000});
 for(let i=0;i<3;i++)f.add(.5,{at:T-DAY+i*2000});
 const before=JSON.stringify(f.cfg);const rep=evaluate(f.store,f.cfg,T);
 assert.equal(f.store.get(f.row.id)?.stage,'shadow');assert.equal(rep.retired.length,0);assert.equal(rep.proposed.length,0);
 assert.equal(f.store.shadowEvaluation(f.row,T).trades.length,3);
 assert.equal(f.store.qualifiedTrades('s','BTCUSD','15m',2,T).length,3);
 assert.equal(JSON.stringify(f.cfg),before);
});
test('old-policy wins cannot rescue current losses from the unchanged failed-screen retirement rule',t=>{
 const f=setup(t);for(let i=0;i<20;i++)f.add(1,{policyId:f.old.id,at:T-2*DAY-i*2000});
 for(let i=0;i<3;i++)f.add(-.5,{at:T-DAY+i*2000});
 const rep=evaluate(f.store,f.cfg,T);assert.equal(f.store.get(f.row.id)?.stage,'retired');assert.equal(rep.retired.length,1);
});
test('tracker, adopted and quarantined outcomes cannot supply retirement performance evidence',t=>{
 const f=setup(t);f.add(-10,{scope:'tracker'});f.add(-10,{adopted:T-DAY});
 const id=f.add(-10);f.db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','test','test',?)",id,T-DAY,T);
 f.add(.5,{at:T-DAY+2000});
 evaluate(f.store,f.cfg,T);assert.equal(f.store.get(f.row.id)?.stage,'shadow');
 assert.equal(f.store.shadowEvaluation(f.row,T).trades.length,1);
});
test('stale activity stays separate from performance policy and still expires genuinely silent cells',t=>{
 const f=setup(t);f.cfg.incubator.gate.staleDays=2;f.add(.5,{policyId:f.old.id});
 evaluate(f.store,f.cfg,T);assert.equal(f.store.get(f.row.id)?.stage,'shadow');
 evaluate(f.store,f.cfg,T+3*DAY);assert.equal(f.store.get(f.row.id)?.stage,'retired');
});
test('runtime retirement fails closed without a policy resolver; explicit historical research remains available',t=>{
 const f=setup(t);f.add(-1);f.store.policyFor=undefined;
 assert.equal(f.store.shadowEvaluation(f.row,T).trades.length,0);
 const research=new IncubatorStore(f.db,{evidenceMode:'historical-research'});
 assert.equal(research.shadowEvaluation(f.row,T).trades.length,1);
});
