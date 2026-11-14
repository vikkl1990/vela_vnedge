import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine,PENDING_EXPIRY_MS} from './engine.ts';
import {planSnapshot,planScannerId} from './executionPlans.ts';
const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
const T=1800000000000;
function fixture(t:any,corrected=true,fillSource:'tape'|'candles'='tape'){
 const factor=fillSource==='candles'?15:1,stamp=(at:number)=>T+(at-T)*factor;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
 Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,initialEquity:1000,maxStopLossPct:3,latencyMs:100*factor,fillSource,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,requireQuote:false,useSpread:false,skipScriptStops:false,maxSignalAgeSec:0,liquidation:false,allowReversal:true,reversalMinR:0});
 const scanner='reactive-trail-system-author-native';cfg.scanners[scanner]={symbols:null,timeframes:null,...specs[scanner]};
 const plan={id:'reversal-test',revision:1,enabled:true,scannerId:scanner,symbol:'ETHUSD',tf:'15m',variant:'current' as const,referenceEquity:1000,readingOverride:{version:1}};cfg.executionPlans=[plan];
 const snapshot=planSnapshot(cfg,plan,'source');assert.equal(snapshot.reversalEntryVersion,1);if(!corrected)delete snapshot.reversalEntryVersion;
 const id=planScannerId(snapshot),db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 const enter=(side:'long'|'short',at:number)=>{at=stamp(at);now=at;return e.onEntry({kind:'entry',side,price:side==='long'?100:101,sl:side==='long'?98:103,tp:side==='long'?[102,104,106]:[99,97,95],source:'alert',label:side.toUpperCase(),message:'',barTime:at-900000,barIndex:0},{scannerId:id,scannerName:scanner,symbol:'ETHUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:side==='long'?100:101,at:now,signalId:null,exitMode:'both',executionPlan:snapshot});};
 const tick=(at:number,price=101)=>{at=stamp(at);now=at;e.onTrade('ETHUSD',price,1e6,at,at);if(fillSource==='candles')e.onBar('ETHUSD',{time:Math.floor(at/60000)*60000,high:price,low:price,close:price},at);};
 enter('long',T);tick(T+100,100);const p=e.openPositions()[0];assert.ok(p.qty>=2);
 tick(T+150,101);const pending=enter('short',T+200);assert.equal(pending.action,'pending');
 const settle=(at:number,size=1000)=>{at=stamp(at);now=at;return e.settleExits('ETHUSD',{receivedAt:at,exchangeAt:at,bids:[{price:100.9,size}],asks:[{price:101.1,size}]},at);};
 return {get e(){return e;},get p(){return e.position(p.id)!;},db,cfg,id,tick,settle,pendingId:pending.pendingId!,restart:()=>{e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;}};
}
test('legacy cancels a causal reversal; corrected shadow waits for full close before a newly priced entry',t=>{
 const old=fixture(t,false),x=fixture(t);old.tick(T+300);x.tick(T+300);
 assert.equal(old.e.pendingEntries().length,0);assert.equal(x.e.pendingEntries().length,1);
 assert.equal(x.p.status,'open');assert.equal(x.p.fills.length,1);assert.equal(x.e.pendingExits().length,1);
 x.settle(T+400,1);assert.equal(x.p.qtyOpen,x.p.qty-1);
 x.tick(T+450);assert.equal(x.e.pendingEntries().length,1);assert.equal(x.e.openPositions().length,1);
 x.settle(T+500);assert.equal(x.p.status,'closed');assert.equal(x.e.openPositions().length,0);
 x.tick(T+600,100.8);const replacement=x.e.openPositions()[0];
 assert.equal(replacement.side,'short');assert.equal(replacement.entryPrice,100.8);assert.equal(replacement.id,x.pendingId);
 assert.equal(replacement.entryAt,T+600);assert.ok(replacement.riskAmount<=30);assert.ok(replacement.fees>0&&x.p.fees>0);
 assert.equal(x.e.pendingEntries().length,0);assert.equal(x.e.pendingExits().length,0);
});
test('waiting reversal keeps its original expiry and cannot reuse a late or invalidated entry',t=>{
 const expired=fixture(t);expired.tick(T+300);expired.settle(T+400);
 expired.tick(T+300+PENDING_EXPIRY_MS+1);assert.equal(expired.e.openPositions().length,0);assert.equal(expired.e.pendingEntries().length,0);
 const moved=fixture(t);moved.tick(T+300);moved.settle(T+400);moved.tick(T+500,104);
 assert.equal(moved.e.openPositions().length,0);assert.equal(moved.e.pendingEntries().length,0);
 const risk=fixture(t);risk.tick(T+300);risk.settle(T+400);
 risk.e.risk={gate:()=>({reject:'test risk cap',leverageMult:1}),exposureCheck:()=>null};risk.tick(T+500);
 assert.equal(risk.e.openPositions().length,0);assert.equal(risk.e.pendingEntries().length,0);
});
test('restart cancels an unfilled reversal but preserves the protective exit; no downtime entry is invented',t=>{
 const x=fixture(t);x.tick(T+300);x.restart();
 assert.equal(x.e.pendingEntries().length,0);assert.equal(x.p.status,'open');assert.equal(x.e.pendingExits().length,1);
 x.settle(T+400);x.tick(T+500);assert.equal(x.p.status,'closed');assert.equal(x.e.openPositions().length,0);
 assert.equal(x.db.get<any>("SELECT count(*) n FROM orders WHERE reason='entry'")!.n,1);
});


test('the VM candle-entry mode and 1500ms latency also wait for a causal reversal close',t=>{
 const old=fixture(t,false,'candles'),x=fixture(t,true,'candles');
 old.tick(T+300);x.tick(T+300);
 assert.equal(old.e.pendingEntries().length,0);assert.equal(x.e.pendingEntries().length,1);
 assert.equal(x.p.status,'open');assert.equal(x.e.pendingExits()[0].ready_at,T+6000);
 x.settle(T+400);assert.equal(x.p.status,'closed');x.tick(T+500,100.8);
 assert.equal(x.e.openPositions().length,1);assert.equal(x.e.openPositions()[0].side,'short');
 assert.equal(x.e.openPositions()[0].entryAt,T+7500);assert.equal(x.cfg.paper.fillSource,'candles');assert.equal(x.cfg.paper.latencyMs,1500);
});
