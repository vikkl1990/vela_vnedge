import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {planSnapshot,planBacktest} from './executionPlans.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {enableLifecycleShadow,LIFECYCLE_SHADOW_PLANS} from '../../../ops/enable-lifecycle-shadow.ts';
import {MAX_RESEARCH_PLANS} from './executionPlans.ts';
const specs=JSON.parse(fs.readFileSync(new URL('../../../scripts/specs.json',import.meta.url),'utf8'));
const ids=['reactive-trail-system-author-native','reaction-level-matrix-author-native','strat-trap-vwap-engine-author-native','smart-swing-vwap-zeiierman-author-retests'];

test('four profiles enter experimental shadow causally; native amendments survive restart and pay executable exit fees',t=>{
 const cfg=structuredClone(DEFAULT_CONFIG),T=1800000000000,H=900000;
 cfg.execution.mode='paper';Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,minRiskFeeRatio:6,liquidation:false,skipScriptStops:true});
 const protectedSettings=JSON.stringify([cfg.paper,cfg.risk,cfg.execution]);
 const registry=new ScannerRegistry();
 for(const id of ids){assert.equal(registry.get(id)?.status,'ok');cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};}
 cfg.executionPlans=ids.map((id,i)=>({id:`lifecycle-${i}`,revision:1,enabled:true,scannerId:id,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1}}));
 for(const p of cfg.executionPlans.filter(p=>specs[p.scannerId].reader===3)){
  const snap=planSnapshot(cfg,p,'source');assert.equal(snap.partialExitVersion,1);assert.equal(planBacktest(snap).scriptStopAmendments,'after-close-v1');
 }
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 let service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 const send=(id:string,message:unknown,time=T-H,condition=false)=>{
  const result:ComparisonScan['result']={id:1,ok:true,ms:1,bars:60,lastBarTime:time,warnings:0,alerts:[{type:condition?'alertcondition':'alert',title:condition?String(message):undefined,time,barIndex:59,message:typeof message==='string'?message:JSON.stringify(message)}],shapes:[],labels:[],plots:[]};
  const input:ComparisonScan={scannerId:id,scannerName:id,symbol:'ETHUSD',tf:'15m',patched:'source',since:time,newLabelKeys:new Set(),bars:bars.map(b=>({...b,time:b.time+time-(T-H)})),market:{tickSize:.01,contractValue:.01},at:now,refPrice:100,refusal:()=>null,result};
  service.observeScan(input);return input;
 };
 for(const id of ids){
  const msg=id.startsWith('smart-swing')?'Bullish AVWAP retest':id.startsWith('strat')?{ind:'STRAT',v:'1.9.0',action:'trap_long',entry:100,sl:98,tp1:102,tp2:104,tp3:106}:{action:'buy',price:100,sl:98,tp1:102,tp2:104,tp3:106};
  const input=send(id,msg,T-H,id.startsWith('smart-swing'));service.observeScan(input);
 }
 assert.equal(e.pendingEntries().length,4);assert.equal(e.openPositions().length,0);
 now=T+100;e.onTrade('ETHUSD',100,1e6,now,now,'entry-print');assert.equal(e.openPositions().length,4);
 for(const p of e.openPositions()){
  assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.ok(p.riskAmount<=30);assert.ok(p.fills[0].fee>0);
  assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);
  if(p.executionPlan!.sourceScannerId!==ids[3]){assert.equal(p.sl,98);assert.deepEqual(p.tp,[102,104,106]);}
 }
 now=T+H;
 for(const id of ids.slice(0,3)){
  for(const leg of [1,2])send(id,id.startsWith('strat')?
   {ind:'STRAT',v:'1.9.0',action:`tp${leg}_hit`,entry:100,level:100+leg*2}:
   `🎯 TP${leg} HIT | ETHUSD | Long | TP${leg}: ${100+leg*2}`,T);
 }
 assert.equal(e.pendingExits().length,0,'TP1/TP2 are milestones, not author partial sales');
 assert.ok(e.openPositions().every(p=>p.fills.length===1));
 send(ids[0],'🛡️ BREAK-EVEN | ETHUSD | SL moved to entry: 100',T);
 send(ids[1],'🛡️ BREAK-EVEN | ETHUSD | Long | SL moved to 100',T);
 send(ids[2],{ind:'STRAT',v:'1.9.0',action:'be',entry:100,sl:100},T);
 // Author requests do not retroactively rewrite a fill; acknowledgement happens on a later observation.
 assert.ok(e.openPositions().filter(p=>p.executionPlan!.sourceScannerId!==ids[3]).every(p=>p.sl===98));
 e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 assert.equal(e.openPositions().length,4);
 now+=100;e.onTrade('ETHUSD',99.5,1e6,now,now,'after-restart');
 const native=e.openPositions().filter(p=>p.executionPlan!.sourceScannerId!==ids[3]);assert.ok(native.every(p=>p.sl===100));
 assert.ok(e.pendingExits().length>=3);
 now+=100;e.settleExits('ETHUSD',{receivedAt:now,exchangeAt:now,bids:[{price:99.4,size:1e6}],asks:[{price:99.6,size:1e6}]},now);
 const closed=db.all<any>('SELECT * FROM positions WHERE status=\'closed\'');assert.ok(closed.length>=3);
 assert.ok(closed.every(p=>p.exit_price===99.4&&p.fees>0),'no author-level phantom stop fills');
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.ok(db.all<any>('SELECT evidence_scope FROM positions').every(p=>p.evidence_scope==='experiment'));
 assert.equal(JSON.stringify([cfg.paper,cfg.risk,cfg.execution]),protectedSettings);
});


test('authorized 34-plan rollout preserves all 30 existing experiments, never enables account scanners and refuses overflow or edits',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lifecycle-rollout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;
 raw.executionPlans=Array.from({length:30},(_,i)=>({id:`existing-${i}`,revision:1,enabled:true,scannerId:'control',symbol:'BTCUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));const original=fs.readFileSync(file,'utf8');
 assert.ok(MAX_RESEARCH_PLANS>=34);assert.equal(enableLifecycleShadow(file,true).totalPlans,34);assert.equal(fs.readFileSync(file,'utf8'),original);
 assert.equal(enableLifecycleShadow(file).changed,true);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual(next.executionPlans.slice(0,30),raw.executionPlans);
 assert.deepEqual({...next,executionPlans:raw.executionPlans},raw);
 assert.equal(enableLifecycleShadow(file).changed,false);
 const cfg=new ConfigStore(file).get();
 for(const p of LIFECYCLE_SHADOW_PLANS){assert.equal(cfg.scanners[p.scannerId].enabled,false);assert.equal(planSnapshot(cfg,p).paper.marginPerTrade,150);}
 next.executionPlans[33].label='operator edit';fs.writeFileSync(file,JSON.stringify(next));
 assert.throws(()=>enableLifecycleShadow(file),/will not be overwritten/);
 next.executionPlans=Array.from({length:MAX_RESEARCH_PLANS-3},(_,i)=>({...raw.executionPlans![0],id:`occupied-${i}`}));fs.writeFileSync(file,JSON.stringify(next));
 assert.throws(()=>enableLifecycleShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)));assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),next);
 raw.scanners[ids[0]]={enabled:true,symbols:null,timeframes:null,exitMode:'both'};fs.writeFileSync(file,JSON.stringify(raw));
 assert.throws(()=>enableLifecycleShadow(file),/Reviewed profile differs/);
});
