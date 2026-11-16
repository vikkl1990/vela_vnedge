import test from 'node:test';
import assert from 'node:assert/strict';
import {App} from '../app.ts';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,type TradePolicy} from '../paper/tradePolicy.ts';

test('learning and live readiness use the same compatible outcomes while preserving thresholds, dates and net returns',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.sizingMode='margin';cfg.paper.maxOpenPositions=8;cfg.risk.maxPositionsTotal=8;
 const paper=new PaperEngine(db,()=>cfg),shadow=new PaperEngine(db,()=>cfg,{book:2});paper.sourceHashFor=()=> 'source';
 const cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'},old=paper.policyForCell(cell);saveTradePolicy(db,old);
 cfg.paper.maxOpenPositions=0;cfg.risk.maxPositionsTotal=0;
 const current=paper.policyForCell(cell);saveTradePolicy(db,current);
 const now=Date.now();let index=0;
 const add=(policy:TradePolicy,pnl:number,days=1,scope='account')=>{
   const entry=now-days*86400000+index++*60000;
   db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt,policy_id,evidence_scope) VALUES('closed','s','s','BTCUSD','1h','long',1,0,1,100,?,?,?,.1,1,0,?,?)",entry,entry+1000,pnl,policy.id,scope);
 };
 for(let i=0;i<12;i++)add(old,i<10?1:-1);
 add(current,1);add(old,-2,31);add(old,100,1,'experiment');
 const margin=cfg.paper.marginPerTrade;cfg.paper.marginPerTrade=75;
 const changed=paper.policyForCell(cell);saveTradePolicy(db,changed);add(changed,100);cfg.paper.marginPerTrade=margin;
 const ctx={db,paper,shadow,featuresOf:()=>null,enricher:{flush:()=>{}},incubatorStore:{counts:()=>({}),list:()=>[]},
   config:{get:()=>cfg},ops:{alerts:{configured:false}},
   equityReturnsPct:App.prototype.equityReturnsPct,realisedRiskPct:App.prototype.realisedRiskPct};
 const before=JSON.stringify({cfg,rows:db.all('SELECT * FROM positions'),policies:db.all('SELECT * FROM trade_policies')});
 const result=App.prototype.learning.call(ctx as unknown as App);
 assert.equal(result.live.trades,16,'the full journal remains visible');
 assert.equal(result.current.trades,14,'compatible learning also retains the older outcome');
 assert.ok(Math.abs(result.current.netUsd-5.6)<1e-10,'fees and the losing trades stay in the result');
 const trades=result.golive.checks.find(c=>c.key==='trades')!;
 assert.equal(trades.value,'13');assert.equal(trades.need,'≥ 200');assert.equal(trades.ok,false);
 assert.equal(result.golive.checks.length,6);assert.equal(result.golive.ok,false);
 assert.match(result.golive.advisories.find(a=>a.key==='capacity-evidence')!.value,/1 exact \+ 12 capacity-compatible trades/);
 assert.ok(result.golive.sim,'compatible records contribute to the unchanged bootstrap');
 assert.equal(JSON.stringify({cfg,rows:db.all('SELECT * FROM positions'),policies:db.all('SELECT * FROM trade_policies')}),before);
});
