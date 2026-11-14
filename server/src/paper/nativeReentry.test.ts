import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine,PENDING_EXPIRY_MS} from './engine.ts';
import {planSnapshot,planScannerId} from './executionPlans.ts';
import {NATIVE_REENTRY_SCANNERS} from '../scanners/nativeLifecycle.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {extractEvents} from '../scanners/extractor.ts';

const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
const T=1800000000000;
function fixture(t:any,id='synapse-trail-pro-author-native',corrected=true){
 const c=structuredClone(DEFAULT_CONFIG);c.execution.mode='paper';
 Object.assign(c.paper,{sizingMode:'margin',marginPerTrade:150,initialEquity:1000,maxStopLossPct:3,latencyMs:1500,
  fillSource:'candles',useSpread:false,requireQuote:false,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,
  maxSignalAgeSec:300,skipScriptStops:false,liquidation:false,allowReversal:true,reversalMinR:0});
 c.scanners[id]={symbols:null,timeframes:null,...specs[id]};
 const plan={id:'native-reentry',revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000,readingOverride:{version:1}};
 c.executionPlans=[plan];const p=planSnapshot(c,plan,'source');
 if(!corrected){delete p.nativeReentryVersion;if(!['reactive-trail-system-author-native','reaction-level-matrix-author-native'].includes(id))delete p.reversalEntryVersion;}
 const scannerId=planScannerId(p),db=new Db(':memory:');t.after(()=>db.db.close());
 let now=T,e=new PaperEngine(db,()=>c,{book:2,now:()=>now});e.causalExits=true;
 const entry=(side:'long'|'short',at:number,price=100)=>{
  now=at;const s=side==='long'?1:-1;
  return e.onEntry({kind:'entry',side,price,sl:price-s*2,tp:[price+s*2,price+s*4,price+s*6],
   source:'alert',label:side.toUpperCase(),message:'',barTime:T-900000,barIndex:1},
   {scannerId,scannerName:id,symbol:'ETHUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:price,at,
    exitMode:'both',signalId:null,executionPlan:p});
 };
 const tick=(at:number,price=100)=>{now=at;e.onTrade('ETHUSD',price,100000,at,at);
  e.onBar('ETHUSD',{time:Math.floor(at/60000)*60000,high:price,low:price,close:price},at);};
 const settle=(at:number,size=10000,price=100)=>{now=at;e.settleExits('ETHUSD',{receivedAt:at,exchangeAt:at,bids:[{price:price-.01,size}],asks:[{price:price+.01,size}]},at);};
 entry('long',T);tick(T+1500);const held=e.openPositions()[0];assert.ok(held?.qty>2);
 const exit=(type:'sl'|'tp1'|'tp3'|'flip'|'stop_update',at=T+2000)=>{
  now=at;e.onScriptExit(scannerId,'ETHUSD','15m',type,type==='stop_update'?100:undefined,at,'both','long');
 };
 return {c,p,db,entry,tick,settle,exit,held,get e(){return e;},restart:()=>{e=new PaperEngine(db,()=>c,{book:2,now:()=>now});e.causalExits=true;}};
}

