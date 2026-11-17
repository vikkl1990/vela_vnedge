import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {planSnapshot,planBacktest} from './executionPlans.ts';
import {twoBarFailure} from './failedTradeExit.ts';
import {EVAA_FLOOR_PLANS,EXIT_STUDY_PLANS,enableTwoBarShadow} from '../../../ops/enable-two-bar-shadow.ts';
const T=1800000000000,M=60000,source='trend-impulse-channels-zeiierman';
function setup(t:any,symbol='INITUSD',side:'long'|'short'='long',candidate=true){
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const c=structuredClone(DEFAULT_CONFIG);c.execution.mode='paper';c.execution.allowProduction=false;c.incubator.enabled=true;
 Object.assign(c.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,minRiskFeeRatio:0,maxSignalAgeSec:0,requireQuote:false,useSpread:false,slippageBps:0,latencyMs:100,liquidation:false,skipScriptStops:false,trailAfterR:.5,trailGiveBackPct:10,floorAtR:.5,floorKeepR:.25});
 c.scanners[source]={enabled:true,symbols:null,timeframes:null,exitMode:'levels'};c.executionPlans=structuredClone(EXIT_STUDY_PLANS);
 let e=new PaperEngine(db,()=>c,{book:2,now:()=>now});e.causalExits=true;
 c.scanners['supertrend-cluster-zeiierman']={enabled:true,symbols:null,timeframes:null,exitMode:'levels'};
 const plan=planSnapshot(c,c.executionPlans.find(p=>p.symbol===symbol&&p.comparison?.role===(candidate?'candidate':'control'))!,'source');
 const d=e.onEntry({kind:'entry',side,price:100,sl:side==='long'?98:102,tp:[110,120,130],label:'entry',source:'shape',message:'',barTime:T-900000,barIndex:0},
  {scannerId:'plan:test',scannerName:'test',symbol,tf:plan.tf,market:{tickSize:.01,contractValue:.01},refPrice:100,at:now,signalId:null,exitMode:'levels',executionPlan:plan});
 assert.ok(d.pendingId);now+=200;e.onBar(symbol,{time:T,high:100,low:100,close:100},now);const p=e.position(d.pendingId!)!;assert.equal(p.status,'open');
 return {db,c,p,plan,get e(){return e;},at:(a:number)=>now=a,tick:(a:number,price:number,eventAt=a)=>{now=a;e.onTrade(symbol,price,1,eventAt,a);},restart:()=>{e=new PaperEngine(db,()=>c,{book:2,now:()=>now});e.causalExits=true;return e.position(p.id)!;}};
}
test('INIT candidate waits two elapsed bars, preserves exposure until a fresh depth fill and charges fees',t=>{
 const x=setup(t),at=x.p.entryAt+30*M;x.tick(at-1,98.8);assert.equal(x.e.pendingExits().length,0);
 x.tick(at,98.8);assert.equal(x.e.pendingExits()[0].reason,'two_bar_failure');assert.equal(x.p.status,'open');
 const snap={receivedAt:at+100,exchangeAt:at+100,bids:[{price:98.7,size:10000}],asks:[{price:98.8,size:10000}]};
 x.e.settleExits('INITUSD',snap,at+99);assert.equal(x.p.status,'open');x.at(at+100);x.e.settleExits('INITUSD',snap,at+100);
 assert.equal(x.p.status,'closed');assert.equal(x.p.exitPrice,98.7);assert.ok(x.p.realizedPnl-x.p.fees<0);assert.ok(x.p.fills.at(-1)!.fee>0);
});
test('PARTI uses two hours, and short stops cross asks',t=>{
 const x=setup(t,'PARTIUSD','short');x.tick(x.p.entryAt+30*M,101.2);assert.equal(x.e.pendingExits().length,0);
 const at=x.p.entryAt+120*M;x.tick(at,101.2);assert.equal(x.e.pendingExits().length,1);x.at(at+100);
 x.e.settleExits('PARTIUSD',{receivedAt:at+100,exchangeAt:at+100,bids:[{price:101.2,size:10000}],asks:[{price:101.3,size:10000}]},at+100);assert.equal(x.p.exitPrice,101.3);
});
test('control, already-promising trades and losses smaller than half R do not trigger',t=>{
 const control=setup(t,'INITUSD','long',false);control.tick(control.p.entryAt+31*M,98.8);assert.equal(control.e.pendingExits().length,0);
 const winner=setup(t);winner.tick(winner.p.entryAt+M,100.4);winner.tick(winner.p.entryAt+31*M,98.8);assert.equal(winner.e.pendingExits().length,0);
 const small=setup(t);small.tick(small.p.entryAt+31*M,99.1);assert.equal(small.e.pendingExits().length,0);
});
test('stale ticks and candles cannot create a two-bar exit, while current protective stops retain priority',t=>{
 const x=setup(t),at=x.p.entryAt+31*M;x.tick(at,98.8,at-10000);assert.equal(x.e.pendingExits().length,0);
 x.e.onBar('INITUSD',{time:at,high:99,low:98.8,close:98.8},at);assert.equal(x.e.pendingExits().length,0);
 x.tick(at+1000,97.9);assert.equal(x.e.pendingExits()[0].reason,'sl');
});
test('restart preserves candidate identity and peak; it cannot invent a downtime exit',t=>{
 const x=setup(t);x.tick(x.p.entryAt+M,100.4);const before=JSON.parse(JSON.stringify(x.plan));
 x.c.executionPlans!.find(p=>p.comparison?.role==='candidate')!.failedTradeExit=undefined;
 x.at(x.p.entryAt+31*M);const p=x.restart();assert.deepEqual(p.executionPlan,before);assert.ok(p.peakR!>=.2-1e-10);assert.equal(x.e.pendingExits().length,0);
 x.tick(p.entryAt+31*M+1,98.8);assert.equal(x.e.pendingExits().length,0);
});
test('no missing peak, partial position or wrong cell can qualify; candle backtest refuses silently omitting the rule',t=>{
 const x=setup(t),p=x.p,at=p.entryAt+31*M;p.peakR=0;assert.equal(twoBarFailure(p,98.8,at),true);
 assert.equal(twoBarFailure({...p,peakR:undefined},98.8,at),false);assert.equal(twoBarFailure({...p,qtyOpen:p.qty-1},98.8,at),false);
 assert.equal(twoBarFailure({...p,symbol:'EVAAUSD'},98.8,at),false);assert.throws(()=>planBacktest(x.plan),/tick\/depth/);
});
test('configuration validates paired-only scope; changed source, cap or other exits cannot masquerade as a matched study',t=>{
 const x=setup(t);assert.equal(validateConfig(x.c).length,0);
 for(const change of [(p:any)=>p.scannerId='other',(p:any)=>p.tf='4h',(p:any)=>p.maxStopLossPct=1,(p:any)=>p.trailing={afterR:1,giveBackPct:20,floorAtR:0,floorKeepR:0},(p:any)=>p.comparison.kind=undefined]){
  const cfg=structuredClone(x.c);change(cfg.executionPlans![1]);assert.ok(validateConfig(cfg).some(e=>e.includes('two-bar')));
 }
 const cfg=structuredClone(x.c);cfg.executionPlans![0].failedTradeExit=cfg.executionPlans![1].failedTradeExit;assert.ok(validateConfig(cfg).some(e=>e.includes('two-bar')));
 const control=planSnapshot(x.c,x.c.executionPlans![0],'source');assert.notEqual(control.signature,x.plan.signature);assert.deepEqual(control.paper,x.plan.paper);
});
test('enabling is atomic and idempotent; paper, risk, ML, scanners and existing plans stay byte-equivalent',t=>{
 const x=setup(t);x.c.executionPlans=[];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'two-bar-enable-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(x.c),{mode:0o600});const before=fs.readFileSync(file,'utf8');
 assert.equal(enableTwoBarShadow(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableTwoBarShadow(file);const after=fs.readFileSync(file,'utf8'),next=JSON.parse(after);assert.equal(next.executionPlans.length,6);
 delete next.executionPlans;const old=JSON.parse(before);delete old.executionPlans;assert.deepEqual(next,old);
 assert.equal(enableTwoBarShadow(file).changed,false);assert.equal(fs.readFileSync(file,'utf8'),after);
 const bad=JSON.parse(after);bad.executionPlans[1].referenceEquity=2000;fs.writeFileSync(file,JSON.stringify(bad));assert.throws(()=>enableTwoBarShadow(file),/no overwrite/);
});

test('EVAA floor activates before the original trail, preserves its steps and fills causally after reversal',t=>{
 const x=setup(t,'EVAAUSD','short'),control=setup(t,'EVAAUSD','short',false);
 const at=x.p.entryAt+1000;x.tick(at,99.3);control.tick(at,99.3);
 const state=x.e.exitExecution.state(x.p.id)!;
 assert.equal(x.plan.paper.trailAfterR,.5);assert.equal(x.plan.paper.floorAtR,.3);assert.equal(x.plan.paper.floorKeepR,.1);
 assert.deepEqual({...x.plan.paper,floorAtR:control.plan.paper.floorAtR,floorKeepR:control.plan.paper.floorKeepR},control.plan.paper);
 // Amendment is causal; the floor is not retroactively effective at the favourable tick.
 assert.equal(x.p.sl,102);assert.equal(state.desired_stop,99.8);x.tick(at+101,99.4);assert.ok(x.p.sl!<100);
 x.tick(at+1000,99.85);control.tick(at+1000,99.85);assert.equal(control.e.pendingExits().length,0);assert.equal(x.e.pendingExits().length,1);
 x.at(at+1100);x.e.settleExits('EVAAUSD',{receivedAt:at+1100,exchangeAt:at+1100,bids:[{price:99.84,size:10000}],asks:[{price:99.88,size:10000}]},at+1100);
 assert.equal(x.p.exitPrice,99.88);assert.ok(x.p.fees>0);assert.equal(control.p.status,'open');
});
test('early floor does not replace the existing higher-peak trail or admit other policy changes',t=>{
 const x=setup(t,'EVAAUSD'),control=setup(t,'EVAAUSD','long',false),at=x.p.entryAt+1000;
 x.tick(at,101.2);control.tick(at,101.2);assert.equal(x.p.sl,control.p.sl);
 const stable=JSON.parse(JSON.stringify(x.plan));x.at(at+1000);assert.deepEqual(x.restart().executionPlan,stable);
 for(const patch of [{profitFloor:{afterR:.3,keepR:.3}},{trailing:{afterR:.3,giveBackPct:10,floorAtR:.3,floorKeepR:.1}},{maxStopLossPct:1}]){
  const c=structuredClone(x.c);Object.assign(c.executionPlans!.find(p=>p.id===EVAA_FLOOR_PLANS[1].id)!,patch);assert.ok(validateConfig(c).length>0);
 }
});
