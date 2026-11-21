import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {bookPaperConfig} from './policy.ts';
import {applyBar,earlyCutExit} from './logic.ts';
import {EntryDepthGate,wireEntryDepth} from '../risk/entryDepth.ts';

const T=1800000000000;
function fixture(t:any,overrides:any={}) {
 const cfg=structuredClone(DEFAULT_CONFIG); cfg.execution.mode='paper';
 Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,
  minRiskFeeRatio:0,maxSignalAgeSec:0,minSizeShare:0,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,
  feeRatePct:0,makerFeeRatePct:0,feeTaxPct:0,useSpread:false,requireQuote:false,quoteMaxAgeMs:10000,
  liquidation:false,fillSource:'candles',latencyMs:1500,skipScriptStops:false,allowReversal:true,reversalMinR:0,
  trailAfterR:0,floorAtR:0,trailSteps:[],staleBars:0,earlyCut:undefined,earlyStall:undefined,
  tpSplit:[0,0,1],limitEntry:{enabled:false,tfs:[],atr:0,bars:2,books:[]},...overrides});
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.causalExits=true;
 const enter=(side:'long'|'short'='long',stamp=now)=>{
  now=stamp;
  return engine.commitDecision(()=>engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?98:102,tp:side==='long'?[102,104,106]:[98,96,94],source:'alert',label:side,message:'',barTime:stamp-900000,barIndex:0},
  {scannerId:'audit',scannerName:'audit',symbol:'SOLUSD',tf:'15m',market:{contractValue:1,tickSize:.01},atr:1,refPrice:100,at:now,signalId:null,exitMode:'both'}));
 };
 const bar=(stamp:number,close=100,low=close,high=close,time=Math.floor(stamp/60000)*60000)=>{now=stamp;engine.onBar('SOLUSD',{time,close,low,high,volume:1},now);};
 const tick=(stamp:number,price:number,qty=1)=>{now=stamp;engine.onTrade('SOLUSD',price,qty,stamp,stamp);};
 const settle=(stamp:number,bid=100,ask=100.1)=>{now=stamp;return engine.settleExits('SOLUSD',{receivedAt:stamp,exchangeAt:stamp,bids:[{price:bid,size:1000}],asks:[{price:ask,size:1000}]},stamp);};
 return {cfg,db,enter,bar,tick,settle,get e(){return engine;},time:(stamp:number)=>now=stamp,restart:()=>{engine=new PaperEngine(db,()=>cfg,{now:()=>now});engine.causalExits=true;}};
}

test('account causal reversal waits for full close, then fills the still-valid replacement',t=>{
 const x=fixture(t);x.enter();x.bar(T+2000);const old=x.e.openPositions()[0];
 x.enter('short',T+5000);x.bar(T+7000);
 assert.equal(x.e.pendingEntries().length,1);assert.equal(x.e.pendingExits().length,1);
 x.settle(T+9000);x.bar(T+10000);
 assert.equal(old.status,'closed');assert.equal(old.exitReason,'reversal');
 assert.equal(x.e.openPositions().length,1);assert.equal(x.e.openPositions()[0].side,'short');
 assert.equal(x.e.openPositions()[0].entryAt,T+10000);
});

test('candle maker cannot use a range from before restart, but retains its setup and expiry',t=>{
 const x=fixture(t,{limitEntry:{enabled:true,tfs:['15m'],atr:.1,bars:2,books:['account']}});
 const d=x.enter('long',T+100);assert.equal(d.action,'pending');const before=structuredClone(x.e.pendingEntries()[0]);
 x.time(T+150000);x.restart();assert.equal(x.e.pendingEntries().length,1);
 x.bar(T+151000,100,99.8,100.1,T+120000);assert.equal(x.e.openPositions().length,0);
 assert.deepEqual(x.e.pendingEntries()[0].limit,before.limit);assert.deepEqual(x.e.pendingEntries()[0].reservation,before.reservation);
 x.bar(T+181000,100,99.8,100.1,T+180000);
 assert.equal(x.e.openPositions()[0].entryAt,T+181000);assert.equal(x.e.openPositions()[0].entryPrice,99.9);
});

test('one-contract tape print fills one contract, duplicate cannot fill the remainder',t=>{
 const x=fixture(t,{fillSource:'tape',limitEntry:{enabled:true,tfs:['15m'],atr:.1,bars:2,books:['account']},makerTapeCells:[{scannerId:'audit',symbol:'SOLUSD',tf:'15m'}]});
 x.enter();x.tick(T+2000,99.89,1);const p=x.e.openPositions()[0];assert.equal(p.qty,1);assert.equal(p.qtyOpen,1);
 assert.equal(x.e.pendingEntries().length,1);x.tick(T+2000,99.89,1);assert.equal(p.qty,1);
 x.tick(T+3000,99.89,2);assert.equal(p.qty,3);assert.equal(p.fills.filter(f=>f.reason==='entry').length,2);
 x.time(T+4000);x.restart();assert.equal(x.e.openPositions()[0].qty,3);assert.equal(x.e.pendingEntries().length,1);
 x.e.onTrade('SOLUSD',99.89,100,T+3500,T+4100);assert.equal(x.e.openPositions()[0].qty,3);
 x.tick(T+5000,99.89,100);assert.equal(x.e.openPositions()[0].qty,7);assert.equal(x.e.pendingEntries().length,0);
});

