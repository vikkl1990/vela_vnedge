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
import {AUTHOR_SHADOW_PLANS,enableAuthorShadow} from '../../../ops/enable-author-shadow.ts';
import {planBacktest,planSnapshot,MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {backtestPolicy} from './policy.ts';

function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'author-shadow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw};
}

test('author shadow activation is atomic, idempotent, confined to free research slots and never enables account scanners',t=>{
 const {file,raw}=fixture(t);
 raw.executionPlans=Array.from({length:25},(_,i)=>({id:`existing-${i}`,revision:1,enabled:true,scannerId:'control',symbol:'BTCUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));const original=fs.readFileSync(file,'utf8');
 const dry=enableAuthorShadow(file,true);assert.equal(dry.totalPlans,30);assert.equal(fs.readFileSync(file,'utf8'),original);
 const done=enableAuthorShadow(file);assert.equal(done.changed,true);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual({...next,executionPlans:raw.executionPlans},raw,'only experimental plans may change');
 assert.deepEqual(next.executionPlans.slice(0,25),raw.executionPlans);
 assert.equal(enableAuthorShadow(file).changed,false);
 const cfg=new ConfigStore(file).get();
 for(const p of AUTHOR_SHADOW_PLANS){
  assert.equal(cfg.scanners[p.scannerId].enabled,false);
  const version=cfg.scanners[p.scannerId].reader===3?'after-close-v1':undefined;
  assert.equal(planBacktest(planSnapshot(cfg,p,'source')).scriptStopAmendments,version);
  assert.equal(backtestPolicy(cfg,p.scannerId,p.tf,'shadow').scriptStopAmendments,version);
 }
 next.executionPlans[29].label='operator edit';fs.writeFileSync(file,JSON.stringify(next));
 assert.throws(()=>enableAuthorShadow(file),/will not be overwritten/);
 next.executionPlans=Array.from({length:MAX_RESEARCH_PLANS-4},(_,i)=>({...raw.executionPlans![0],id:`occupied-slot-${i}`}));fs.writeFileSync(file,JSON.stringify(next));
 assert.throws(()=>enableAuthorShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)),'capacity is not silently expanded');
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),next);
});

test('native author lifecycle runs in experimental shadow, retains stop acknowledgements, and never supplies promotion evidence',t=>{
 const {file}=fixture(t),cfg=new ConfigStore(file).get();
 const T=1800000000000,H=900000;
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,minRiskFeeRatio:6,liquidation:false,skipScriptStops:true});
 cfg.executionPlans=structuredClone(AUTHOR_SHADOW_PLANS.filter(p=>p.readingOverride!.reader===3));
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const paper=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});paper.causalExits=true;paper.sourceHashFor=()=> 'source';
 const service=new PlanComparisons(db,()=>cfg,paper,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 for(const p of cfg.executionPlans){
  const payload=p.scannerId.startsWith('synapse')?JSON.stringify({schema:'stp.events.v1',events:[{action:'buy',direction:1,entry:100,sl:98,tp1:102,tp2:104,tp3:106}]}):'🟢 LONG | Price: 100 | SL: 98 | TP1: 102 | TP2: 104 | TP3: 106';
  const input:ComparisonScan={scannerId:p.scannerId,scannerName:p.scannerId,symbol:'ETHUSD',tf:'15m',patched:'source',since:T-H,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:now,refPrice:100,refusal:()=>null,
   result:{id:1,ok:true,ms:1,bars:60,lastBarTime:T-H,warnings:0,alerts:[{type:'alert',time:T-H,barIndex:59,message:payload}],shapes:[],labels:[],plots:[]}};
  service.observeScan(input);service.observeScan(input);
 }
 assert.equal(paper.pendingEntries().length,3);assert.equal(paper.openPositions().length,0);
 now=T+100;paper.onTrade('ETHUSD',100,1e6,now,now);assert.equal(paper.openPositions().length,3);
 for(const p of paper.openPositions()){
  assert.equal(p.sl,98);assert.deepEqual(p.tp,[102,104,106]);assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.ok(p.riskAmount<=30);
  assert.ok(p.fills[0].fee>0);assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);
  assert.deepEqual(p.executionPlan!.paper.tpSplit,p.executionPlan!.sourceScannerId.startsWith('synapse')?[1/3,1/3,1/3]:[0,0,1]);
  paper.onScriptExit(p.scannerId,'ETHUSD','15m','stop_update',100,T+200,'both','long');assert.equal(p.sl,98);
 }
 now=T+300;paper.onTrade('ETHUSD',99.5,1e6,now,now);assert.equal(paper.pendingExits().length,3);
 assert.ok(paper.openPositions().every(p=>p.sl===100&&p.fills.length===1));
 now=T+400;paper.settleExits('ETHUSD',{receivedAt:now,exchangeAt:now,bids:[{price:99.4,size:1e6}],asks:[{price:99.6,size:1e6}]},now);
 assert.equal(paper.openPositions().length,0);
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.ok(db.all<any>('SELECT evidence_scope FROM positions').every(p=>p.evidence_scope==='experiment'));
});

test('the corrected signal readers enter isolated shadow plans with unchanged margin and risk ceilings',t=>{
 const {file}=fixture(t),cfg=new ConfigStore(file).get(),T=1800000000000,H=900000;
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,liquidation:false});
 const cases=[
  {id:'false-breakout-expo-author-signals',channel:'alertcondition',label:'False Breakout Down'},
  {id:'adaptive-smart-money-liquidity-sweep-levels-author-signals',channel:'alertcondition',label:'Lower Liquidity Wick Sweep'},
  {id:'zero-lag-ma-trend-levels-author-retests',channel:'label',label:'▲'},
  {id:'swing-failure-zones-and-signals-author-signals',channel:'shape',label:'Bullish Signal'},
  {id:'zone-shift-author-retests',channel:'label',label:'⯁'},
  {id:'breaker-blocks-with-signals-author-retests',channel:'alertcondition',label:'2. signal UP'},
 ];
 cfg.executionPlans=cases.map((c,i)=>({id:`author-followup-${i}`,revision:1,enabled:true,scannerId:c.id,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,readingOverride:{version:1}}));
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;engine.sourceHashFor=()=> 'source';
 const service=new PlanComparisons(db,()=>cfg,engine,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
 for(const c of cases){
  const result:ComparisonScan['result']={id:1,ok:true,ms:1,bars:60,lastBarTime:T-H,warnings:0,alerts:[],shapes:[],labels:[],plots:[]};
  if(c.channel==='alertcondition')result.alerts=[{type:'alertcondition',title:c.label,message:c.label,time:T-H,barIndex:59}];
  if(c.channel==='shape')result.shapes=[{title:c.label,times:[T-H]}];
  if(c.channel==='label')result.labels=[{text:c.label,style:'style_label_up',time:T-2*H,createdAt:T-H,y:100}];
  const input:ComparisonScan={scannerId:c.id,scannerName:c.id,symbol:'ETHUSD',tf:'15m',patched:'source',since:T-H,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:now,refPrice:100,refusal:()=>null,result};
  service.observeScan(input);service.observeScan(input);
 }
 assert.equal(engine.pendingEntries().length,cases.length);assert.equal(engine.openPositions().length,0);
 now=T+100;engine.onTrade('ETHUSD',100,1e6,now,now);
 assert.equal(engine.openPositions().length,cases.length);
 for(const p of engine.openPositions()){
  assert.equal(p.side,'long');assert.equal(p.executionPlan!.paper.marginPerTrade,150);
  assert.ok(p.riskAmount<=30);assert.ok(p.fills[0].fee>0);
  assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);
 }
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
});
