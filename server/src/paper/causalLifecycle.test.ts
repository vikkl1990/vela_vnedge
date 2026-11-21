import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {applyBar,earlyCutExit} from './logic.ts';

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

// The audit cases now assert the intended causal behavior.
test('early cut requests an exit but only post-arrival depth can settle it',t=>{
 const x=fixture(t,{earlyCut:{minutes:10,r:-.5}});x.enter();x.bar(T+2000);
 const p=x.e.openPositions()[0],copy=structuredClone(p);
 assert.equal(earlyCutExit(copy,98.9,T+3000,x.cfg.paper)?.reason,'cut');
 x.tick(T+3000,98.9);assert.equal(p.status,'open');assert.equal(x.e.pendingExits()[0].reason,'cut');
 x.settle(T+4000,98.8,99);assert.equal(p.status,'open');
 x.settle(T+5000,98.7,98.8);assert.equal(p.status,'closed');assert.equal(p.exitPrice,98.7);
});
test('stale timeout matches candle evaluator and never fills at a historical close',t=>{
 const x=fixture(t,{staleBars:1,staleMinR:1});x.enter();x.bar(T+2000);
 const p=x.e.openPositions()[0],stamp=T+902001;
 assert.equal(applyBar(structuredClone(p),{time:stamp,open:100,high:100,low:100,close:100},x.cfg.paper)[0]?.reason,'stale');
 x.e.onBar('SOLUSD',{time:T+60000,close:100,low:100,high:100},stamp,{historical:true});assert.equal(x.e.pendingExits().length,0);
 x.tick(stamp,100);assert.equal(p.status,'open');assert.equal(x.e.pendingExits()[0].reason,'stale');
 x.settle(stamp+1600,99.9,100.1);assert.equal(p.exitReason,'stale');assert.equal(p.exitPrice,99.9);
});
test('a settled script target cannot be consumed again, including after restart',t=>{
 const x=fixture(t,{tpSplit:[.5,.25,.25]});x.enter();x.bar(T+2000);let p=x.e.openPositions()[0];
 x.time(T+3000);x.e.commitDecision(()=>x.e.onScriptExit('audit','SOLUSD','15m','tp1',undefined,T+3000,'both'));
 x.settle(T+5000,102,102.1);const after=p.qtyOpen;assert.equal(p.tpHit[0],true);
 x.time(T+5500);x.restart();p=x.e.openPositions()[0];assert.equal(p.tpHit[0],true);
 x.tick(T+6000,102.1,1);assert.equal(p.qtyOpen,after);
 x.e.commitDecision(()=>x.e.onScriptExit('audit','SOLUSD','15m','tp1',undefined,T+6000,'both'));
 assert.equal(x.e.pendingExits().length,0);assert.equal(p.fills.filter(f=>f.reason==='tp1').length,1);
});
test('a stop supersedes an outstanding target without inventing the unfilled portion',t=>{
 const x=fixture(t,{tpSplit:[.5,.25,.25]});x.enter();x.bar(T+2000);const p=x.e.openPositions()[0];
 x.time(T+3000);x.e.commitDecision(()=>x.e.onScriptExit('audit','SOLUSD','15m','tp1',undefined,T+3000,'both'));
 x.tick(T+4000,97);assert.equal(x.e.pendingExits()[0].reason,'sl');assert.equal(p.qtyOpen,p.qty);
 x.settle(T+6000,96.9,97);assert.equal(p.exitReason,'sl');assert.equal(p.fills.filter(f=>f.reason==='tp1').length,0);
});

test('a pending target cannot delay an acknowledged protective stop amendment',t=>{
 const x=fixture(t,{tpSplit:[.5,.25,.25],trailAfterR:.5,trailGiveBackPct:20});x.enter();x.bar(T+2000);const p=x.e.openPositions()[0];
 x.tick(T+3000,101.2);
 const state=x.db.get<{desired_stop:number;ack_at:number}>('SELECT desired_stop,ack_at FROM paper_execution_positions WHERE position_id=?',p.id)!;
 assert.ok(state.desired_stop>100);assert.equal(p.sl,98);
 x.time(T+3100);x.e.commitDecision(()=>x.e.onScriptExit('audit','SOLUSD','15m','tp1',undefined,T+3100,'both'));
 x.tick(state.ack_at+1,100);
 assert.equal(p.sl,state.desired_stop);assert.notEqual(x.e.pendingExits()[0].reason,'tp1');assert.equal(p.qtyOpen,p.qty);
 x.settle(state.ack_at+1600,99.9,100.1);assert.equal(p.status,'closed');
});
