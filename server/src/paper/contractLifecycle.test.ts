import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {planSnapshot,planBacktest,MAX_RESEARCH_PLANS} from './executionPlans.ts';
import {backtestPolicy} from './policy.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {BREAKOUT_NATIVE,ML_RSI_NATIVE,plotPrefix} from '../scanners/plotLifecycle.ts';
import {CONTRACT_LIFECYCLE_PLANS,enableContractLifecycleShadow} from '../../../ops/enable-contract-lifecycle-shadow.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {scannerContract} from '../scanners/contracts.ts';
const T=1800000000000,H=900000;
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contract-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw,cfg:new ConfigStore(file).get()};
}
test('two native shadow plans preserve existing 34 experiments and all account, risk and evidence configuration',t=>{
 const {file,raw}=fixture(t);
 raw.executionPlans=Array.from({length:34},(_,i)=>({id:`existing-${i}`,revision:1,enabled:true,scannerId:'control',symbol:'BTCUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));const before=fs.readFileSync(file,'utf8');
 assert.ok(MAX_RESEARCH_PLANS>=36);
 assert.equal(enableContractLifecycleShadow(file,true).totalPlans,36);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableContractLifecycleShadow(file);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.deepEqual({...next,executionPlans:raw.executionPlans},raw);assert.deepEqual(next.executionPlans.slice(0,34),raw.executionPlans);
 assert.equal(enableContractLifecycleShadow(file).changed,false);
 while(next.executionPlans.length<=MAX_RESEARCH_PLANS)next.executionPlans.push({...raw.executionPlans[0],id:`overflow-${next.executionPlans.length}`});
 fs.writeFileSync(file,JSON.stringify(next));
 assert.throws(()=>enableContractLifecycleShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)));
});
test('native policy is separate, has no fallback TP, and matrix keeps the legacy gap visible',t=>{
 const {cfg}=fixture(t),registry=new ScannerRegistry();
 const before=JSON.stringify([cfg.execution,cfg.paper,cfg.risk,cfg.incubator]);
 for(const d of CONTRACT_LIFECYCLE_PLANS){
  const s=planSnapshot(cfg,d,'source');assert.equal(cfg.scanners[d.scannerId].enabled,false);
  assert.equal(s.paper.marginPerTrade,150);assert.equal(s.paper.maxStopLossPct,3);assert.equal(s.paper.minRiskFeeRatio,cfg.paper.minRiskFeeRatio);
  assert.deepEqual(s.paper.fallbackRR,[0,0,0]);assert.equal(s.paper.floorAtR,0);assert.equal(s.paper.trailAfterR,0);assert.equal(s.paper.breakEvenAfterTp1,false);
  assert.equal(planBacktest(s).scriptStopAmendments,'after-close-v1');assert.equal(backtestPolicy(cfg,d.scannerId,'15m','shadow').scriptStopAmendments,'after-close-v1');
  const source=registry.get(d.scannerId)!;
  const detail=scannerContract(source,cfg.scanners[d.scannerId],s);
  assert.equal(detail.summary.adapter,'Source-pinned lifecycle v1');assert.ok(!detail.summary.gaps.some(g=>g.startsWith('Native lifecycle parity')));
  assert.ok(scannerContract(registry.get(source.variantOf!)!,cfg.scanners[source.variantOf!]??{}).summary.gaps.some(g=>g.startsWith('Native lifecycle parity')));
 }
 assert.equal(JSON.stringify([cfg.execution,cfg.paper,cfg.risk,cfg.incubator]),before);
});
test('native entries fill once, stops amend after receipt and restart, targets retain full fees and cannot supply promotion evidence',t=>{
 const {cfg}=fixture(t);
 Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,quotedSlippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,liquidation:false,minRiskFeeRatio:6});
 cfg.executionPlans=structuredClone(CONTRACT_LIFECYCLE_PLANS);
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 let e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 let service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 const send=(id:string,values:Record<string,number>,time=T-H,refPrice=100)=>{
  const bars=Array.from({length:60},(_,i)=>({time:time-(59-i)*H,open:100,high:101,low:99,close:100,volume:1000}));
  const result:ComparisonScan['result']={id:1,ok:true,ms:1,bars:60,lastBarTime:time,warnings:0,alerts:[],shapes:[],labels:[],plots:Object.entries(values).map(([key,value])=>({title:plotPrefix+key,style:'line',overlay:true,data:[{time,value}]}))};
  const input:ComparisonScan={scannerId:id,scannerName:id,symbol:'ETHUSD',tf:'15m',patched:'source',since:time,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:now,refPrice,refusal:()=>null,result};
  service.observeScan(input);return input;
 };
 const b=send(BREAKOUT_NATIVE,{entry:1,stop:98,tp1:102,tp2:104,tp3:106});service.observeScan(b);
 const m=send(ML_RSI_NATIVE,{entry:1,stop:98,direction:1,flip:0});service.observeScan(m);
 assert.equal(e.pendingEntries().length,2);
 now=T+100;e.onTrade('ETHUSD',100,1e6,now,now,'entry');assert.equal(e.openPositions().length,2);
 const native=e.openPositions().find(p=>p.executionPlan!.sourceScannerId===ML_RSI_NATIVE)!;
 assert.deepEqual(native.tp,[]);assert.equal(native.sl,98);
 for(const p of e.openPositions()){assert.ok(p.riskAmount<=30);assert.ok(p.fills[0].fee>0);assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.equal(p.executionPlan!.paper.scalperOffer?.enabled,false);}
 now=T+H;send(ML_RSI_NATIVE,{entry:0,stop:100.5,direction:1,flip:0},T);
 assert.equal(native.sl,98,'no retroactive stop update');
 e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 now+=100;e.onTrade('ETHUSD',100.4,1e6,now,now,'stop-ack');
 assert.equal(e.pendingExits().length,1);assert.equal(e.openPositions().find(p=>p.id===native.id)!.sl,100.5);
 now+=100;e.settleExits('ETHUSD',{receivedAt:now,exchangeAt:now,bids:[{price:100.3,size:1e6}],asks:[{price:100.4,size:1e6}]},now);
 assert.equal(e.openPositions().length,1,'amended stop fills at current depth');
 now+=100;e.onTrade('ETHUSD',104,1e6,now,now,'tp2');assert.equal(e.openPositions()[0].qtyOpen,e.openPositions()[0].qty);
 now+=100;e.onTrade('ETHUSD',106.1,1e6,now,now,'tp3');
 now+=100;e.settleExits('ETHUSD',{receivedAt:now,exchangeAt:now,bids:[{price:106,size:1e6}],asks:[{price:106.1,size:1e6}]},now);
 assert.equal(e.openPositions().length,0);
 assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.ok(db.all<any>('SELECT evidence_scope FROM positions').every(p=>p.evidence_scope==='experiment'));
});
test('crossed native geometry is refused at quote and after latency without ATR substitution or target loss',t=>{
 const {cfg}=fixture(t);Object.assign(cfg.paper,{fillSource:'tape',latencyMs:100,slippageBps:0,useSpread:false,requireQuote:false,maxSignalAgeSec:0,minRiskFeeRatio:6});
 cfg.executionPlans=structuredClone(CONTRACT_LIFECYCLE_PLANS);
 const db=new Db(':memory:');t.after(()=>db.db.close());let now=T;
 const e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 const plan=planSnapshot(cfg,CONTRACT_LIFECYCLE_PLANS[0],'source'),event={kind:'entry' as const,side:'long' as const,price:100,sl:98,tp:[102,104,106],barTime:T-H,barIndex:0,label:'native',message:'native',source:'derived' as const};
 const ctx={scannerId:'test-native',scannerName:'native',symbol:'ETHUSD',tf:'15m',market:{tickSize:.01,contractValue:.01},at:T,refPrice:100,atr:1,exitMode:'both' as const,executionPlan:plan,signalId:null};
 assert.match(e.onEntry({...event,price:103},{...ctx,refPrice:103}).reason!,/native target crossed/);
 assert.match(e.onEntry({...event,price:97},{...ctx,refPrice:97}).reason!,/native stop crossed/);
 assert.match(e.onEntry({...event,tp:[102.001,102.002,106]},ctx).reason!,/native target crossed/,'tick rounding must not collapse target milestones');
 assert.equal(e.onEntry(event,ctx).action,'pending');
 now=T+100;e.onTrade('ETHUSD',103,1e6,now,now,'late');
 assert.equal(e.openPositions().length,0);assert.equal(e.pendingEntries().length,0);
});
