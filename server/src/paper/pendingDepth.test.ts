import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {EntryDepthGate,wireEntryDepth} from '../risk/entryDepth.ts';
import type {ScanEvent} from '../scanners/extractor.ts';

function fixture(t:any,limit=true,book=0){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 let now=1794846601000;
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:0,slippageBps:0,skipScriptStops:false,requireQuote:false,useSpread:false,
  minRiskFeeRatio:0,maxSignalAgeSec:0,sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,quoteMaxAgeMs:10000,
  limitEntry:{enabled:limit,atr:.1,bars:2,tfs:['1m'],books:['account','shadow']}});
 cfg.risk.marketGate={...cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 const account=new PaperEngine(db,()=>cfg,{now:()=>now}),shadow=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});
 let spread=.02;
 const gate=new EntryDepthGate({cfg:()=>cfg,now:()=>now,book:async()=>({timestamp:now*1000,
  buy:[{price:100-spread/2,size:1e6}],sell:[{price:100+spread/2,size:1e6}]})});
 wireEntryDepth(account,shadow,gate);const engine=book===2?shadow:account;
 const ev:ScanEvent={kind:'entry',side:'long',price:100,sl:95,tp:[110,120,130],label:'Long',message:'',source:'alert',barTime:now-60000,barIndex:1};
 const ctx={scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1m',market:{tickSize:.01,contractValue:1},at:now,refPrice:100,atr:10,signalId:null,exitMode:'both' as const};
 const tick=(price=98,at=now)=>engine.onTrade('BTCUSD',price,100,at,now);
 return {db,cfg,engine,gate,ev,ctx,tick,now:()=>now,advance:(ms:number)=>{now+=ms;},wide:()=>{spread=2;}};
}

for(const book of [0,2])test(`accepted maker waits for fresh depth, never reuses its failed touch, book ${book}`,async t=>{
 const x=fixture(t,true,book);await x.engine.prepareEntryDepth!('BTCUSD');
 assert.equal(x.engine.onEntry(x.ev,x.ctx).action,'pending');
 const original=structuredClone(x.engine.pendingEntries()[0]);
 x.advance(11000);x.tick();
 assert.equal(x.engine.pendingEntries().length,1,'stale observation must not cancel an accepted order');
 assert.equal(x.engine.openPositions().length,0);
 const waiting=structuredClone(x.engine.pendingEntries()[0]);
 assert.equal(waiting.at,original.at);assert.deepEqual(waiting.limit,original.limit);
 assert.deepEqual(waiting.reservation,original.reservation);assert.deepEqual(waiting.policy,original.policy);
 await x.engine.prepareEntryDepth!('BTCUSD');
 assert.equal(x.engine.openPositions().length,0,'refreshing depth cannot replay the earlier touch');
 x.tick();assert.equal(x.engine.openPositions().length,0,'a duplicate print cannot fill');
 x.advance(1);x.tick(101);assert.equal(x.engine.openPositions().length,0,'price must cross again');
 x.advance(1);x.tick();
 const p=x.engine.openPositions()[0];assert.ok(p);assert.equal(p.entryAt,x.now());assert.equal(p.entryPrice,original.limit!.price);
 assert.ok(p.qty<=original.reservation!.qty);assert.ok(p.riskAmount<=x.cfg.paper.initialEquity*.03);
 assert.equal(x.engine.pendingEntries().length,0);
 assert.equal(x.db.get<any>("SELECT count(*) n FROM orders WHERE reason='entry'").n,1);
});

test('market order also waits for fresh execution depth within the original deadline',async t=>{
 const x=fixture(t,false);await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
 const due=x.engine.pendingEntries()[0].dueAt;x.advance(11000);x.tick(100);
 assert.equal(x.engine.pendingEntries().length,1);await x.engine.prepareEntryDepth!('BTCUSD');
 x.advance(1);x.tick(100);assert.equal(x.engine.openPositions().length,1);
 assert.equal(x.engine.openPositions()[0].entryPrice,100.01);assert.equal(due,x.ctx.at);
});

for(const limit of [true,false])test(`depth wait cannot extend ${limit?'maker':'market'} expiry`,async t=>{
 const x=fixture(t,limit);await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
 x.advance(11000);x.tick();assert.equal(x.engine.pendingEntries().length,1);
 x.advance(120001);await x.engine.prepareEntryDepth!('BTCUSD');x.tick();
 assert.equal(x.engine.openPositions().length,0);assert.equal(x.engine.pendingEntries().length,0);
});

