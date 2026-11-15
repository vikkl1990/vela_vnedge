import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,resolveTradePolicy,tradePolicyIdFor,type TradePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {sizeContracts,feeFor} from '../paper/logic.ts';
import {additionalReadinessCompatibility} from './readinessCompatibility.ts';
import {proveSameReadinessSize} from './readinessSizing.ts';
import {currentPolicyEvidence,policyHealth} from './policyHealth.ts';

function fixture(t:{after:(f:()=>void)=>void},stop=90,scale=1){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,maxLeverage:50,minLeverage:5,maxStopLossPct:3,depthUsdPerBp:0,latencyMs:1500,useSpread:true,quoteMaxAgeMs:10000,maxOpenPositions:8,
   limitEntry:{...cfg.paper.limitEntry,enabled:false},marginLeverage:{base:5,strong:10,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05}});
 Object.assign(cfg.risk,{enabled:true,ddFrom:'capital',ddScale:[{ddPct:0,leverageMult:.5}],maxPositionsTotal:8});
 const cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'},old=resolveTradePolicy(cfg,cell,'source');saveTradePolicy(db,old);
 cfg.paper.maxOpenPositions=0;cfg.risk.maxPositionsTotal=0;cfg.risk.ddScale=[];
 const current=resolveTradePolicy(cfg,cell,'source');saveTradePolicy(db,current);
 const now=Date.now()-5000,market={contractValue:1,tickSize:.01,maxLeverage:20,maintenanceMarginPct:2.5};
 const oldSizing={...old.sizing,marginPerTrade:75,maxLeverage:25,minLeverage:2.5,riskPerTradePct:old.sizing.riskPerTradePct*.5};
 const size=sizeContracts(100,stop,{equity:950,availableMargin:Infinity,...market,cfg:oldSizing,wantedLeverage:5,entryExecution:{quoted:true},sizeScale:scale});
 assert.ok(size.qty>0);const fee=feeFor(100,size.qty,1,old.paper);
 const fills={fills:[{at:now,price:100,qty:size.qty,reason:'entry',fee,pnl:0,liquidity:'taker',orderId:10},{at:now+1000,price:99,qty:size.qty,reason:'sl',fee:.1,pnl:-size.qty,liquidity:'taker'}],leverage:size.leverage,marginLeverage:size.marginLeverage,maintenanceMarginPct:2.5};
 db.run("INSERT INTO positions(id,status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,sl_original,entry_at,exit_at,realized_pnl,fees,risk_amount,bt,policy_id,evidence_scope,config_fp,fills) VALUES(1,'closed','s','s','BTCUSD','15m','long',?,0,1,100,?,?,?,-2,?,?,0,?,'account','fp',?)",size.qty,stop,now,now+1000,fee+.1,size.riskAmount,old.id,JSON.stringify(fills));
 db.run("INSERT INTO orders(id,at,position_id,scanner_id,symbol,side,qty,price,fee,reason,bt,bid,ask,quote_at,price_source) VALUES(10,?,1,'s','BTCUSD','buy',?,100,?,'entry',0,99.9,100,?,'depth')",now,size.qty,fee,now-10);
 const depth={source:'l2-rest',receivedAt:now-20,exchangeAt:now-30,evaluatedAt:now+5,side:'long',requestedQty:size.qty,vwap:100,bids:[{price:99.9,size:100}],asks:[{price:100,size:100}]};
 const engine=new PaperEngine(db,()=>cfg);engine.sourceHashFor=()=> 'source';
 db.run("INSERT INTO entry_fill_evidence VALUES(1,10,0,?,'taker','depth',?,100,100,?,NULL,NULL)",now,size.qty,JSON.stringify(depth));
 const admission={version:3,policyId:old.id,configFp:'fp',sourceHash:'source',side:'long',signalAt:now-1500,market,sizeScale:scale,quote:{bestAsk:100,bestBid:99.9,quoteAt:now-1510}};
 db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage,snapshot) VALUES(?,0,1,'s','BTCUSD','15m','pending',?)",now-1490,JSON.stringify(admission));
 return {db,cfg,old,current,engine,depth,admission,fills,size,now};
}