test('entry depth must be received after arrival and never timestamped in the future',async()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.quoteMaxAgeMs=10000;
 cfg.risk.marketGate={...cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 let now=T,exchange=T;const gate=new EntryDepthGate({cfg:()=>cfg,now:()=>now,book:async()=>({timestamp:exchange*1000,buy:[{price:99.9,size:7}],sell:[{price:100,size:7}]})});
 await gate.prepare('SOLUSD');now=T+1600;
 assert.equal(gate.executionPrice('SOLUSD','long',7,T+1500).reject,'depth predates entry arrival');
 await gate.prepare('SOLUSD',true,T+1500);assert.equal(gate.executionPrice('SOLUSD','long',7,T+1500).price,100);
 assert.equal(gate.executionPrice('SOLUSD','long',1,T+1500,7).reject,'observed entry depth already consumed');
 now+=3000;exchange=now+1;await gate.prepare('SOLUSD');assert.equal(gate.executionPrice('SOLUSD','long',1).reject,'fresh execution depth unavailable');
});


test('two account entries cannot reuse the same depth, and a failed fill does not spend it',async t=>{
 const x=fixture(t);x.cfg.risk.marketGate={...x.cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:1,exempt:[]};
 let now=T;const gate=new EntryDepthGate({cfg:()=>x.cfg,now:()=>now,book:async()=>({timestamp:now*1000,buy:[{price:99.99,size:7}],sell:[{price:100,size:7}]})});
 const shadow=new PaperEngine(x.db,()=>x.cfg,{book:2,now:()=>now});wireEntryDepth(x.e,shadow,gate);
 await gate.prepare('SOLUSD');x.enter();
 // Pre-arrival depth must wait, without moving the original deadline.
 now=T+1500;x.bar(now);assert.equal(x.e.openPositions().length,0);assert.equal(x.e.pendingEntries()[0].dueAt,T+1500);
 await gate.prepare('SOLUSD',true,T+1500);
 x.db.run("CREATE TRIGGER abort_entry BEFORE INSERT ON entry_fill_evidence BEGIN SELECT RAISE(ABORT,'test rollback'); END");
 x.bar(T+1600);assert.equal(x.e.openPositions().length,0);assert.equal(x.db.get<any>('SELECT count(*) n FROM paper_exit_liquidity').n,0);
 x.db.run('DROP TRIGGER abort_entry');now=T+1700;x.bar(now);assert.equal(x.e.openPositions()[0].qty,7);
 assert.equal(x.db.get<any>('SELECT consumed FROM paper_exit_liquidity').consumed,7);
 // A second scanner can queue, but must wait for a new depth observation.
 const result=x.e.onEntry({kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],source:'alert',label:'long',message:'',barTime:T-900000,barIndex:0},
 {scannerId:'second',scannerName:'second',symbol:'SOLUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:100,at:T,signalId:null,exitMode:'both'});
 assert.equal(result.action,'pending');x.bar(T+1800);assert.equal(x.e.openPositions().length,1);assert.equal(x.e.pendingEntries().length,1);
 now=T+4000;await gate.prepare('SOLUSD');x.bar(now);assert.equal(x.e.openPositions().length,2);
});

test('candle maker cannot infer a touch before its latency window ends',t=>{
 const x=fixture(t,{limitEntry:{enabled:true,tfs:['15m'],atr:.1,bars:2,books:['account']}});
 x.enter();x.bar(T+500,100,99.8,100.1,T);assert.equal(x.e.openPositions().length,0);
 x.bar(T+61000,100,99.8,100.1,T+60000);assert.equal(x.e.openPositions().length,1);
});

test('account reversal still rechecks expiry and new risk refusal after the held side closes',t=>{
 for(const mode of ['risk','expiry']){
  const x=fixture(t);x.enter();x.bar(T+2000);x.enter('short',T+5000);x.bar(T+7000);x.settle(T+9000);
  if(mode==='risk')x.e.risk={gate:()=>({reject:'unchanged risk cap',leverageMult:1}),exposureCheck:()=>null};
  x.bar(mode==='risk'?T+10000:T+70000);
  assert.equal(x.e.openPositions().length,0);assert.equal(x.e.pendingEntries().length,0);
 }
});

test('ordinary shadow uses executable account-sized depth instead of a top quote or its synthetic purse',async t=>{
 const x=fixture(t);x.cfg.risk.marketGate={...x.cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:1,exempt:[]};
 let now=T;const shadow=new PaperEngine(x.db,()=>({...x.cfg,paper:bookPaperConfig(x.cfg,'shadow')}),{book:2,now:()=>now});shadow.causalExits=true;
 shadow.exitQuantity=()=>7;
 const gate=new EntryDepthGate({cfg:()=>x.cfg,now:()=>now,book:async()=>({timestamp:now*1000,buy:[{price:100.1,size:100}],sell:[{price:100.2,size:100}]})});
 wireEntryDepth(x.e,shadow,gate);await gate.prepare('SOLUSD');x.enter();
 const decision=shadow.onEntry({kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],source:'alert',label:'long',message:'',barTime:T-900000,barIndex:0},
 {scannerId:'audit',scannerName:'audit',symbol:'SOLUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:100,at:T,signalId:null,exitMode:'both'});
 assert.equal(decision.action,'pending');now=T+2000;await gate.prepare('SOLUSD',true,T+1500);x.bar(now);shadow.onBar('SOLUSD',{time:T,high:100,low:100,close:100},now);
 const a=x.e.openPositions()[0],b=shadow.openPositions()[0];assert.equal(a.entryPrice,100.2);assert.equal(b.entryPrice,a.entryPrice);
 assert.ok(b.qty>100,'research purse must not be walked against exchange liquidity');
 const evidence=JSON.parse(x.db.get<any>('SELECT depth FROM entry_fill_evidence WHERE position_id=?',b.id).depth);
 assert.equal(evidence.requestedQty,7);assert.equal(evidence.vwap,100.2);assert.equal(evidence.receivedAt,now);
});
