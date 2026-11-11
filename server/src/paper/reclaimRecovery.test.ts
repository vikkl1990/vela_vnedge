import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {reclaimStatus} from './reclaimAudit.ts';
import type {Bar} from '../data/candleStore.ts';

const M=60_000,T=Date.UTC(2026,10,11,13,15),ID='recovery-fixture';
function fixture(t:any,file=':memory:'){
 const db=new Db(file);t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);let now=T+1000,source='source-a';
 cfg.scanners[ID]={enabled:true,symbols:null,timeframes:null,pairs:[{symbol:'SOLUSD',tf:'15m'}],exitMode:'both'};
 Object.assign(cfg.paper,{fillSource:'tape',liquidation:false,feeRatePct:0,makerFeeRatePct:0,slippageBps:0,minRiskFeeRatio:0,maxSignalAgeSec:60,minSizeShare:0,requireQuote:true,useSpread:true,quoteMaxAgeMs:10000,marginPerTrade:150,maxStopLossPct:3});
 cfg.paper.reclaimTrials=[{enabled:true,scannerId:ID,symbol:'SOLUSD',tf:'15m',pullbackAtr:.1,setupMinutes:10,orderMinutes:2,sizeScale:1/3,maxDailyEntries:3}];
 const make=()=>{const e=new PaperEngine(db,()=>cfg,{now:()=>now});e.sourceHashFor=()=>source;e.quotes={executable:()=>100.4};return e;};
 let e=make();
 const ctx={scannerId:ID,scannerName:ID,symbol:'SOLUSD',tf:'15m',market:{contractValue:.01,tickSize:.01},atr:2,refPrice:100,at:now,signalId:null,exitMode:'both' as const};
 const ev={kind:'entry' as const,side:'long' as const,price:100,tp:[],label:'entry',message:'',source:'alert' as const,barTime:T-15*M,barIndex:0};
 const bar=(i:number,open:number,high:number,low:number,close:number):Bar=>({time:T+i*M,open,high,low,close,volume:1});
 const p=bar(1,100,100.1,99.5,99.8),w=bar(2,99.8,100.15,99.6,99.9),r=bar(3,99.9,100.5,99.8,100.3);
 const minute=(b:Bar,historical=false)=>{now=b.time+M+1000;e.onClosedMinute('SOLUSD',b,now,historical);};
 const saved=()=>db.get<any>("SELECT fills FROM positions WHERE status='pending' AND bt=0")?.fills;
 return {db,cfg,ctx,ev,p,w,r,bar,minute,saved,get e(){return e;},at:(v:number)=>{now=v;},source:(v:string)=>{source=v;},restart:(at:number)=>{now=at;e=make();return e;}};
}

