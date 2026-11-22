import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {currentPolicyIds,currentPolicyEvidence,policyHealth} from './policyHealth.ts';
import {PaperEngine} from '../paper/engine.ts';
import {qualifiedEvidence} from '../evidence/trades.ts';
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

for(const cap of ['global','market'])test(`${cap} capacity-compatible readiness retains winners and losers without admitting excluded evidence or altering promotion`,t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.paper.maxOpenPositions=8;cfg.risk.maxPositionsTotal=8;
 const paper=new PaperEngine(db,()=>cfg);paper.sourceHashFor=()=> 'source';
 const cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'},old=paper.policyForCell(cell);saveTradePolicy(db,old);
 if(cap==='global'){cfg.paper.maxOpenPositions=0;cfg.risk.maxPositionsTotal=0;}else cfg.risk.maxPositionsPerSymbol=0;
 const current=paper.policyForCell(cell);saveTradePolicy(db,current);
 let at=1000;
 const add=(extra:Record<string,unknown>={})=>{
   const row={status:'closed',scanner_id:'s',scanner_name:'s',symbol:'BTCUSD',tf:'1h',side:'long',qty:1,qty_open:0,
     contract_value:1,entry_price:100,entry_at:at++,exit_at:at++,risk_amount:1,realized_pnl:2,fees:.1,bt:0,
     levels_source:'atr-fallback',evidence_scope:'account',policy_id:old.id,...extra};
   return Number(db.run(`INSERT INTO positions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);
 };
 const win=add(),loss=add({realized_pnl:-1}),exact=add({policy_id:current.id});
 const shadowId=add({bt:2,evidence_scope:'shadow'});
 for(const scope of ['experiment','tracker','legacy-tracker'])add({evidence_scope:scope});
 add({scanner_id:'plan:s'});add({bt:1});add({policy_id:null});add({policy_adopted_at:1});add({status:'open'});
 add({risk_amount:0});add({realized_pnl:Infinity});add({entry_at:2000,exit_at:1000});
 const flagged=add();db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','bad fill','test',3000)",flagged,at-2);
 const corrupt={...old,id:'bad-snapshot'};saveTradePolicy(db,corrupt);add({policy_id:corrupt.id});
 db.run("UPDATE trade_policies SET snapshot='{' WHERE id=?",corrupt.id);
 const before={positions:db.all('SELECT * FROM positions'),policies:db.all('SELECT * FROM trade_policies'),cfg:structuredClone(cfg)};
 const promotionBefore=qualifiedEvidence(db,cell,current,{book:2,at:3000});
 assert.deepEqual(promotionBefore.map(r=>r.positionId),[shadowId]);
 const selection=currentPolicyEvidence(db,paper);
 assert.deepEqual([...selection.ids],[win,loss,exact]);
 assert.deepEqual([...selection.exactIds],[exact]);assert.deepEqual([...selection.capacityCompatibleIds],[win,loss]);
 assert.equal(currentPolicyIds(db,paper,0,2000).size,0,'the evaluation window still applies');
 const summary=policyHealth(db,paper,new PaperEngine(db,()=>cfg,{book:2}),3000);
 assert.equal(summary.books[0].matching,3);assert.equal(summary.books[0].capacityCompatible,2);
 assert.equal(summary.books[0].quarantined,1);
 assert.deepEqual(qualifiedEvidence(db,cell,current,{book:2,at:3000}),promotionBefore);
 assert.deepEqual({positions:db.all('SELECT * FROM positions'),policies:db.all('SELECT * FROM trade_policies'),cfg},before);
});
