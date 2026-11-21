import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {applyBar,earlyCutExit} from '../paper/logic.ts';

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

import {fillComparison} from './fillComparison.ts';
import {TapeAudit} from '../execution/tapeAudit.ts';

test('fill comparison reconstructs causal exit depth, keeps missing entry evidence unknown and is read-only',t=>{
 const x=fixture(t);x.enter();x.bar(T+2000);const p=x.e.openPositions()[0];x.tick(T+3000,97);x.settle(T+5000,96.8,97);
 const before=x.db.get<{n:number}>('SELECT total_changes() n')!.n;
 const view=fillComparison(x.db,p.id)!;assert.equal(view.fills.length,2);
 assert.equal(view.fills[0].depth.price,null);assert.equal(view.fills[1].depth.price,96.8);assert.equal(view.fills[1].depth.deltaBps,0);
 assert.equal(view.fills[1].depth.readyAt,T+4500);
 assert.equal(view.fills[1].depth.status,'Recorded exit depth');
 assert.equal(x.db.get<{n:number}>('SELECT total_changes() n')!.n,before);
 const saved=JSON.parse(x.db.get<{depth:string}>('SELECT depth FROM paper_exit_reports')!.depth);
 // The saved consumption offset is authoritative, including earlier account entries.
 saved.consumedQty=3;saved.bids=[{price:100,size:3},{price:96.8,size:1000}];saved.asks=[{price:101,size:1000}];
 x.db.run('UPDATE paper_exit_reports SET depth=?',JSON.stringify(saved));
 assert.equal(fillComparison(x.db,p.id)!.fills[1].depth.price,96.8);
 x.db.run('UPDATE paper_exit_reports SET depth=?',JSON.stringify({receivedAt:T+4000,exchangeAt:T+4000,bids:[{price:90,size:100}],asks:[{price:91,size:100}]}));
 assert.equal(fillComparison(x.db,p.id)!.fills[1].depth.price,null);
 assert.equal(fillComparison(x.db,999),null);
});
test('tape benchmarks exclude late/restart records, compare the correct side, and flag ambiguity',t=>{
 const x=fixture(t);x.enter();x.bar(T+2000);const p=x.e.openPositions()[0];new TapeAudit(x.db,[]);
 const values=[p.entryAt,0,p.id,'SOLUSD','15m','market entry','buy',p.entryPrice,101,100.5,102,4,null,100,null,JSON.stringify({lateSec:30})];
 const sql='INSERT INTO tape_audit(at,book,position_id,symbol,tf,kind,side,paper_price,tape_price,first_print,worst_print,prints,risk_unit,slip_bps,slip_r,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
 x.db.run(sql,...values);assert.equal(fillComparison(x.db,p.id)!.fills[0].tape.deltaBps,null);
 x.db.run('UPDATE tape_audit SET extra=NULL');assert.equal(fillComparison(x.db,p.id)!.fills[0].tape.deltaBps,100);
 x.db.run(sql,...values);assert.equal(fillComparison(x.db,p.id)!.fills[0].tape.status,'Ambiguous tape records');
});
test('maker report comparisons retain executable size and passive-depth limits without claiming queue proof',t=>{
 const x=fixture(t);x.enter();x.bar(T+2000);const p=x.e.openPositions()[0],o=x.db.get<any>('SELECT * FROM orders WHERE position_id=?',p.id)!;
 const evidence={limit:{model:'tick-depth-v1',arrivalAt:T+1500,trigger:{kind:'trade',price:99.9,qty:20},fillDepth:{receivedAt:T+2000}}};
 x.db.run('INSERT INTO paper_maker_reports VALUES(?,?,?,?,?,?,?,?)',o.id,p.id,0,o.at,7,o.qty,'print-key',JSON.stringify(evidence));
 const f=fillComparison(x.db,p.id)!.fills[0];
 assert.match(f.maker!,/7 executable contracts \/ 20 printed at 99.9/);assert.match(f.maker!,/queue position unverified/);
 assert.equal(f.depth.price,null);assert.equal(f.depth.deltaBps,null);assert.equal(f.depth.receivedAt,T+2000);
});
test('entry comparison separates the saved book observation clock from later synchronous evaluation',t=>{
 const x=fixture(t);x.enter();x.bar(T+2000);const p=x.e.openPositions()[0];
 const d={receivedAt:p.entryAt-10,exchangeAt:p.entryAt-15,evaluatedAt:p.entryAt+18,side:'long',requestedQty:p.qty,bids:[{price:99.9,size:100}],asks:[{price:100.05,size:100}]};
 x.db.run('UPDATE entry_fill_evidence SET depth=? WHERE position_id=?',JSON.stringify(d),p.id);
 const f=fillComparison(x.db,p.id)!.fills[0];assert.equal(f.depth.price,100.05);assert.match(f.depth.status,/evaluation 18 ms after recorded fill timestamp/);assert.ok(f.depth.deltaBps!>0);
 d.receivedAt=p.entryAt+1;x.db.run('UPDATE entry_fill_evidence SET depth=? WHERE position_id=?',JSON.stringify(d),p.id);
 assert.equal(fillComparison(x.db,p.id)!.fills[0].depth.price,null,'a book observed after the recorded fill cannot prove it');
});