test('refreshed depth must still pass cost and risk checks',async t=>{
 for(const reason of ['cost','risk']){
  const x=fixture(t);await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
  x.advance(11000);x.tick();assert.equal(x.engine.pendingEntries().length,1);
  if(reason==='cost')x.wide();else x.engine.risk={gate:()=>({reject:'daily loss limit',leverageMult:1}),exposureCheck:()=>null};
  await x.engine.prepareEntryDepth!('BTCUSD');x.advance(1);x.tick();
  assert.equal(x.engine.openPositions().length,0);assert.equal(x.engine.pendingEntries().length,0);
 }
});

test('a candle spanning the failed observation cannot later fill a waiting maker',async t=>{
 const x=fixture(t);x.cfg.paper.fillSource='candles';await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
 x.advance(60000);const bar={time:x.ctx.at+59999,open:100,high:101,low:98,close:100,volume:100};
 x.engine.onBar('BTCUSD',bar,x.now());assert.equal(x.engine.pendingEntries().length,1);
 await x.engine.prepareEntryDepth!('BTCUSD');x.advance(1);x.engine.onBar('BTCUSD',bar,x.now());
 assert.equal(x.engine.openPositions().length,0,'the old candle low is not a new touch');
});

test('the observation boundary survives a restart without changing the resting order',async t=>{
 const x=fixture(t);await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
 x.advance(11000);x.tick();const waiting=structuredClone(x.engine.pendingEntries()[0]);
 const restored=new PaperEngine(x.db,()=>x.cfg,{now:x.now});
 assert.deepEqual(restored.pendingEntries()[0],JSON.parse(JSON.stringify(waiting)));
 restored.entryDepthGate=()=>({});
 restored.onTrade('BTCUSD',98,100,x.now(),x.now());assert.equal(restored.openPositions().length,0);
 x.advance(1);restored.onTrade('BTCUSD',98,100,x.now(),x.now());
 assert.equal(restored.openPositions()[0].id,waiting.id);
 assert.equal(restored.openPositions()[0].entryAt,x.now());
});

test('waiting creates no fills, fees or promotion evidence; recovered fill matches healthy execution',async t=>{
 const healthy=fixture(t),waiting=fixture(t);
 for(const x of [healthy,waiting]){await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);x.advance(11000);}
 waiting.tick();
 assert.equal(waiting.db.get<any>('SELECT count(*) n FROM orders').n,0);
 assert.equal(waiting.db.get<any>('SELECT count(*) n FROM entry_fill_evidence').n,0);
 assert.equal(waiting.db.get<any>("SELECT count(*) n FROM positions WHERE status='closed'").n,0);
 for(const x of [healthy,waiting]){await x.engine.prepareEntryDepth!('BTCUSD');x.advance(1);x.tick();}
 const a=healthy.engine.openPositions()[0],b=waiting.engine.openPositions()[0];
 for(const key of ['qty','fees','riskAmount','entryPrice','marginLeverage','policy'] as const)assert.deepEqual(b[key],a[key],key);
});

test('an attached exchange executor cannot use paper depth-wait recovery',async t=>{
 const x=fixture(t);await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,x.ctx);
 x.engine.executionIntent=()=>{throw Error('must not place an exchange order');};
 x.advance(11000);x.tick();
 assert.equal(x.engine.pendingEntries().length,0);assert.equal(x.engine.openPositions().length,0);
});

test('a disabled copy pilot still cancels after depth recovers',async t=>{
 const x=fixture(t);x.cfg.incubator.mirror={enabled:true,pilot:{sizeScale:1/3,maxOpenPositions:0,maxDailyEntries:0}};
 await x.engine.prepareEntryDepth!('BTCUSD');x.engine.onEntry(x.ev,{...x.ctx,features:{copy_pilot:1},sizeScale:1/3});
 x.advance(11000);x.tick();assert.equal(x.engine.pendingEntries().length,1);
 x.cfg.incubator.mirror.enabled=false;await x.engine.prepareEntryDepth!('BTCUSD');x.advance(1);x.tick();
 assert.equal(x.engine.pendingEntries().length,0);assert.equal(x.engine.openPositions().length,0);
});