test('committed reclaim checkpoint resumes with identical uninterrupted order, sizing and policy',t=>{
 const a=fixture(t),b=fixture(t),config=JSON.stringify(a.cfg);
 for(const f of [a,b]){f.e.onEntry(f.ev,f.ctx);f.minute(f.p);}
 const persisted=JSON.parse(a.saved()).reclaimSetup;assert.equal(persisted.reclaim.state.phase,'reclaim');assert.equal(persisted.reclaim.state.last.time,a.p.time);
 const id=persisted.id,policy=persisted.policy.id;
 a.restart(T+2*M+5000);assert.equal(a.e.pendingEntries()[0].id,id);assert.equal(a.e.pendingEntries()[0].policy!.id,policy);
 assert.equal(reclaimStatus(a.db,a.cfg,a.e,T+2*M+5000).trials[0].state,'Checking setup continuity');
 a.e.reclaimHistory=()=>[a.w];a.minute(a.r);
 b.minute(b.w);b.minute(b.r);
 const pa=a.e.pendingEntries()[0],pb=b.e.pendingEntries()[0];
 assert.ok(pa.limit);assert.deepEqual(pa.limit,pb.limit);assert.deepEqual(pa.levels,pb.levels);assert.deepEqual(pa.reservation,pb.reservation);assert.equal(pa.policy!.id,pb.policy!.id);
 assert.equal(a.e.openPositions().length,0);assert.equal(JSON.stringify(a.cfg),config);
 const historicalTime=T+3*M+30000;
 a.e.onTrade('SOLUSD',99,100,historicalTime,pa.at+1);assert.equal(a.e.openPositions().length,0,'late downtime print cannot fill a newly placed order');
 a.e.onBar('SOLUSD',{time:T+3*M,open:100,high:100.5,low:99,close:100,volume:100},pa.at+1,{historical:true});
 assert.equal(a.e.openPositions().length,0,'historical candle cannot fill');
 for(const f of [a,b]){const order=f.e.pendingEntries()[0];f.at(order.at+1000);f.e.onTrade('SOLUSD',100,1,order.at+1000,order.at+1000);}
 assert.equal(a.e.openPositions()[0].entryPrice,b.e.openPositions()[0].entryPrice);assert.equal(a.e.openPositions()[0].qty,b.e.openPositions()[0].qty);
 assert.equal(a.e.openPositions()[0].policy!.strategyId,b.e.openPositions()[0].policy!.strategyId);
 assert.equal(reclaimStatus(a.db,a.cfg,a.e,T+5*M).trials[0].usedToday,1);
});

test('checkpoint and pullback audit roll back together on write failure, including after restart',t=>{
 const a=fixture(t);a.e.onEntry(a.ev,a.ctx);const before=a.saved(),state=structuredClone(a.e.pendingEntries()[0]);
 a.db.db.exec("CREATE TEMP TRIGGER fail_checkpoint BEFORE UPDATE OF fills ON positions BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END");
 a.minute(a.p);assert.equal(a.saved(),before);assert.deepEqual(a.e.pendingEntries()[0],state);
 assert.equal(a.db.get<any>("SELECT count(*) n FROM reclaim_events WHERE event='pullback'").n,0);
 a.db.db.exec('DROP TRIGGER fail_checkpoint');a.minute(a.p);a.restart(T+2*M+5000);
 a.e.reclaimHistory=()=>[];a.minute(a.w);assert.equal(a.e.pendingEntries()[0].reclaim?.recovery,undefined);
 a.restart(T+3*M+5000);a.minute(a.r);assert.ok(a.e.pendingEntries()[0].limit);
 assert.equal(a.db.get<any>("SELECT count(*) n FROM reclaim_events WHERE event='ordered'").n,1);
});

test('a confirmation during downtime cancels the setup without a historical order, fill or budget debit',t=>{
 const a=fixture(t);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);a.restart(T+4*M+5000);
 a.e.reclaimHistory=()=>[a.w,a.r];const fresh=a.bar(4,100.3,100.4,100,100.2);a.minute(fresh);
 assert.equal(a.e.pendingEntries().length,0);assert.equal(a.e.openPositions().length,0);
 const v=reclaimStatus(a.db,a.cfg,a.e,T+5*M).trials[0];assert.match(v.events[0].reason!,/confirmation missed during downtime/);assert.equal(v.usedToday,0);
 assert.equal(v.counts.ordered??0,0);assert.equal(v.counts.filled??0,0);
});

test('missing, duplicated or invalid history cannot certify a recovered setup',t=>{
 for(const kind of ['missing','duplicate','invalid','stop'] as const){
  const a=fixture(t);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);a.restart(T+2*M+5000);
  a.e.reclaimHistory=()=>kind==='missing'?[]:kind==='duplicate'?[a.w,a.w]:[{...a.w,low:kind==='stop'?96:-1}];
  a.minute(a.r);assert.equal(a.e.pendingEntries().length,0,kind);assert.equal(a.e.openPositions().length,0,kind);
 }
});

