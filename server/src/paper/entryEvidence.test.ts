import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {freshMakerPrint} from './makerPricing.ts';
import {EntryDepthGate,wireEntryDepth} from '../risk/entryDepth.ts';
import {depthPlan} from './depthPlan.ts';
import {runBacktest} from './backtest.ts';
import {Journal} from '../analytics/journal.ts';
import {allocationAudit} from '../analytics/allocationAudit.ts';

const T=1_794_410_403_000,cell={scannerId:'s',symbol:'BTCUSD',tf:'15m'};
function setup(t:any,timed=false){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);let now=T;
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,slippageBps:0,quotedSlippageBps:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,
  liquidation:false,latencyMs:0,fillSource:'candles',minRiskFeeRatio:0,skipScriptStops:false,useSpread:true,requireQuote:true,quoteMaxAgeMs:10000,maxSignalAgeSec:0,
  limitEntry:{enabled:true,tfs:['15m'],atr:.1,bars:1,books:['account','shadow']},makerTapeCells:timed?[cell]:undefined});
 cfg.risk.marketGate={...cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 const engine=new PaperEngine(db,()=>cfg,{now:()=>now});
 const quotes={executable:(_s:string,side:string)=>side==='buy'?100:99.99};engine.quotes=quotes;
 const event={kind:'entry' as const,side:'long' as const,price:100,sl:95,tp:[110,115,120],label:'entry',message:'',source:'alert' as const,barTime:T-900000,barIndex:0};
 const ctx={...cell,scannerName:'s',market:{contractValue:1,tickSize:.01},refPrice:100,at:T,atr:1,signalId:null,exitMode:'both' as const};
 const enter=()=>engine.onEntry(event,ctx);
 return {db,cfg,engine,quotes,event,ctx,enter,setNow:(v:number)=>now=v,getNow:()=>now};
}

test('maker observation labels distinguish candle and tape; no retroactive historical reconstruction',t=>{
 for(const tape of [false,true]){
  const f=setup(t);if(tape)f.cfg.paper.fillSource='tape';assert.equal(f.enter().action,'pending');
  if(tape)f.engine.onTrade(cell.symbol,99.8,20,T+1000,T+1080);
  else f.engine.onBar(cell.symbol,{time:T+57000,high:100,low:99.8,close:99.9,volume:20},T+58000);
  const p=f.engine.openPositions()[0];assert.ok(p);const row=f.db.get<any>('SELECT * FROM entry_fill_evidence WHERE position_id=?',p.id);
  assert.equal(row.role,'maker');assert.equal(row.depth,null);assert.equal(row.source,tape?'limit-tape-model':'limit-candle-model');
  assert.equal(JSON.parse(row.limit_observation).placedAt,T);assert.equal(JSON.parse(row.limit_observation).observedAt,p.entryAt);
  assert.equal(JSON.parse(row.limit_observation).trigger.kind,tape?'trade':'candle');
  assert.equal(f.engine.orders()[0].liquidity,'maker');assert.equal(f.engine.orders()[0].priceSource,row.source);
  f.db.run('DELETE FROM entry_fill_evidence');new PaperEngine(f.db,()=>f.cfg,{now:f.getNow});
  assert.equal(f.db.all('SELECT * FROM entry_fill_evidence').length,0);
 }
});