test('identical stop-capped size qualifies without scaling profits, including losing trades',t=>{
 const f=fixture(t),before=JSON.stringify(f.db.all('SELECT * FROM positions'));
 assert.equal(additionalReadinessCompatibility(f.old,f.current),'sizing-proof');
 assert.deepEqual(proveSameReadinessSize(f.db,1,f.old,f.current),{ok:true,equity:950,qty:f.size.qty,risk:f.size.riskAmount});
 const result=currentPolicyEvidence(f.db,f.engine);assert.deepEqual([...result.sizingCompatibleIds],[1]);assert.equal(result.capacityCompatibleIds.size,0);
 assert.equal(JSON.stringify(f.db.all('SELECT * FROM positions')),before);
 const health=policyHealth(f.db,f.engine,new PaperEngine(f.db,()=>f.cfg,{book:2}));assert.equal(health.books[0].sizingCompatible,1);
 f.db.run('UPDATE positions SET realized_pnl=2 WHERE id=1');assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,true,'profit sign cannot select evidence');
});
test('reduced margin cannot qualify when current settings would request more contracts',t=>{
 const f=fixture(t,99);assert.deepEqual(proveSameReadinessSize(f.db,1,f.old,f.current),{ok:false,reason:'different-size'});
 assert.equal(currentPolicyEvidence(f.db,f.engine).ids.size,0);
});
test('saved pilot fraction participates in replay instead of assuming a full allocation',t=>{
 const f=fixture(t,90,.5);assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,true);
 f.admission.sizeScale=1;f.db.run("UPDATE decision_trace SET snapshot=? WHERE stage='pending'",JSON.stringify(f.admission));
 assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,false);
});
test('depth replay reproduces the worse of executable quote and VWAP',t=>{
 const f=fixture(t);f.depth.vwap=99.8;f.depth.asks=[{price:99.8,size:100}];
 f.db.run('UPDATE entry_fill_evidence SET depth=?',JSON.stringify(f.depth));
 assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,true);
 f.depth.vwap=100.2;f.depth.asks=[{price:100.2,size:100}];f.db.run('UPDATE entry_fill_evidence SET depth=?',JSON.stringify(f.depth));
 assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,false,'a better-than-depth fill cannot establish parity');
});
const corruptions:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 'missing depth':f=>{f.db.run('DELETE FROM entry_fill_evidence');},
 'future depth':f=>{f.depth.receivedAt+=500;f.depth.evaluatedAt+=600;f.db.run('UPDATE entry_fill_evidence SET depth=?',JSON.stringify(f.depth));},
 'wrong order':f=>{f.db.run('UPDATE entry_fill_evidence SET order_id=20');},
 'stale quote':f=>{f.db.run('UPDATE orders SET quote_at=1');},
 'undercharged fee':f=>{f.db.run('UPDATE orders SET fee=0');},
 'reused position id':f=>{f.db.run('UPDATE orders SET at=at-100000');},
 'unknown pilot fraction':f=>{delete (f.admission as Partial<typeof f.admission>).sizeScale;f.db.run('UPDATE decision_trace SET snapshot=?',JSON.stringify(f.admission));},
 'partial entry':f=>{f.fills.fills[0].qty-=.5;f.db.run('UPDATE positions SET fills=?',JSON.stringify(f.fills));},
 'different risk':f=>{f.db.run('UPDATE positions SET risk_amount=risk_amount+1');},
 'portfolio leverage cap changes':f=>{f.admission.market.maxLeverage=100;f.db.run('UPDATE decision_trace SET snapshot=?',JSON.stringify(f.admission));},
 'experiment scope':f=>{f.db.run("UPDATE positions SET evidence_scope='experiment'");},
};
for(const [name,change]of Object.entries(corruptions))test(`readiness replay refuses ${name}`,t=>{
 const f=fixture(t);change(f);assert.equal(proveSameReadinessSize(f.db,1,f.old,f.current).ok,false);
 assert.equal(currentPolicyEvidence(f.db,f.engine).ids.size,0);
});
test('scope normalization ignores other cells but keeps this cell and execution/risk/fee changes exact',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG),cell={scannerId:'s',symbol:'BTCUSD',tf:'1h'};
 const old=resolveTradePolicy(cfg,cell,'source');cfg.paper.makerQuoteCells=[{scannerId:'other',symbol:'SOLUSD',tf:'15m'}];
 const current=resolveTradePolicy(cfg,cell,'source');assert.equal(additionalReadinessCompatibility(old,current),'scope');
 cfg.paper.makerQuoteCells.push(cell);assert.equal(additionalReadinessCompatibility(old,resolveTradePolicy(cfg,cell,'source')),null);
 for(const change of [(p:TradePolicy)=>{p.paper.feeRatePct+=.01;},(p:TradePolicy)=>{p.sizing.marginPerTrade=75;},(p:TradePolicy)=>{p.risk.maxDailyLossPct++;},(p:TradePolicy)=>{p.sim++;}]){
   const p=structuredClone(current);change(p);p.strategyId=strategyIdFor(p);p.id=tradePolicyIdFor(p);assert.equal(additionalReadinessCompatibility(old,p),null);
 }
});
test('stop-capped replay has identical sizing across equity, wallet availability and adverse depth prices',t=>{
 const f=fixture(t),old={...f.old.sizing,marginPerTrade:75,maxLeverage:25,minLeverage:2.5,riskPerTradePct:f.old.sizing.riskPerTradePct*.5};
 for(let equity=100;equity<=1000;equity+=50)for(const price of [100,101,105,110])for(const availableMargin of [0,25,1000])for(const openNotional of [0,1000])for(const wantedLeverage of [5,10]){
   const inputs={equity,availableMargin,contractValue:1,tickSize:.01,maintenanceMarginPct:2.5,maxLeverage:20,wantedLeverage,entryExecution:{quoted:true}};
   assert.deepEqual(sizeContracts(price,90,{...inputs,cfg:old},openNotional),sizeContracts(price,90,{...inputs,cfg:f.current.sizing},openNotional));
 }
});