test('loading history, partial candles and historical events cannot create a confirmation',t=>{
 const a=fixture(t);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);a.restart(T+2*M+5000);
 a.e.reclaimHistory=()=>null;a.minute(a.r);assert.ok(a.e.pendingEntries()[0].reclaim?.recovery);
 a.e.onClosedMinute('SOLUSD',a.r,a.r.time+1000);a.minute(a.r,true);assert.ok(a.e.pendingEntries()[0].reclaim?.recovery);
 a.at(T+11*M);a.e.housekeeping(T+11*M);assert.equal(a.e.pendingEntries().length,0,'waiting for readiness does not extend the setup TTL');
 const b=fixture(t);b.e.onEntry(b.ev,b.ctx);b.minute(b.p);b.restart(T+4*M+5000);
 b.e.onClosedMinute('SOLUSD',b.r,T+4*M+6000,false);assert.ok(b.e.pendingEntries()[0].reclaim?.recovery,'even mislabelled recent history closed before restart cannot place');
 assert.equal(b.e.openPositions().length,0);
});

test('legacy, corrupted, expired and already-ordered snapshots fail closed on restart',t=>{
 for(const kind of ['legacy','corrupt','expired','order']as const){
  const a=fixture(t);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);
  if(kind==='order'){a.minute(a.w);a.minute(a.r);}
  else if(kind!=='expired'){
   const row=JSON.parse(a.saved());if(kind==='legacy')delete row.reclaimSetup.reclaim.checkpoint;else row.reclaimSetup.reclaim.state.last.time+=1;
   a.db.run('UPDATE positions SET fills=?',JSON.stringify(row));
  }
  a.restart(kind==='expired'?T+11*M:T+4*M+5000);assert.equal(a.e.pendingEntries().length,0,kind);assert.equal(a.e.openPositions().length,0,kind);
 }
});

test('restored setups recheck allocation, rule, source policy and live admission gates',t=>{
 for(const change of ['allocation','rule','source','quote','risk','depth','fees','funding','exposure','budget'] as const){
  const a=fixture(t);if(change==='fees'){a.cfg.paper.feeRatePct=1;a.cfg.paper.makerFeeRatePct=1;a.cfg.paper.minRiskFeeRatio=100;}
  a.e.onEntry(a.ev,a.ctx);a.minute(a.p);
  if(change==='allocation')a.cfg.scanners[ID].pairs=[];
  if(change==='rule')a.cfg.paper.reclaimTrials![0].pullbackAtr=.2;
  a.restart(T+2*M+5000);
  if(change==='source')a.source('source-b');
  if(change==='quote')a.e.quotes={executable:()=>null};
  if(change==='risk')a.e.risk={gate:()=>({reject:'halted',leverageMult:1}),exposureCheck:()=>null};
  if(change==='depth')a.e.entryDepthGate=()=>({reject:'depth missing'});
  if(change==='funding')a.e.fundingEntryBlock=()=> 'funding hold';
  if(change==='exposure')a.e.risk={gate:()=>({leverageMult:1}),exposureCheck:()=> 'exposure cap'};
  if(change==='budget')a.db.kvSet(`paper.reclaim.${ID}|SOLUSD|15m`,{day:Math.floor(T/86400000),entries:3});
  a.e.reclaimHistory=()=>[a.w];a.minute(a.r);
  assert.equal(a.e.pendingEntries().length,0,change);assert.equal(a.e.openPositions().length,0,change);
 }
});

test('a missed source timeframe close cannot conceal a script exit during recovery',t=>{
 const a=fixture(t);a.cfg.paper.reclaimTrials![0].setupMinutes=30;
 a.e.onEntry(a.ev,a.ctx);a.minute(a.p);a.restart(T+16*M);
 a.e.reclaimHistory=()=>[];a.minute(a.bar(16,100,100.1,99.8,100));
 assert.equal(a.e.pendingEntries().length,0);
 assert.match(reclaimStatus(a.db,a.cfg,a.e,T+17*M).trials[0].events[0].reason!,/source bar closed/);
});