for(const id of NATIVE_REENTRY_SCANNERS)test(`${id}: full-close then same-side entry waits; baseline drops it`,t=>{
 const old=fixture(t,id,false),x=fixture(t,id);
 old.exit('sl');x.exit('sl');
 assert.equal(old.entry('long',T+2000).action,'ignored');
 const d=x.entry('long',T+2000);assert.equal(d.action,'pending');
 x.tick(T+3500);assert.equal(x.e.openPositions().length,1);assert.equal(x.e.pendingEntries().length,1);
 x.settle(T+3600,1);assert.equal(x.held.qtyOpen,x.held.qty-1);
 x.tick(T+3700);assert.equal(x.e.pendingEntries().length,1);
 x.settle(T+4000);assert.equal(x.held.status,'closed');
 assert.equal(x.e.openPositions().length,0,'no replacement fabricated by an exit report');
 x.tick(T+4100,100.2);const next=x.e.openPositions()[0];
 assert.equal(next.id,d.pendingId);assert.equal(next.entryAt,T+4100);assert.equal(next.entryPrice,100.2);
 assert.ok(next.riskAmount<=30);assert.ok(next.fees>0&&x.held.fees>0);
 assert.equal(x.db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.equal(x.held.fills.filter(f=>f.reason==='sl').reduce((n,f)=>n+f.qty,0),x.held.qty);
 assert.equal(x.held.fills.some(f=>f.reason==='reversal'),false,'original close owns every exit fill');
});

for(const id of ['structure-anchored-vwap-upstream-2-0','synapse-trail-pro-author-native','liquidity-trail-matrix-author-native'])
test(`${id}: opposite entry without explicit close survives causal reversal latency`,t=>{
 const old=fixture(t,id,false),x=fixture(t,id);
 old.tick(T+2000,100.5);x.tick(T+2000,100.5);
 assert.equal(old.entry('short',T+2100,100.5).action,'pending');
 assert.equal(x.entry('short',T+2100,100.5).action,'pending');
 old.tick(T+3600,100.5);x.tick(T+3600,100.5);
 assert.equal(old.e.pendingEntries().length,0);assert.equal(x.e.pendingEntries().length,1);
 x.settle(T+5200,10000,100.5);x.tick(T+5300,100.4);
 assert.equal(x.e.openPositions()[0].side,'short');assert.equal(x.held.status,'closed');
});

test('native milestones and amendments never authorize pyramiding; TP3 queues a full close',t=>{
 for(const action of ['tp1','stop_update'] as const){
  const x=fixture(t);x.exit(action);assert.equal(x.entry('long',T+2000).action,'ignored');
 }
 const x=fixture(t);x.exit('tp3');assert.equal(x.entry('long',T+2000).action,'pending');
 // Synapse has three thirds: every reduction must settle before a new position.
 for(const at of [T+3500,T+5100,T+6700]){x.settle(at);x.tick(at+10);if(x.held.status==='open')assert.equal(x.e.openPositions()[0].id,x.held.id);}
 assert.equal(x.held.status,'closed');assert.equal(x.e.openPositions().length,1);
 assert.deepEqual(x.held.fills.filter(f=>f.reason.startsWith('tp')).map(f=>f.reason),['tp1','tp2','tp3']);
});

test('native wait preserves expiry, risk veto, changed levels and restart policy',t=>{
 const expired=fixture(t);expired.exit('sl');expired.entry('long',T+2000);
 expired.tick(T+3500+PENDING_EXPIRY_MS+1);
 assert.equal(expired.e.pendingEntries().length,0);assert.equal(expired.held.status,'open');
 const risk=fixture(t);risk.exit('sl');risk.entry('long',T+2000);risk.settle(T+3500);
 risk.e.risk={gate:()=>({reject:'unchanged risk cap',leverageMult:1}),exposureCheck:()=>null};
 risk.tick(T+4000);assert.equal(risk.e.openPositions().length,0);assert.equal(risk.e.pendingEntries().length,0);
 const levels=fixture(t);levels.exit('sl');levels.entry('long',T+2000);levels.settle(T+3500);levels.tick(T+4000,97);
 assert.equal(levels.e.openPositions().length,0);
 const restart=fixture(t);restart.exit('sl');restart.entry('long',T+2000);restart.restart();
 assert.equal(restart.e.pendingEntries().length,0);assert.equal(restart.e.pendingExits().length,1);
 restart.settle(T+3500);restart.tick(T+4000);assert.equal(restart.e.openPositions().length,0);
});

test('re-entry admission failure cannot undo a native close or relax reversal policy',t=>{
 const x=fixture(t);x.exit('sl');
 x.e.risk={gate:()=>({reject:'unchanged admission cap',leverageMult:1}),exposureCheck:()=>null};
 const d=x.entry('long',T+2000);assert.equal(d.action,'rejected');
 assert.match(d.reason!,/existing close retained/);assert.equal(x.e.pendingEntries().length,0);
 x.settle(T+3500);assert.equal(x.held.status,'closed');
 const disabled=fixture(t);disabled.p.paper.allowReversal=false;disabled.exit('sl');
 assert.equal(disabled.entry('short',T+2000).action,'ignored');
 disabled.settle(T+3500);assert.equal(disabled.held.status,'closed');
 const noEntry=fixture(t);noEntry.exit('sl');noEntry.entry('long',T+2000);
 noEntry.c.executionPlans![0].enabled=false;noEntry.tick(T+3500);
 assert.equal(noEntry.e.pendingEntries().length,0);assert.equal(noEntry.e.pendingExits().length,1);
});

test('scanner-specific versions do not alter other plans or risk/configuration settings',()=>{
 const c=structuredClone(DEFAULT_CONFIG),before=JSON.stringify(c);
 for(const id of NATIVE_REENTRY_SCANNERS){
  const cfg=structuredClone(c);cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};
  const d={id:'native-version',revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000};
  const p=planSnapshot(cfg,d);assert.equal(p.nativeReentryVersion,1);assert.equal(p.reversalEntryVersion,1);
  cfg.scanners[id].reader=2;assert.equal(planSnapshot(cfg,d).nativeReentryVersion,undefined);
 }
 assert.equal(JSON.stringify(c),before);
});

test('actual Synapse batch emits old-position management before a new entry',()=>{
 const p={schema:'stp.events.v1',events:[
  {action:'sl',direction:1,entry:100,price:98,sl:98,tp1:102,tp2:104,tp3:106},
  {action:'buy',direction:1,entry:99,price:99,sl:97,tp1:101,tp2:103,tp3:105}
 ]};
 const events=extractEvents([{type:'alert',time:T,barIndex:1,message:JSON.stringify(p)}],[],{scannerId:'synapse-trail-pro-author-native',reader:3});
 assert.deepEqual(events.map(e=>[e.kind,e.side,e.exitType]),[['exit','long','sl'],['entry','long',undefined]]);
});
