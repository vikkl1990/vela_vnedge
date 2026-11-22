import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {evaluate,evaluateCooperative} from './cycle.ts';
const T=1800000000000;
function fixture(t:any){
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.gate.pool='pair';
 for(let i=0;i<100;i++)db.run("INSERT INTO incubator_pairs(scanner_id,symbol,tf,stage,since,updated) VALUES(?,?,'15m','shadow',?,?)",`scanner-${i}`,`X${i}USD`,T,T);
 return {db,store,cfg};
}
for(const mode of ['pair','cohort'] as const)test(`cooperative ${mode} review matches synchronous verdicts and journal transitions while servicing timers`,async t=>{
 const a=fixture(t),b=fixture(t);a.cfg.incubator.gate.pool=mode;b.cfg.incubator.gate.pool=mode;
 const expected=evaluate(a.store,a.cfg,T+1000);
 let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
 const opts={unavailable:()=>{const until=performance.now()+.3;while(performance.now()<until){}return null;}};
 const actual=await evaluateCooperative(b.store,b.cfg,T+1000,opts);
 assert.deepEqual(actual,expected);assert.deepEqual(b.store.list(),a.store.list());assert.deepEqual(b.store.events(1000),a.store.events(1000));assert.ok(ticks>1,'quotes/exit timers must run during the review');
});
test('configuration changes abort a cooperative review before another policy decision',async t=>{
 const {store,cfg}=fixture(t);let checks=0;
 await assert.rejects(evaluateCooperative(store,cfg,T+1000,{},()=>++checks<5),/configuration changed/);
 assert.ok(store.list().every(r=>r.stage==='shadow'));
});