test('recorded SOL setup survives a 13:22 restart and can place only on the fresh 13:24 confirmation',t=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/reclaim-sol-20261111.json',import.meta.url),'utf8'));
 const a=fixture(t);a.ctx.at=f.signalAt;a.ctx.refPrice=f.reference;a.ctx.atr=f.atr;a.ctx.market={contractValue:1,tickSize:.0001};delete (a.ev as any).price;
 a.at(f.signalAt);a.e.quotes={executable:()=>84.5};a.e.onEntry(a.ev,a.ctx);
 for(const b of f.bars.filter((b:Bar)=>b.time+M<f.restartAt))a.minute(b);
 a.restart(f.restartAt);assert.equal(a.e.pendingEntries().length,1);a.e.quotes={executable:()=>84.5};
 const fresh=f.bars.find((b:Bar)=>b.time===Date.UTC(2026,10,11,13,23));
 a.e.reclaimHistory=(_s,from,to)=>f.bars.filter((b:Bar)=>b.time>=from&&b.time<=to);
 a.minute(fresh);const order=a.e.pendingEntries()[0];assert.ok(order.limit);assert.equal(order.limit.price,84.393);
 assert.equal(order.at,Date.UTC(2026,10,11,13,24,1));assert.equal(a.e.openPositions().length,0);
 assert.equal(order.policy!.paper.marginPerTrade,150);assert.equal(a.cfg.paper.maxStopLossPct,3);
});

test('failed recovered confirmation rolls back the recovery cursor, order, audit and budget',t=>{
 const a=fixture(t);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);a.restart(T+2*M+5000);a.e.reclaimHistory=()=>[a.w];
 const before=a.saved(),pe=a.e.pendingEntries()[0],state=structuredClone(pe);
 a.db.db.exec("CREATE TEMP TRIGGER fail_recovered_order BEFORE INSERT ON reclaim_events WHEN NEW.event='ordered' BEGIN SELECT RAISE(ABORT,'order audit failed'); END");
 a.minute(a.r);assert.equal(a.saved(),before);assert.deepEqual(a.e.pendingEntries()[0],state);
 assert.equal(a.db.get<any>("SELECT count(*) n FROM reclaim_events WHERE event IN ('recovered','ordered','confirmed')").n,0);
 assert.equal(reclaimStatus(a.db,a.cfg,a.e,T+4*M+1000).trials[0].usedToday,0);
 a.db.db.exec('DROP TRIGGER fail_recovered_order');a.minute(a.r);assert.ok(a.e.pendingEntries()[0].limit);
 assert.equal(reclaimStatus(a.db,a.cfg,a.e,T+4*M+1000).trials[0].usedToday,1);
});


test('a separate SQLite connection restores the durable minute cursor and original order budget',t=>{
 const dir=mkdtempSync(join(tmpdir(),'reclaim-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'journal.db'),a=fixture(t,file);a.e.onEntry(a.ev,a.ctx);a.minute(a.p);
 const second=new Db(file);t.after(()=>second.db.close());let now=T+2*M+5000;
 const e=new PaperEngine(second,()=>a.cfg,{now:()=>now});e.sourceHashFor=()=> 'source-a';e.quotes={executable:()=>100.4};e.reclaimHistory=()=>[];
 assert.equal(e.pendingEntries()[0].reclaim!.state.last!.time,a.p.time);
 now=a.w.time+M+1000;e.onClosedMinute('SOLUSD',a.w,now);
 now=a.r.time+M+1000;e.onClosedMinute('SOLUSD',a.r,now);
 assert.ok(e.pendingEntries()[0].limit);assert.equal(reclaimStatus(second,a.cfg,e,now).trials[0].usedToday,1);
 assert.equal(a.db.kvGet<any>(`paper.reclaim.${ID}|SOLUSD|15m`).entries,1);
});