test('exact pricing and admission books persist atomically with actual quantity and independent timestamps',async t=>{
 const f=setup(t);f.cfg.paper.limitEntry=undefined;
 const raw={timestamp:(T-20)*1000,buy:[{price:99.99,size:100}],sell:[{price:100.01,size:2},{price:100.02,size:100}]};
 const gate=new EntryDepthGate({cfg:()=>f.cfg,now:f.getNow,book:async()=>raw});
 const shadow=new PaperEngine(f.db,()=>f.cfg,{book:2,now:f.getNow});wireEntryDepth(f.engine,shadow,gate);await gate.prepare(cell.symbol);
 const d=f.enter();assert.equal(d.action,'opened',d.reason);const p=d.position!;
 const row=f.db.get<any>('SELECT * FROM entry_fill_evidence WHERE position_id=?',p.id),depth=JSON.parse(row.depth),admission=JSON.parse(row.admission_depth);
 assert.equal(row.role,'taker');assert.equal(row.source,'depth');assert.equal(row.order_id,p.fills[0].orderId);
 const journal=new Journal(f.db).detail('paper',p.id);assert.equal(journal.orders[0].liquidity,'taker');
 assert.deepEqual(journal.entryFillEvidence!.depth,depth);assert.deepEqual(journal.entryFillEvidence!.admission_depth,admission);
 const report=allocationAudit(f.db,[],T).execution[0];assert.equal(report.fillEvidence.role,'taker');assert.equal(report.fillEvidence.depth.vwap,depth.vwap);
 assert.equal(report.fillEvidence.admissionDepth.checkedQty,p.qty);
 assert.equal(depth.requestedQty,p.qty);assert.equal(admission.checkedQty,p.qty);assert.equal(depth.exchangeAt,T-20);assert.equal(depth.receivedAt,T);
 const expected=(2*100.01+(p.qty-2)*100.02)/p.qty;assert.ok(Math.abs(p.entryPrice-expected)<1e-10);
 assert.equal(depth.vwap,expected);assert.deepEqual(depth.asks,raw.sell);assert.deepEqual(admission.bids,raw.buy);
 raw.sell[0].price=999;assert.equal(JSON.parse(f.db.get<any>('SELECT depth FROM entry_fill_evidence').depth).asks[0].price,100.01);
 assert.equal(f.cfg.paper.marginPerTrade,150);assert.equal(f.cfg.paper.maxStopLossPct,3);
});

test('maker admission depth is captured without pretending that a limit is a VWAP fill',async t=>{
 const f=setup(t,true);const gate=new EntryDepthGate({cfg:()=>f.cfg,now:f.getNow,book:async()=>({timestamp:f.getNow()*1000,buy:[{price:99.99,size:100}],sell:[{price:100,size:100}]})});
 wireEntryDepth(f.engine,new PaperEngine(f.db,()=>f.cfg,{book:2,now:f.getNow}),gate);await gate.prepare(cell.symbol);assert.equal(f.enter().action,'pending');
 f.setNow(T+200);f.engine.onTrade(cell.symbol,99.8,1,T+100,T+200);
 const row=f.db.get<any>('SELECT * FROM entry_fill_evidence');assert.equal(row.depth,null);assert.equal(row.price,99.9);
 assert.equal(JSON.parse(row.admission_depth).checkedQty,row.qty);assert.equal(JSON.parse(row.limit_observation).eventAt,T+100);
});

test('a failed evidence write rolls back the entry, order and pending deletion; a fresh retry can fill',t=>{
 const f=setup(t,true);f.enter();f.db.run("CREATE TRIGGER fail_evidence BEFORE INSERT ON entry_fill_evidence BEGIN SELECT RAISE(ABORT,'evidence unavailable'); END");
 f.engine.onTrade(cell.symbol,99.8,1,T+100,T+200);assert.equal(f.engine.openPositions().length,0);assert.equal(f.engine.pendingEntries().length,1);
 assert.equal(f.db.all('SELECT * FROM orders').length,0);assert.equal(f.db.all('SELECT * FROM entry_fill_evidence').length,0);
 f.db.run('DROP TRIGGER fail_evidence');f.engine.onTrade(cell.symbol,99.8,1,T+300,T+400);
 assert.equal(f.engine.openPositions().length,1);assert.equal(f.db.all('SELECT * FROM entry_fill_evidence').length,1);
});

test('converged quantity carries its own pricing snapshot, including a conservative reference floor',()=>{
 const snapshot=(qty:number,vwap:number)=>({source:'l2-rest' as const,receivedAt:T,exchangeAt:T-10,evaluatedAt:T,side:'long' as const,requestedQty:qty,vwap,bids:[{price:99,size:100}],asks:[{price:vwap,size:100}]});
 const r=depthPlan({qty:10,riskAmount:20,leverage:2},100,'long',q=>({price:q>8?102:99,depth:snapshot(q,q>8?102:99)}),p=>({qty:p===102?8:9,riskAmount:27,leverage:3}));
 assert.ok('size'in r);assert.equal(r.size.qty,8);assert.equal(r.depth!.requestedQty,8);assert.equal(r.depth!.vwap,99);assert.equal(r.price,100);
});

