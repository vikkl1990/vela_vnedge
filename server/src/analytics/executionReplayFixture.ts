import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {saveTradePolicy,tradePolicyIdFor} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';
import {replayReadinessExecution,type ExecutionReplayEvent} from './readinessExecutionReplay.ts';
export const T=1800000060000;
export function fixture(t:any,kind:'loss'|'winner'|'changed'|'candle'='loss',side:'long'|'short'='long',book:0|2=0){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,minRiskFeeRatio:0,maxSignalAgeSec:0,minSizeShare:0,
  slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,useSpread:false,requireQuote:false,
  liquidation:false,fillSource:'candles',latencyMs:1500,skipScriptStops:false,allowReversal:true,
  trailAfterR:.5,floorAtR:0,trailGiveBackPct:20,trailSteps:[],trailStall:undefined,trailAtrMult:0,staleBars:0,earlyCut:undefined,earlyStall:undefined,
  tpSplit:[0,0,1],limitEntry:{enabled:false,tfs:[],atr:0,bars:2,books:[]}});
 let now=T-2000;const engine=new PaperEngine(db,()=>cfg,{book,now:()=>now});engine.sourceHashFor=()=> 'source';engine.causalExits=true;
 engine.onEntry({kind:'entry',side,price:100,sl:side==='long'?98:102,tp:side==='long'?[104,108,112]:[96,92,88],source:'alert',label:side,message:'',barTime:T-900000,barIndex:0},
  {scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{contractValue:1,tickSize:.01},atr:1,refPrice:100,at:now,signalId:null,exitMode:'both'});
 const events:ExecutionReplayEvent[]=[];let sequence=0;
 const tick=(at:number,price:number)=>{now=at;price=side==='long'?price:200-price;const payload={price,qty:1000,timeMs:at,id:String(at)};events.push({version:1,receivedAt:at,archiveSequence:++sequence,symbol:'BTCUSD',kind:'trade',source:'execution-feed',payload});engine.onTrade('BTCUSD',price,1000,at,at,String(at));};
 tick(T-1000,100);now=T;engine.onBar('BTCUSD',{time:T,close:100,low:100,high:100,volume:100},now);
 const p=engine.openPositions()[0];assert.ok(p,'fixture entered');
 const current=structuredClone(p.policy!),previous=structuredClone(current);previous.sim=211;previous.strategyId=strategyIdFor(previous);previous.id=tradePolicyIdFor(previous);
 saveTradePolicy(db,previous);p.policy=previous;db.run('UPDATE positions SET policy_id=? WHERE id=?',previous.id,p.id);db.run('UPDATE paper_execution_positions SET version=211 WHERE position_id=?',p.id);
 now=T+100;const bar={time:T,close:100,low:100,high:100,volume:100};events.push({version:1,receivedAt:now,archiveSequence:++sequence,symbol:p.symbol,kind:'paper_bar',source:'paper-input',payload:{book,bar,historical:false}});engine.onBar(p.symbol,bar,now);
 if(kind==='candle'){
  now=T+120000;const candle={time:T+60000,open:100,high:100,low:97,close:100,volume:100};
  events.push({version:1,receivedAt:now,archiveSequence:++sequence,symbol:p.symbol,kind:'paper_bar',source:'paper-input',payload:{book,bar:candle,historical:false}});
  engine.onBar(p.symbol,candle,now);assert.equal(p.status,'open');tick(T+121000,97.9);
 }else if(kind==='loss')tick(T+3000,97.9);
 else{
  tick(T+1000,101.2);
  if(kind==='changed')tick(T+1200,101.8);
  tick(T+3000,kind==='changed'?101.2:100.9);
  if(kind==='changed')tick(T+4000,100.9);
 }
 now=kind==='candle'?T+124000:T+6000;const bid=['loss','candle'].includes(kind)?97.8:100.8,ask=bid+.1;
 engine.settleExits(p.symbol,{receivedAt:now,exchangeAt:now-10,bids:[{price:side==='long'?bid:200-ask,size:10000}],asks:[{price:side==='long'?ask:200-bid,size:10000}]},now);
 assert.equal(p.status,'closed');
 const coverage={from:T-60000,to:now,segments:1,verified:true,sha256:'a'.repeat(64)};
 return {db,engine,p,previous,current,events,coverage,run:()=>replayReadinessExecution(db,p.id,previous,current,events,coverage)};
}
