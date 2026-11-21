import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG,ConfigStore,TF_SECONDS} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from '../paper/engine.ts';
import {PlanComparisons} from '../paper/planComparisons.ts';
import {planSnapshot,validateExecutionPlans,planScannerId} from '../paper/executionPlans.ts';
import {SOL_FILTER_PLANS,solFilterResults} from './solTrendFilterStudy.ts';
import {SOL_MAKER_FILTER_OFF,SOL_MAKER_FILTER_SOURCE} from '../scanners/solMakerExperiment.ts';
import {enableSolTrendFilter} from '../../../ops/enable-sol-trend-filter.ts';
import {candleReplayBlock} from '../paper/basket.ts';
import {variantCompatibleSource} from '../scanners/variantCompat.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {shadowRefusal} from '../incubator/shadow.ts';
const T=1800000000000,H=900000;
function base(){
 const c=structuredClone(DEFAULT_CONFIG);c.execution.mode='paper';c.execution.allowProduction=false;c.incubator.enabled=true;
 c.scanners[SOL_MAKER_FILTER_SOURCE]={enabled:true,symbols:null,timeframes:null,pairs:[{symbol:'SOLUSD',tf:'15m'}],exitMode:'both',
  sources:['shape'],labels:['Upper Retest','Lower Retest'],sides:{'upper retest':'long','lower retest':'short'},entryLimit:{tfs:['15m'],atr:.1,minutes:5}};
 return c;
}
function activated(t:any,c=base()){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'sol-filter-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 const file=path.join(d,'config.json');fs.writeFileSync(file,JSON.stringify(c));enableSolTrendFilter(file);
 return {file,cfg:new ConfigStore(file).get()};
}
test('activation adds only a disabled research scanner and four fresh plans; repeats and dry runs write nothing',t=>{
 const cfg=base(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-filter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(cfg));const before=fs.readFileSync(file,'utf8');
 assert.ok(enableSolTrendFilter(file,true).changed);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableSolTrendFilter(file);const next=JSON.parse(fs.readFileSync(file,'utf8'));
 const {executionPlans,scanners,...rest}=next,{scanners:oldScanners,...oldRest}=cfg;assert.deepEqual(rest,oldRest);
 delete scanners[SOL_MAKER_FILTER_OFF];assert.deepEqual(scanners,oldScanners);assert.equal(executionPlans.length,4);
 const time=fs.statSync(file).mtimeMs;assert.equal(enableSolTrendFilter(file).changed,false);assert.equal(fs.statSync(file).mtimeMs,time);
 const c=new ConfigStore(file).get(),snaps=SOL_FILTER_PLANS.map(p=>planSnapshot(c,p,'source'));
 assert.equal(new Set(snaps.map(p=>p.signature)).size,4);
 for(const p of snaps){assert.deepEqual(p.paper,snaps[0].paper);assert.equal(p.paper.maxStopLossPct,cfg.paper.maxStopLossPct);assert.equal(p.paper.marginPerTrade,cfg.paper.marginPerTrade);}
 assert.equal(c.scanners[SOL_MAKER_FILTER_OFF].inputs?.TrendFilter,false);assert.equal(c.scanners[SOL_MAKER_FILTER_SOURCE].inputs?.TrendFilter,undefined);
 assert.equal(c.scanners[SOL_MAKER_FILTER_OFF].enabled,false);
 next.executionPlans[0].revision=2;fs.writeFileSync(file,JSON.stringify(next));assert.throws(()=>enableSolTrendFilter(file),/refusing overwrite/);
});
test('study refuses live mode, input drift, changed exits, missing arms and research scanner account activation',t=>{
 for(const change of [
  (c:any)=>{c.execution.mode='live';},(c:any)=>{c.execution.allowProduction=true;},
  (c:any)=>{c.scanners[SOL_MAKER_FILTER_SOURCE].inputs={TrendFilter:false};},
 ]){const c=base();change(c);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-filter-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(c));assert.throws(()=>enableSolTrendFilter(file));}
 const {cfg}=activated(t);assert.deepEqual(validateExecutionPlans(cfg.executionPlans,TF_SECONDS,cfg),[]);
 for(const change of [
  (c:any)=>{c.executionPlans.pop();},(c:any)=>{c.scanners[SOL_MAKER_FILTER_OFF].enabled=true;},
  (c:any)=>{c.scanners[SOL_MAKER_FILTER_OFF].entryLimit.atr=.01;},
  (c:any)=>{c.scanners[SOL_MAKER_FILTER_OFF].inputs.TrendFilter=true;},
  (c:any)=>{c.executionPlans[1].trailing={afterR:.1,giveBackPct:10,floorAtR:0,floorKeepR:0};},
  (c:any)=>{c.executionPlans[1].makerFill='tick-depth-v1';},
 ]){const c=structuredClone(cfg);change(c);assert.ok(validateExecutionPlans(c.executionPlans,TF_SECONDS,c).length);}
});
test('input variant shares source, is source pinned and cannot enter ordinary screening or books',t=>{
 const registry=new ScannerRegistry(),s=registry.get(SOL_MAKER_FILTER_SOURCE)!,v=registry.get(SOL_MAKER_FILTER_OFF)!;
 assert.equal(v.status,'ok');assert.equal(s.patched,v.patched);assert.throws(()=>variantCompatibleSource(v.id,v.source+'\n'),/source changed/);
 assert.match(candleReplayBlock(v.id)!,/isolated research/);assert.equal(candleReplayBlock(s.id),null);
 const {cfg}=activated(t);const db=new Db(':memory:');t.after(()=>db.db.close());
 for(const book of [0,2]){const e=new PaperEngine(db,()=>cfg,{book,now:()=>T});
  const event={kind:'entry' as const,side:'long' as const,price:100,tp:[],label:'Upper Retest',message:'',source:'shape' as const,barTime:T-H,barIndex:59};
  const context={scannerId:v.id,scannerName:v.name,symbol:'SOLUSD',tf:'15m',market:{tickSize:.01,contractValue:1},refPrice:100,at:T,signalId:null,exitMode:'both' as const,atr:2};
  assert.match(e.onEntry(event,context).reason!,/isolated research/);
  if(book===0){const snap=planSnapshot(cfg,SOL_FILTER_PLANS[1],'source');assert.match(e.onEntry(event,{...context,scannerId:planScannerId(snap),executionPlan:snap}).reason!,/wrong book/);}
 }
});
test('both source policies use identical market and regime decisions',()=>{
 const bars=Array.from({length:50},(_,i)=>({time:T-i*H,open:100,high:101,low:99,close:100+(i%2),volume:100}));
 for(const exempt of [[],[SOL_MAKER_FILTER_SOURCE]]){
  const input={symbol:'SOLUSD',at:T,price:100,atr:1,bars,market:{allowed:true,reasons:[]},regime:{enabled:true,minAtrPct:2,minEr:.2,noWeekend:false,exempt}};
  assert.deepEqual(shadowRefusal({...input,scannerId:SOL_MAKER_FILTER_SOURCE}),shadowRefusal({...input,scannerId:SOL_MAKER_FILTER_OFF}));
 }
});
test('four arms count their own signals and fills, honor both models and remain excluded from promotion',t=>{
 const c=base();Object.assign(c.paper,{initialEquity:1000,marginPerTrade:150,fillSource:'candles',latencyMs:100,requireQuote:true,useSpread:true,quoteMaxAgeMs:1000,liquidation:false,minRiskFeeRatio:0,maxSignalAgeSec:0,skipScriptStops:false,slippageBps:0,quotedSlippageBps:0,trailAfterR:0,floorAtR:0,scalperOffer:undefined});
 const {cfg}=activated(t,c),db=new Db(':memory:');t.after(()=>db.db.close());let now=T,book:any=null;
 const e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;e.sourceHashFor=()=> 'source';e.quotes={executable:(_s,side)=>side==='buy'?100.01:99.99};e.makerFillBook=()=>book;
 const service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 for(const scannerId of [SOL_MAKER_FILTER_SOURCE,SOL_MAKER_FILTER_OFF])service.observeScan({scannerId,scannerName:scannerId,symbol:'SOLUSD',tf:'15m',bars,market:{tickSize:.01,contractValue:1},at:now,refPrice:100,patched:'',since:T-H,newLabelKeys:new Set(),refusal:()=>null,result:{id:1,ok:true,ms:1,bars:60,lastBarTime:T-H,warnings:0,alerts:[],shapes:[],labels:[],plots:[]}});
 assert.equal(db.get<any>('SELECT count(*) n FROM execution_plan_scans')!.n,4);assert.equal(e.pendingEntries().length,0);
 const observe=(scannerId:string,barTime=T-H)=>service.observe({scannerId,scannerName:scannerId,symbol:'SOLUSD',tf:'15m',bars,market:{tickSize:.01,contractValue:1},at:now,refPrice:100,
  event:{kind:'entry',side:'long',price:100,sl:97,tp:[],label:'Upper Retest',message:'',source:'shape',barTime,barIndex:59}});
 observe(SOL_MAKER_FILTER_SOURCE);observe(SOL_MAKER_FILTER_OFF);assert.equal(e.pendingEntries().length,4);
 now=T+100;book={receivedAt:now,exchangeAt:now,bids:[{price:99.99,size:1000}],asks:[{price:100.01,size:1000}]};e.observeMakerBook('SOLUSD',book,now);
 now=T+200;e.onTrade('SOLUSD',99.7,1,now,now,'print-1');assert.equal(e.openPositions().length,2);assert.ok(e.openPositions().every(p=>p.qty===1));
 now=T+300;book={...book,receivedAt:now,exchangeAt:now};e.onTrade('SOLUSD',99.7,1000,now,now,'print-2');assert.equal(e.pendingEntries().length,2);
 now=T+61000;e.onBar('SOLUSD',{time:T+60000,high:101,low:99.7,close:100,volume:1000},now);assert.equal(e.openPositions().length,4);
 observe(SOL_MAKER_FILTER_OFF,T);const report=solFilterResults(db);assert.equal(report.arms.length,4);
 for(const a of report.arms){assert.equal(a.signals,a.filter==='off'?2:1);assert.equal(a.filled,1);assert.equal(a.open,1);assert.equal(a.net,null);}
 for(const pair of report.comparisons){assert.equal(pair.sharedSignals,1);assert.equal(pair.offOnly,1);assert.equal(pair.matchedDeltaNet,null);}
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`).n,0);
 assert.ok(db.all<any>('select evidence_scope from positions').every(p=>p.evidence_scope==='experiment'));
 assert.equal(report.promotionEligible,false);
 const cohort=db.get<any>('SELECT * FROM execution_plan_cohorts WHERE plan_id=?',SOL_FILTER_PLANS[0].id)!;
 db.run('INSERT INTO execution_plan_cohorts VALUES(?,?,?,?,?,?,?,?)',cohort.scanner_id+'-changed',cohort.plan_id,cohort.revision,'changed',cohort.symbol,cohort.tf,now,cohort.snapshot);
 const mixed=solFilterResults(db);assert.equal(mixed.arms[0].mixedPolicies,true);assert.equal(mixed.arms[0].net,null);
 assert.equal(mixed.comparisons.find(c=>c.fillModel==='candle')!.mixedPolicies,true);
 assert.equal(mixed.comparisons.find(c=>c.fillModel==='candle')!.matchedDeltaNet,null);
});

