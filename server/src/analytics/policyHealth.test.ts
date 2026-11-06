import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {currentPolicyIds} from './policyHealth.ts';
test('account readiness matches capital, risk and ML policy as well as strategy',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'};
 const old=resolveTradePolicy(cfg,cell,'source');cfg.paper.marginPerTrade=75;const current=resolveTradePolicy(cfg,cell,'source');
 assert.equal(old.strategyId,current.strategyId);assert.notEqual(old.id,current.id);
 for(const [p,book,at]of [[old,0,1000],[current,0,2000],[old,2,3000]] as const){
  saveTradePolicy(db,p);
  db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt,policy_id) VALUES('closed','s','s','BTCUSD','1h','long',1,0,1,100,?,?,2,0,1,?,?)",at,at+100,book,p.id);
 }
 const engine={policyForCell:()=>current} as any;
 assert.equal(currentPolicyIds(db,engine).size,1);
 assert.equal(currentPolicyIds(db,engine,2).size,1,'shadow strategy evidence is separate from the account purse');
 assert.equal(currentPolicyIds(db,engine,0,3000).size,0);
});
