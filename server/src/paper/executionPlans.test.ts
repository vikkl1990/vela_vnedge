import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {bookPaperConfig} from './policy.ts';
import {planSnapshot,planScannerId,planEvents,planBacktest,type ExecutionPlan} from './executionPlans.ts';
import {PlanComparisons} from './planComparisons.ts';
import {runBacktest} from './backtest.ts';
import {costAudit} from './costAudit.ts';
import {closingFeeWaived} from './logic.ts';
const T=1_800_000_000_000,H=900000;
function setup(t:any,limit=false){
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const c=structuredClone(DEFAULT_CONFIG);
 Object.assign(c.paper,{sizingMode:'margin',marginPerTrade:150,initialEquity:1000,slippageBps:0,quotedSlippageBps:0,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,latencyMs:0,liquidation:false,maxStopLossPct:3,maxSignalAgeSec:0,useSpread:false,requireQuote:false,minSizeShare:0,minRiskFeeRatio:6,skipScriptStops:true,trailAfterR:0,floorAtR:0,trailAtrMult:0,staleBars:0,trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'},scalperOffer:{enabled:true,majors:['ETHUSD'],majorsMinutes:30,othersMinutes:15,excluded:[]},limitEntry:limit?{enabled:true,tfs:['15m'],books:['account'],atr:0,bars:2}:undefined});
 c.paper.marginLeverage={base:5,strong:10,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05};
 c.scanners.s={enabled:false,symbols:null,timeframes:null,exitMode:'both'};
 c.executionPlans=['current','native','atr'].map(variant=>({id:`eth-${variant}`,revision:1,enabled:true,scannerId:'s',symbol:'ETHUSD',tf:'15m',variant,referenceEquity:1000} as ExecutionPlan));
 const e=new PaperEngine(db,()=>({...c,paper:bookPaperConfig(c,'shadow')}),{book:2});
 const service=new PlanComparisons(db,()=>c,e,()=> 'source-a');
 const bars=Array.from({length:35},(_,i)=>({time:T-(35-i)*H,open:100,close:100,high:101,low:99,volume:100}));
 const ev={kind:'entry' as const,side:'long' as const,price:100,sl:98,tp:[110,120,130],barTime:bars.at(-1)!.time,barIndex:34,label:'Long',source:'alert' as const,message:''};
 const ctx={scannerId:'s',scannerName:'Source',symbol:'ETHUSD',tf:'15m',market:{contractValue:.01,tickSize:.01},at:T,refPrice:100,event:ev,bars};
 return {db,c,e,service,bars,ev,ctx};
}
test('same source event feeds three plans once; current stop restriction remains and experiments use account-sized risk',t=>{
 const {c,e,service,ctx}=setup(t);service.observe(ctx);service.observe(ctx);
 const view=service.view();assert.equal(view.cohorts.length,3);assert.ok(view.cohorts.every(c=>c.signals===1));
 assert.equal(e.openPositions().length,2);
 assert.match(Object.keys(view.cohorts.find(c=>c.variant==='current')!.reasons)[0],/scanner's own stop/);
 for(const p of e.openPositions()){
  assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.ok(p.riskAmount<=30.00001);assert.ok(p.qty*p.contractValue*p.entryPrice<=750.01);
  assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);
 }
 const native=e.openPositions().find(p=>p.executionPlan?.variant==='native')!,atr=e.openPositions().find(p=>p.executionPlan?.variant==='atr')!;
 assert.equal(native.sl,98);assert.equal(atr.levelsSource,'atr-fallback');assert.notDeepEqual(native.tp,atr.tp);
 assert.equal(c.paper.marginPerTrade,150);assert.equal(c.paper.skipScriptStops,true);
});
test('intrinsic gate refusals are recorded equally without placing any order',t=>{
 const {service,ctx,e}=setup(t);service.observe({...ctx,refusal:'risk regime: test'});
 assert.equal(e.openPositions().length,0);for(const c of service.view().cohorts){assert.equal(c.signals,1);assert.equal(c.placed,0);assert.equal(c.reasons['risk regime: test'],1);}
});
test('pending maker plan survives reload with frozen policy; fills are tracked separately from placement',t=>{
 const {db,c,e,service,ctx}=setup(t,true);service.observe(ctx);
 assert.equal(e.pendingEntries().length,2);assert.ok(service.view().cohorts.filter(c=>c.variant!=='current').every(c=>c.placed===1&&c.filled===0));
 c.paper.marginPerTrade=300;c.paper.feeRatePct=1;
 const reloaded=new PaperEngine(db,()=>({...c,paper:bookPaperConfig(c,'shadow')}),{book:2});new PlanComparisons(db,()=>c,reloaded,()=> 'source-a');
 reloaded.onBar('ETHUSD',{time:T+60000,high:100.1,low:99.9,close:100},T+120000);
 assert.equal(reloaded.openPositions().length,2);
 for(const p of reloaded.openPositions()){assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.ok(p.qty*p.contractValue*p.entryPrice<=750.01);assert.equal(p.fills[0].liquidity,'maker');}
 assert.ok(service.view().cohorts.filter(c=>c.variant!=='current').every(c=>c.filled===1));
});
test('disabled plans cancel pending orders at fill, while held plans keep their exit snapshot',t=>{
 const {c,e,service,ctx}=setup(t,true);service.observe(ctx);c.executionPlans!.forEach(p=>p.enabled=false);
 e.onBar('ETHUSD',{time:T+60000,high:100.1,low:99.9,close:100},T+120000);
 assert.equal(e.openPositions().length,0);assert.equal(e.pendingEntries().length,0);
 assert.ok(service.view().cohorts.filter(c=>c.variant!=='current').every(c=>c.filled===0));
});
test('plan policies cannot enter account book',t=>{
 const {db,c,ctx,ev}=setup(t);const p=planSnapshot(c,c.executionPlans![1]);const account=new PaperEngine(db,()=>c);
 const d=account.onEntry(ev,{...ctx,scannerId:planScannerId(p),signalId:null,exitMode:p.exitMode,executionPlan:p,atr:2});
 assert.equal(d.action,'rejected');assert.match(d.reason!,/wrong book/);assert.equal(account.openPositions().length,0);
});
test('cohorts change with policy or source; new version cannot overlap its previous position',t=>{
 const {c,service,ctx}=setup(t);const a=planSnapshot(c,c.executionPlans![1],'a');
 assert.notEqual(a.signature,planSnapshot(c,c.executionPlans![1],'b').signature);
 service.observe(ctx);c.paper.marginPerTrade=100;
 service.observe({...ctx,event:{...ctx.event,barTime:ctx.event.barTime+H},at:T+H});
 const latest=service.view().cohorts.filter(x=>x.signature!==a.signature);
 assert.ok(latest.some(x=>Object.keys(x.reasons).some(r=>r.includes('previous plan version'))));
});
test('native plan ignores author TP notifications; current plan retains script exits',t=>{
 const {c,e,service,ctx}=setup(t);c.paper.skipScriptStops=false;service.observe(ctx);
 assert.equal(e.openPositions().length,3);
 service.observe({...ctx,event:{...ctx.event,kind:'exit' as any,exitType:'close' as any},at:T+60000});
 assert.equal(e.openPositions().length,2);assert.ok(e.openPositions().every(p=>p.executionPlan?.variant!=='current'));
});
test('full-fee fallback, break-even and realized cost audit are truthful for both directions',t=>{
 const {db,c,ctx,ev}=setup(t);c.paper.skipScriptStops=false;
 const e=new PaperEngine(db,()=>c);
 for(const side of ['long','short'] as const){
  const p=e.onEntry({...ev,side,sl:side==='long'?98:102,tp:side==='long'?[110]:[90]},{...ctx,scannerId:side,signalId:null,exitMode:'both',atr:2}).position!;
  assert.equal(closingFeeWaived(p,T+60000,'close',c.paper),false);
  const b=costAudit(db,c).rows.find(r=>r.id===p.id)!;assert.ok(side==='long'?b.breakEvenPrice!>100:b.breakEvenPrice!<100);
  e.closeManual(p.id,'manual',T+60000);assert.ok(p.fills.at(-1)!.fee>0);
 }
 assert.equal(costAudit(db,c).offer,'unverified-full-fees');
});
test('plan backtest and live execution share levels, sizing and full commissions',t=>{
 const {c,e,service,ctx,bars,ev}=setup(t);service.observe(ctx);
 for(const variant of ['native','atr'] as const){
  const p=planSnapshot(c,c.executionPlans!.find(p=>p.variant===variant)!);
  const series=[...bars,{...bars.at(-1)!,time:T},{...bars.at(-1)!,time:T+H,open:80,high:81,low:79,close:80}];
  const result=runBacktest({scannerId:planScannerId(p),scannerName:'plan',symbol:'ETHUSD',tf:'15m',bars:series,events:planEvents([ev],series,p),...planBacktest(p),contractValue:.01,tickSize:.01});
  assert.equal(result.trades.length,1);
  const live=e.openPositions().find(q=>q.executionPlan?.variant===variant)!;
  assert.equal(result.trades[0].qty,live.qty);assert.equal(result.trades[0].entryPrice,live.entryPrice);assert.equal(result.trades[0].fills[0].fee,live.fills[0].fee);
 }
});
test('invalid registry entries cannot be saved',t=>{
 const {c}=setup(t);assert.equal(validateConfig(c).filter(e=>e.includes('executionPlans')).length,0);
 c.executionPlans!.push({...c.executionPlans![0],referenceEquity:NaN});assert.ok(validateConfig(c).some(e=>e.includes('unique')));assert.ok(validateConfig(c).some(e=>e.includes('referenceEquity')));
});

import {ShadowRunner} from '../incubator/shadow.ts';
test('research source schedules once per cell and remains subscribed while a disabled plan holds a position',async t=>{
 const {c,e,service,ctx,bars}=setup(t);c.incubator.enabled=true;
 const store={list:()=>[],liveMarks:()=>({}),setLiveMarks:()=>{},shadowFunnel:()=>({})};
 const runner=new ShadowRunner({store,cfgRef:()=>c,paper:e,registry:{get:()=>({status:'ok'})},pool:{size:2,reserved:1,stats:{}},candles:{has:()=>true,get:()=>bars},marketInfo:async()=>ctx.market} as any);
 await runner.sync();assert.equal(runner.active.length,1);assert.equal(runner.active[0].scannerId,'s');assert.ok(runner.active[0].id<0);
 service.observe(ctx);c.executionPlans!.forEach(p=>p.enabled=false);await runner.sync();assert.equal(runner.active.length,1);
 for(const p of e.openPositions())e.closeManual(p.id);await runner.sync();assert.equal(runner.active.length,0);
 runner.stop();
});
test('wide stops stay inside 3% and held exit policies survive config changes and restart',t=>{
 const {db,c,e,service,ctx}=setup(t);service.observe({...ctx,event:{...ctx.event,sl:80}});
 const native=e.openPositions().find(p=>p.executionPlan?.variant==='native')!;assert.ok(native);assert.ok(native.riskAmount<=30);assert.ok(native.qty<750);
 const fee=native.executionPlan!.paper.feeRatePct;c.paper.feeRatePct=2;c.paper.scalperOffer!.joinedAt=0;
 const reloaded=new PaperEngine(db,()=>({...c,paper:bookPaperConfig(c,'shadow')}),{book:2});
 const p=reloaded.position(native.id)!;assert.equal(p.executionPlan!.paper.feeRatePct,fee);
 reloaded.closeManual(p.id,'manual',T+60000);assert.ok(p.fills.at(-1)!.fee>0);assert.equal(p.fills.at(-1)!.feeWaived,false);
});
test('market-latency fills retain the plan snapshot and fixed purse',t=>{
 const {c,e,service,ctx}=setup(t);c.paper.fillSource='tape';service.observe(ctx);assert.equal(e.pendingEntries().length,2);
 e.onTrade('ETHUSD',100,10,T+1000,T+1000);assert.equal(e.openPositions().length,2);
 assert.ok(e.openPositions().every(p=>p.executionPlan?.referenceEquity===1000&&p.riskAmount<=30));
});
test('timed plans close only on fresh post-deadline observations',t=>{
 const {c,e,service,ctx}=setup(t);c.paper.fillSource='tape';c.executionPlans![1].maxHoldMinutes=1;service.observe(ctx);
 e.onTrade('ETHUSD',100,10,T+1000,T+1000);e.onTrade('ETHUSD',100,10,T+59999,T+59999);
 assert.ok(e.openPositions().some(p=>p.executionPlan?.variant==='native'));
 e.onTrade('ETHUSD',100,10,T+61000,T+61000);
 assert.ok(!e.openPositions().some(p=>p.executionPlan?.variant==='native'));
 assert.ok(e.openPositions().some(p=>p.executionPlan?.variant==='atr'));
});
