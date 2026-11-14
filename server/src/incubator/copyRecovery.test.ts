import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {copyRecoveryRefusal} from './copyRecovery.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {bookPaperConfig} from '../paper/policy.ts';

test('copy recovery uses current exact-policy evidence, turnover and stage without changing thresholds',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.skipScriptStops=false;
 const cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'},at=Date.now();
 const mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:2e6};
 const policy=resolveTradePolicy(cfg,cell,'v1'),shadow=resolveTradePolicy({...cfg,paper:bookPaperConfig(cfg,'shadow')},cell,'v1',2);
 saveTradePolicy(db,shadow);store.policyFor=()=>policy;
 db.run("INSERT INTO incubator_pairs(scanner_id,symbol,tf,stage,since,updated) VALUES('s','BTCUSD','1h','shadow',?,?)",at-86400000,at);
 db.kvSet('risk.marketsToday',{enabled:true,at,markets:[{symbol:'BTCUSD',allowed:true,turnoverUsd:3e6,reasons:[]}]});
 const add=(n:number,pnl=1)=>db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt,policy_id) VALUES('closed','s','s','BTCUSD','1h','long',1,0,1,100,?,?,?,0,1,2,?)",at-20000+n*100,at-19000+n*100,pnl,shadow.id);
 for(let n=0;n<4;n++)add(n);
 assert.match(copyRecoveryRefusal(store,mirror,cell,at)!,/4\/5/);
 add(4);assert.equal(copyRecoveryRefusal(store,mirror,cell,at),null);
 add(5,-6);assert.match(copyRecoveryRefusal(store,mirror,cell,at)!,/need > 0R/);
 db.run('DELETE FROM positions WHERE realized_pnl<0');
 db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','bad fill','test',?)",1,at-20000,at);
 assert.match(copyRecoveryRefusal(store,mirror,cell,at)!,/4\/5/);
 db.run('DELETE FROM evidence_flags');
 store.policyFor=()=>resolveTradePolicy(cfg,cell,'v2');
 assert.match(copyRecoveryRefusal(store,mirror,cell,at)!,/0\/5/);
 store.policyFor=()=>policy;
 db.kvSet('risk.marketsToday',{enabled:true,at,markets:[{symbol:'BTCUSD',allowed:true,turnoverUsd:1e6,reasons:[]}]});
 assert.match(copyRecoveryRefusal(store,mirror,cell,at)!,/thin market/);
 for(const stage of ['retired','tracked','candidate']){
  db.run('UPDATE incubator_pairs SET stage=?',stage);
  assert.equal(copyRecoveryRefusal(store,mirror,cell,at),'copy allocation no longer admitted');
 }
 assert.equal(copyRecoveryRefusal(store,{...mirror,enabled:false},cell,at),'copy pilot disabled');
 assert.equal(db.get<any>('SELECT count(*) n FROM evidence_restorations').n,0,'recovery cannot enroll evidence');
});
