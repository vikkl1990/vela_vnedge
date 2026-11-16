import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {MARKITTICK_SHADOW_PLANS,enableMarkitTickShadow} from '../../../ops/enable-markittick-shadow.ts';
import {planEvents,planSnapshot,planScannerId,MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {resolveLevels} from './logic.ts';
const T=1800000000000,H=900000;
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mt-shadow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';Object.assign(raw.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,skipScriptStops:true,trailAfterR:.5,floorAtR:.5,floorKeepR:.25,trailAtrMult:0,trailGiveBackPct:10,trailDistanceR:0,tpSplit:[0,0,1],fallbackRR:[2,4,6]});raw.incubator.enabled=true;
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw,cfg:new ConfigStore(file).get()};
}
test('paired MarkitTick rollout writes only experiments, preserves existing plans, supports existing smaller margin and is idempotent',t=>{
 const {file,raw}=fixture(t);raw.paper.marginPerTrade=50;
 raw.executionPlans=Array.from({length:37},(_,i)=>({id:`old-${i}`,revision:1,enabled:true,scannerId:'old',symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableMarkitTickShadow(file,true).totalPlans,73);assert.equal(fs.readFileSync(file,'utf8'),before);
 const result=enableMarkitTickShadow(file);assert.equal(result.changed,true);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual({...next,executionPlans:raw.executionPlans},raw);
 assert.deepEqual(next.executionPlans.slice(0,37),raw.executionPlans);assert.equal(enableMarkitTickShadow(file).changed,false);
 const cfg=new ConfigStore(file).get();for(const p of MARKITTICK_SHADOW_PLANS){assert.equal(cfg.scanners[p.scannerId].enabled,false);assert.equal(planSnapshot(cfg,p).paper.marginPerTrade,50);}
 next.executionPlans[37].label='edited';fs.writeFileSync(file,JSON.stringify(next));assert.throws(()=>enableMarkitTickShadow(file),/will not be overwritten/);
 raw.execution.mode='dry-run';fs.writeFileSync(file,JSON.stringify(raw));assert.throws(()=>enableMarkitTickShadow(file),/paper mode/);
 raw.execution.mode='paper';
 while(raw.executionPlans.length+MARKITTICK_SHADOW_PLANS.length<=MAX_RESEARCH_PLANS)
  raw.executionPlans.push({...raw.executionPlans[0],id:`extra-${raw.executionPlans.length}`});
 fs.writeFileSync(file,JSON.stringify(raw));assert.throws(()=>enableMarkitTickShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)));
});
test('TP comparisons share entry, native SL, sizing, fees and every risk setting; only explicit exit policy differs',t=>{
 const {cfg}=fixture(t);const before=JSON.stringify(cfg);
 for(let i=0;i<MARKITTICK_SHADOW_PLANS.length;i+=2){
  const a=planSnapshot(cfg,MARKITTICK_SHADOW_PLANS[i],'source'),b=planSnapshot(cfg,MARKITTICK_SHADOW_PLANS[i+1],'source');
  assert.equal(a.paper.marginPerTrade,150);assert.equal(b.paper.maxStopLossPct,3);assert.equal(a.paper.skipScriptStops,false);assert.equal(b.paper.skipScriptStops,false);
  const exitKeys=['scriptTargets','tpSplit','trailAfterR','floorAtR','trailSteps'];
  const entry=(p:typeof a)=>Object.fromEntries(Object.entries(p.paper).filter(([k])=>!exitKeys.includes(k)));
  assert.deepEqual(entry(a),entry(b));assert.notEqual(a.signature,b.signature);assert.equal(a.paper.scriptTargets,'ignore');assert.equal(b.paper.scriptTargets,'use');
  const event={kind:'entry' as const,side:'long' as const,price:100,sl:98,tp:[104],barTime:T-H,barIndex:0,label:'entry',source:'alert' as const,message:''};
  assert.deepEqual(planEvents([event],[],a),planEvents([event],[],b));
  const x=resolveLevels(event,a.paper,.01),y=resolveLevels(event,b.paper,.01);assert.ok('tp'in x&&'tp'in y);assert.deepEqual(x.tp,[104,108,112]);assert.deepEqual(y.tp,[104]);assert.equal(x.sl,y.sl);
  assert.equal(b.paper.trailAfterR,0);assert.equal(b.paper.floorAtR,0);assert.equal(a.paper.trailAfterR,.5);
 }
 assert.equal(JSON.stringify(cfg),before);
});
test('exit comparison validation rejects mixed readings, risk, source, missing arms and disguised policy overrides',t=>{
 const {cfg}=fixture(t),plans=structuredClone(MARKITTICK_SHADOW_PLANS.slice(0,2));cfg.executionPlans=plans;assert.deepEqual(validateConfig(cfg),[]);
 for(const change of [(p:any)=>p.readingOverride.reader=1,(p:any)=>p.readingOverride.sides={Long:'short'},(p:any)=>p.maxStopLossPct=1,(p:any)=>p.sourceScannerId='other',(p:any)=>p.scannerId='other',(p:any)=>p.trailing={afterR:1,giveBackPct:20,floorAtR:0,floorKeepR:0},(p:any)=>p.exitPolicy='account-ladder']){
  const next=structuredClone(plans);change(next[1]);assert.ok(validateConfig({...cfg,executionPlans:next}).length>0);
 }
 assert.ok(validateConfig({...cfg,executionPlans:[plans[0]]}).length>0);
});
test('real-time fanout deduplicates signals, fills both arms after latency, preserves frozen exits on restart and excludes all evidence',t=>{
 const {cfg}=fixture(t);Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,liquidation:false,limitEntry:undefined,minRiskFeeRatio:6});
 cfg.executionPlans=structuredClone(MARKITTICK_SHADOW_PLANS.slice(0,2));const first=cfg.executionPlans[0];
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;
 let service=new PlanComparisons(db,()=>cfg,engine,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 const input:ComparisonScan={scannerId:first.scannerId,scannerName:'MESA',symbol:first.symbol,tf:'15m',patched:'source',since:T-H,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:T,refPrice:100,refusal:()=>null,
  result:{id:1,ok:true,ms:1,bars:60,lastBarTime:T-H,warnings:0,alerts:[{type:'alert',time:T-H,barIndex:59,message:JSON.stringify({action:'long',entry:100,sl:98,tp:104})}],shapes:[],labels:[],plots:[]}};
 service.observeScan(input);service.observeScan(input);assert.equal(engine.pendingEntries().length,2);assert.equal(engine.openPositions().length,0);
 now=T+99;engine.onTrade(first.symbol,100,1e6,now,now,'too-early');assert.equal(engine.openPositions().length,0);
 now=T+100;engine.onTrade(first.symbol,100,1e6,now,now,'entry');assert.equal(engine.openPositions().length,2);
 const [a,b]=engine.openPositions();assert.equal(a.qty,b.qty);assert.equal(a.entryPrice,b.entryPrice);assert.equal(a.riskAmount,b.riskAmount);assert.equal(a.sl,b.sl);assert.deepEqual(a.fills.map(({orderId,...f})=>f),b.fills.map(({orderId,...f})=>f));assert.ok(a.riskAmount<=30&&a.fills[0].fee>0);
 const before=engine.openPositions().map(p=>({id:p.id,policy:p.executionPlan}));
 engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;service=new PlanComparisons(db,()=>cfg,engine,()=> 'source');
 assert.deepEqual(engine.openPositions().map(p=>({id:p.id,policy:p.executionPlan})),JSON.parse(JSON.stringify(before)));
 now+=200;engine.onTrade(first.symbol,101.2,1e6,now,now,'peak');now+=200;engine.onTrade(first.symbol,101.2,1e6,now,now,'ack');
 now+=200;engine.onTrade(first.symbol,100.8,1e6,now,now,'pullback');
 now+=200;engine.settleExits(first.symbol,{receivedAt:now,exchangeAt:now,bids:[{price:100.7,size:1e6}],asks:[{price:100.8,size:1e6}]},now);
 assert.equal(engine.openPositions().length,1);assert.equal(engine.openPositions()[0].executionPlan!.comparison!.role,'candidate');
 now+=200;engine.onTrade(first.symbol,104.1,1e6,now,now,'native-target');
 now+=200;engine.settleExits(first.symbol,{receivedAt:now,exchangeAt:now,bids:[{price:104,size:1e6}],asks:[{price:104.1,size:1e6}]},now);
 assert.equal(engine.openPositions().length,0);
 const view=service.view();assert.equal(view.comparisons[0].kind,'exit');assert.equal(view.comparisons[0].sharedSignals,1);assert.equal(view.comparisons[0].matchedClosed,1);
 assert.ok(view.cohorts.every(c=>c.filled===1&&c.closed===1&&c.fees>0));
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.ok(db.all<any>('SELECT evidence_scope,bt FROM positions').every(p=>p.evidence_scope==='experiment'&&p.bt===2));
 const account=new PaperEngine(db,()=>cfg),snapshot=planSnapshot(cfg,first);
 const ev={kind:'entry' as const,side:'long' as const,price:100,sl:98,tp:[104],barTime:T-H,barIndex:59,label:'Long',message:'',source:'alert' as const};
 assert.match(account.onEntry(ev,{...input,scannerId:planScannerId(snapshot),signalId:null,exitMode:'levels',executionPlan:snapshot,atr:2}).reason!,/wrong book/);
});

import {ShadowRunner} from '../incubator/shadow.ts';
test('all 36 arms schedule exactly 18 source cells while account profiles stay disabled',async t=>{
 const {cfg}=fixture(t);cfg.executionPlans=structuredClone(MARKITTICK_SHADOW_PLANS);
 const db=new Db(':memory:');t.after(()=>db.db.close());const engine=new PaperEngine(db,()=>cfg,{book:2});
 const runner=new ShadowRunner({store:{list:()=>[],liveMarks:()=>({}),setLiveMarks:()=>{},shadowFunnel:()=>({})},cfgRef:()=>cfg,paper:engine,registry:{get:()=>({status:'ok'})},pool:{size:2,reserved:1,stats:{}},candles:{has:()=>true,get:()=>[]},marketInfo:async()=>({contractValue:.01,tickSize:.01})} as any);
 t.after(()=>runner.stop());await runner.sync();assert.equal(runner.active.length,18);
 assert.equal(new Set(runner.active.map(c=>[c.scannerId,c.symbol,c.tf].join(':'))).size,18);
 assert.ok(runner.active.every(c=>c.id<0&&!cfg.scanners[c.scannerId].enabled));
});