test('tape timing uses the fresh received print within the placing minute; default policy remains candle based',t=>{
 for(const enabled of [true,false]){
  const f=setup(t,enabled);assert.equal(f.enter().action,'pending');f.engine.onTrade(cell.symbol,99.8,1,T+100,T+200);
  assert.equal(f.engine.openPositions().length,enabled?1:0);
  if(enabled){const p=f.engine.openPositions()[0];assert.equal(p.entryAt,T+200);assert.equal(p.entryPrice,99.9);}
 }
 const f=setup(t,true);f.enter();f.engine.onBar(cell.symbol,{time:T+57000,high:100,low:99,close:99.8,volume:100},T+58000);
 assert.equal(f.engine.openPositions().length,0,'OHLC cannot infer a trade under the tape timing policy');
});

test('tape timing refuses unknown quantity, stale, future, pre-placement and expired prints',()=>{
 assert.equal(freshMakerPrint(1,T+100,T+200,T,T+10000,10000),true);
 for(const [qty,event,observed,from,expiry,maxAge] of [
  [0,T+100,T+200,T,T+10000,10000],[-1,T+100,T+200,T,T+10000,10000],[NaN,T+100,T+200,T,T+10000,10000],
  [1,T-1,T,T,T+10000,10000],[1,T+201,T+200,T,T+10000,10000],[1,T+100,T+1101,T,T+10000,10000],
  [1,T+100,T+10000,T,T+10000,10000],[1,T+100,T+200,T,T+10000,0],
 ])assert.equal(freshMakerPrint(qty,event,observed,from,expiry,maxAge),false);
});

test('restart preserves price and expiry but never fills from downtime or stale tape',t=>{
 const f=setup(t,true);f.enter();const pending=f.engine.pendingEntries()[0];f.setNow(T+5000);
 const restored=new PaperEngine(f.db,()=>f.cfg,{now:f.getNow});restored.quotes=f.quotes;
 assert.equal(restored.pendingEntries()[0].limit!.price,pending.limit!.price);assert.equal(restored.pendingEntries()[0].limit!.expiresAt,pending.limit!.expiresAt);
 restored.onTrade(cell.symbol,99.8,1,T+4500,T+5100);assert.equal(restored.openPositions().length,0);
 restored.onTrade(cell.symbol,99.8,1,T+5200,T+5300);assert.equal(restored.openPositions().length,1);
});

test('tape timing preserves quote, risk and depth vetoes at the actual fill time',t=>{
 for(const veto of ['quote','risk','depth'] as const){
  const f=setup(t,true);f.enter();
  if(veto==='quote')f.engine.quotes={executable:()=>null};
  if(veto==='risk')f.engine.risk={gate:()=>({reject:'risk halt',leverageMult:1}),exposureCheck:()=>null};
  if(veto==='depth')f.engine.entryDepthGate=()=>({reject:'insufficient depth'});
  f.engine.onTrade(cell.symbol,99.8,1,T+100,T+200);assert.equal(f.engine.openPositions().length,0,veto);
 }
});

test('new timing cannot reuse old evidence and does not change unrelated policy identities',t=>{
 const f=setup(t);const before=f.engine.policyForCell(cell).strategyId,other={...cell,scannerId:'other'},untouched=f.engine.policyForCell(other).strategyId;
 f.cfg.paper.makerTapeCells=[cell];assert.notEqual(f.engine.policyForCell(cell).strategyId,before);assert.equal(f.engine.policyForCell(other).strategyId,untouched);
 assert.deepEqual(validateConfig(f.cfg).filter(x=>x.includes('makerTapeCells')),[]);
 f.cfg.paper.makerTapeCells=[cell,cell];assert.ok(validateConfig(f.cfg).some(x=>x.includes('duplicate paper.makerTapeCells')));
});


test('a candle backtest cannot qualify the tape-timed maker policy',t=>{
 const f=setup(t,true);
 assert.throws(()=>runBacktest({...cell,cfg:f.cfg.paper,bars:[]} as any),/recorded trades and depth/);
});

test('pricing snapshot cannot mutate the cached depth used by another order',async t=>{
 const f=setup(t);const gate=new EntryDepthGate({cfg:()=>f.cfg,now:f.getNow,book:async()=>({timestamp:T*1000,buy:[{price:99.99,size:100}],sell:[{price:100,size:100}]})});
 await gate.prepare(cell.symbol);const first=gate.executionPrice(cell.symbol,'long',7);assert.equal(first.price,100);
 first.depth!.asks[0].price=999;assert.equal(gate.executionPrice(cell.symbol,'long',7).price,100);
 f.setNow(T+10001);assert.equal(gate.executionPrice(cell.symbol,'long',7).depth,undefined);
});
