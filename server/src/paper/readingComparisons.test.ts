import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {planSnapshot,planScannerId} from './executionPlans.ts';
import {READER_COMPARISONS,ACTIVE_READER_COMPARISONS,enableReaderComparisons} from '../../../ops/enable-reader-comparisons.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
const T=1_800_000_000_000,H=900000;
function setup(t:any,family='impulse'){
 const db=new Db(':memory:');t.after(()=>db.db.close());let at=T;
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';cfg.incubator.enabled=true;
 Object.assign(cfg.paper,{marginPerTrade:150,initialEquity:1000,sizingMode:'margin',maxStopLossPct:3,latencyMs:100,fillSource:'tape',maxSignalAgeSec:0,minRiskFeeRatio:0,useSpread:false,requireQuote:false,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,liquidation:false,limitEntry:undefined,trailAfterR:0,floorAtR:0,trendExit:undefined,earlyStall:undefined,skipScriptStops:true,trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'}});
 cfg.paper.marginLeverage={base:5,strong:5,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05};
 for(const d of READER_COMPARISONS)cfg.scanners[d.scannerId]={enabled:false,symbols:null,timeframes:null,exitMode:'both',entryProtection:'atr'};
 cfg.scanners['trend-impulse-channels-zeiierman'].sides={'upper retest':'long','lower retest':'short'};
 cfg.executionPlans=structuredClone(READER_COMPARISONS.filter(p=>p.comparison!.group===`reader-${family}-eth-15m`));
 const e=new PaperEngine(db,()=>cfg,{book:2,now:()=>at});e.causalExits=true;e.sourceHashFor=()=> 'source';
 const svc=new PlanComparisons(db,()=>cfg,e,()=> 'source');
 const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:102,low:98,close:100,volume:100}));
 const input:ComparisonScan={scannerId:cfg.executionPlans[0].scannerId,scannerName:family,symbol:'ETHUSD',tf:'15m',patched:'plotshape(x)',since:bars.at(-1)!.time,newLabelKeys:new Set(),bars,market:{tickSize:.01,contractValue:.01},at:T,refPrice:100,refusal:()=>null,result:{id:1,ok:true,ms:2,bars:60,lastBarTime:bars.at(-1)!.time,warnings:0,alerts:[],shapes:[],labels:[],plots:[]}};
 const shape=(title:string)=>({title,times:[bars.at(-1)!.time]});
 return {cfg,db,e,svc,input,shape,setAt:(n:number)=>at=n,fill:()=>{at=T+200;e.onTrade('ETHUSD',100,1e6,at,at);}};
}
test('raw output reaches both reading versions with opposite native directions; one run and no account qualification',t=>{
 const x=setup(t);x.input.result.shapes=[x.shape('Upper Retest')];x.svc.observeScan(x.input);x.svc.observeScan(x.input);x.fill();
 const ps=x.e.openPositions();assert.equal(ps.length,2);assert.deepEqual(new Set(ps.map(p=>p.side)),new Set(['long','short']));
 for(const p of ps){assert.equal(p.executionPlan!.executionVersion,211);assert.equal(p.executionPlan!.paper.marginPerTrade,150);assert.ok(p.riskAmount<=30);assert.equal(x.e.exitExecution.state(p.id)!.market_qty,p.qty);}
 assert.equal(x.db.get<any>('SELECT count(*) n FROM execution_plan_scans')!.n,2);
 assert.equal(x.svc.view().comparisons[0].sharedSignals,1,'opposite readings of one marker are a paired observation');
 assert.equal(x.db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
 assert.ok(x.db.all<any>('SELECT evidence_scope FROM positions').every(p=>p.evidence_scope==='experiment'));
});
test('both ML RSI flip directions stay off in candidate while confirmed entries and control remain visible',t=>{
 const x=setup(t,'ml-rsi');x.input.result.shapes=[x.shape('ST Flip Up'),x.shape('ST Flip Dn')];x.svc.observeScan(x.input);x.fill();
 assert.equal(x.e.openPositions().length,1);assert.equal(x.e.openPositions()[0].executionPlan!.comparison!.role,'control');
 const view=x.svc.view();assert.equal(view.cohorts.find(p=>p.comparison?.role==='candidate')!.scans,1);
 const y=setup(t,'ml-rsi');y.input.result.shapes=[y.shape('Long')];y.svc.observeScan(y.input);y.fill();assert.equal(y.e.openPositions().length,2);
 x.cfg.executionPlans![1].readingOverride!.sides={};assert.ok(validateConfig(x.cfg).some(e=>e.includes('flip markers')));
});
test('cluster candidate reads only vote markers; a blocked control event does not starve it',t=>{
 const x=setup(t,'cluster');x.input.result.shapes=[x.shape('Base ST Long')];x.svc.observeScan(x.input);x.fill();assert.equal(x.e.openPositions().length,1);
 const y=setup(t,'cluster');y.cfg.executionPlans![0].readingOverride!.labels=['Base ST Long'];y.input.result.shapes=[y.shape('Major Short')];y.svc.observeScan(y.input);y.fill();assert.equal(y.e.openPositions().length,1);assert.equal(y.e.openPositions()[0].executionPlan!.comparison!.role,'candidate');
});
test('equivalent classifier and cluster entries pair across alert and shape channels without merging flip markers',t=>{
 for(const side of ['Long','Short']){
  const x=setup(t,'ml-rsi'),bar=x.input.bars.at(-1)!.time;
  x.input.result.alerts=[{type:'alert',time:bar,barIndex:59,message:`${side==='Long'?'🟢':'🔴'} ${side.toUpperCase()} | Rank 90 / Conf 90`},
   {type:'alertcondition',title:`${side} Signal`,message:'Classifier entry',time:bar,barIndex:59}];
  x.input.result.shapes=[x.shape(side)];x.svc.observeScan(x.input);x.fill();
  assert.equal(x.e.openPositions().length,2);
  assert.equal(x.svc.view().comparisons[0].sharedSignals,1,'one classifier entry, two reporting channels');
  const y=setup(t,'cluster');
  y.input.result.alerts=[{type:'alertcondition',title:side,message:'Clustered SuperTrend signal',time:bar,barIndex:59}];
  y.input.result.shapes=[y.shape(`Major ${side}`)];y.svc.observeScan(y.input);y.fill();
  assert.equal(y.e.openPositions().length,2);
  assert.equal(y.svc.view().comparisons[0].sharedSignals,1,'one vote, condition and shape');
 }
 const z=setup(t,'cluster');z.cfg.executionPlans![0].readingOverride!.labels=['Base ST Long'];
 z.input.result.shapes=[z.shape('Base ST Long'),z.shape('Major Long')];z.svc.observeScan(z.input);z.fill();
 assert.equal(z.e.openPositions().length,2);
 assert.equal(z.svc.view().comparisons[0].sharedSignals,0,'a base flip is not a cluster vote even on the same side and bar');
 assert.equal(z.svc.view().comparisons[0].controlOnly,1);assert.equal(z.svc.view().comparisons[0].candidateOnly,1);
});
test('each raw-reading arm passes the same side-aware admission gates',t=>{
 const x=setup(t);x.input.result.shapes=[x.shape('Upper Retest')];const seen:string[]=[];
 x.input.refusal=ev=>{seen.push(ev.side!);return 'market: unavailable';};x.svc.observeScan(x.input);
 assert.deepEqual(seen,['long','short']);assert.equal(x.e.pendingEntries().length,0);assert.equal(x.e.openPositions().length,0);
 assert.ok(x.svc.view().cohorts.every(c=>c.reasons['market: unavailable']===1));
});
test('new comparison stops wait for causal depth, survive restart, retain partial exposure and do not invent liquidity',t=>{
 const x=setup(t);x.input.result.shapes=[x.shape('Upper Retest')];x.svc.observeScan(x.input);x.fill();
 const long=x.e.openPositions().find(p=>p.side==='long')!;x.setAt(T+300);x.e.onTrade('ETHUSD',80,1e6,T+300,T+300);
 assert.equal(long.status,'open');assert.equal(x.e.pendingExits().length,1);
 const snap={receivedAt:T+400,exchangeAt:T+400,bids:[{price:79,size:1}],asks:[{price:80,size:1}]};
 assert.equal(x.e.settleExits('ETHUSD',snap,T+399),0);assert.equal(x.e.settleExits('ETHUSD',null,T+400),0);
 x.e.settleExits('ETHUSD',snap,T+400);assert.equal(long.qtyOpen,long.qty-1);
 const reload=new PaperEngine(x.db,()=>x.cfg,{book:2,now:()=>T+500});reload.causalExits=true;
 reload.settleExits('ETHUSD',snap,T+500);assert.equal(reload.position(long.id)!.qtyOpen,long.qty-1);
 reload.settleExits('ETHUSD',{...snap,receivedAt:T+600,exchangeAt:T+600,bids:[{price:78,size:1e6}]},T+600);
 assert.equal(reload.position(long.id)!.status,'closed');assert.ok(reload.position(long.id)!.exitPrice!<80);
 assert.ok(x.db.all<any>("SELECT * FROM orders WHERE position_id=? AND reason!='entry'",long.id).every(o=>o.price_source==='depth'));
});
test('fixed Liquidity Trail closes the long only in candidate, and retired arms retain their frozen exit reading',t=>{
 const x=setup(t,'liquidity');x.input.result.shapes=[];x.input.result.alerts=[{type:'alert',time:x.input.bars.at(-1)!.time,barIndex:59,message:'LONG | Price: 100'}];x.svc.observeScan(x.input);x.fill();
 assert.equal(x.e.openPositions().length,2);x.cfg.executionPlans!.forEach(p=>p.enabled=false);
 x.input.at=T+300;x.input.result.alerts=[{type:'alert',time:x.input.bars.at(-1)!.time,barIndex:59,message:'REVERSAL | Long → Short'}];x.svc.observeScan(x.input);
 assert.equal(x.e.pendingExits().length,1);const p=x.e.position(x.e.pendingExits()[0].position_id)!;assert.equal(p.executionPlan!.comparison!.role,'candidate');
});
test('old plan cohorts keep historical execution while new signatures explicitly include the model',t=>{
 const x=setup(t);const p=planSnapshot(x.cfg,x.cfg.executionPlans![0],'source');const old=structuredClone(p);delete old.executionVersion;
 const d=x.e.onEntry({kind:'entry',side:'long',price:100,tp:[],label:'Long',message:'',source:'shape',barTime:T-H,barIndex:59},{scannerId:planScannerId(p),scannerName:'old',symbol:'ETHUSD',tf:'15m',market:x.input.market,at:T,refPrice:100,atr:4,exitMode:'both',signalId:null,executionPlan:old});x.fill();
 const pos=x.e.position(d.pendingId!)!;assert.ok(pos);assert.equal(x.e.exitExecution.state(pos.id),undefined);
 x.e.onTrade('ETHUSD',80,1e6,T+300,T+300);assert.equal(pos.status,'closed');assert.equal(x.e.pendingExits().length,0);
});
test('unrelated scanner allocation changes cannot split a reading cohort or freeze it behind a held version',t=>{
 const x=setup(t),d=x.cfg.executionPlans![0],source=x.cfg.scanners[d.scannerId];
 const before=planSnapshot(x.cfg,d,'source');x.svc.observeScan(x.input);
 Object.assign(source,{enabled:true,hidden:true,symbols:['INITUSD'],timeframes:['4h'],pairs:[{symbol:'AINUSD',tf:'15m'}]});
 assert.equal(planSnapshot(x.cfg,d,'source').signature,before.signature,'allocation is not interpretation or execution');
 x.input.at+=H;x.input.bars=x.input.bars.map(b=>({...b,time:b.time+H}));x.input.since=x.input.bars.at(-1)!.time;
 x.svc.observeScan(x.input);assert.equal(x.svc.view().cohorts.length,2);assert.ok(x.svc.view().cohorts.every(c=>c.scans===2));
 source.sides={'upper retest':'short'};assert.notEqual(planSnapshot(x.cfg,d,'source').signature,before.signature,'real reading changes remain isolated');
 assert.notEqual(planSnapshot(x.cfg,d,'new-source').signature,planSnapshot(x.cfg,d,'source').signature);
 const sameReading=planSnapshot(x.cfg,d,'source').signature;x.cfg.paper.minRiskFeeRatio+=1;
 assert.notEqual(planSnapshot(x.cfg,d,'source').signature,sameReading,'economics changes remain isolated');
});
test('rollout adds exactly eight arms, preserves every existing setting and is idempotent',t=>{
 const x=setup(t);x.cfg.executionPlans=[];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reader-rollout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(x.cfg));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableReaderComparisons(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);enableReaderComparisons(file);const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(next.executionPlans.length,8);delete next.executionPlans;const old=JSON.parse(before);delete old.executionPlans;assert.deepEqual(next,old);assert.equal(enableReaderComparisons(file).changed,false);
 for(const d of READER_COMPARISONS){const p=planSnapshot(x.cfg,d);assert.equal(p.paper.marginPerTrade,150);assert.equal(p.paper.maxStopLossPct,3);}
});
test('active-market rollout replaces only the unedited ETH arms, keeps eight plans and never duplicates a comparison',t=>{
 const x=setup(t);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reader-markets-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');
 const unrelated={id:'unrelated',revision:1,enabled:false,scannerId:'unrelated',symbol:'BTCUSD',tf:'1h',variant:'current',referenceEquity:1000};
 x.cfg.executionPlans=[unrelated as any,...structuredClone(READER_COMPARISONS)];fs.writeFileSync(file,JSON.stringify(x.cfg));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableReaderComparisons(file,true,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 enableReaderComparisons(file,false,true);const next=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(next.executionPlans.length,9);assert.deepEqual(next.executionPlans[0],unrelated);
 assert.deepEqual(next.executionPlans.slice(1),ACTIVE_READER_COMPARISONS);
 const protectedBefore=JSON.parse(before);delete protectedBefore.executionPlans;delete next.executionPlans;assert.deepEqual(next,protectedBefore);
 assert.equal(enableReaderComparisons(file,false,true).changed,false);
 assert.throws(()=>enableReaderComparisons(file),/already relocated/);
 const edited=JSON.parse(before);edited.executionPlans[1].referenceEquity=2000;fs.writeFileSync(file,JSON.stringify(edited));
 assert.throws(()=>enableReaderComparisons(file,false,true),/differs; no overwrite/);
 for(const p of ACTIVE_READER_COMPARISONS){const s=planSnapshot(x.cfg,p);assert.equal(s.paper.marginPerTrade,150);assert.equal(s.paper.maxStopLossPct,3);}
});
test('both Liquidity maker readings require a fresh post-placement trade-through and pay maker fees only at the fill',t=>{
 const x=setup(t,'liquidity');x.cfg.scanners[x.input.scannerId].entryLimit={tfs:['15m'],atr:.1,minutes:5};
 x.cfg.paper.limitFill='through';x.cfg.paper.feeRatePct=.05;x.cfg.paper.makerFeeRatePct=.02;x.cfg.paper.feeTaxPct=18;
 x.input.result.alerts=[{type:'alert',time:x.input.bars.at(-1)!.time,barIndex:59,message:'LONG | Price: 100'}];
 x.svc.observeScan(x.input);assert.equal(x.e.pendingEntries().length,2);assert.equal(x.e.openPositions().length,0);
 assert.equal(x.db.get<any>('SELECT count(*) n FROM orders')!.n,0);
 const price=x.e.pendingEntries()[0].limit!.price;
 x.setAt(T+200);x.e.onTrade('ETHUSD',price-.01,1e6,T-1,T+200);assert.equal(x.e.openPositions().length,0,'pre-placement tape cannot fill');
 x.e.onTrade('ETHUSD',price,1e6,T+200,T+200);assert.equal(x.e.openPositions().length,0,'touch is not through');
 x.setAt(T+300);x.e.onTrade('ETHUSD',price-.01,1e6,T+300,T+300);assert.equal(x.e.openPositions().length,2);
 for(const p of x.e.openPositions()){assert.equal(p.entryPrice,price);assert.equal(p.entryAt,T+300);assert.ok(p.fees>0);assert.ok(p.riskAmount<=30);}
 assert.equal(x.svc.view().comparisons[0].sharedSignals,1);assert.ok(x.svc.view().cohorts.every(c=>c.filled===1));
});

import {ShadowRunner} from '../incubator/shadow.ts';
test('ShadowRunner dispatches raw vote markers once even when the baseline reader discards every entry',async t=>{
 const x=setup(t,'cluster');t.mock.method(Date,'now',()=>T);
 x.cfg.risk.regime.enabled=false;
 x.cfg.scanners[x.input.scannerId].labels=['Base ST Long'];
 x.input.result.shapes=[x.shape('Major Short')];
 const store={list:()=>[],liveMarks:()=>({}),setLiveMarks:()=>{},shadowFunnel:()=>({})};
 let runs=0,depths=0;const scans:any[]=[];x.e.prepareEntryDepth=async()=>{depths++;};
 const runner=new ShadowRunner({store,cfgRef:()=>x.cfg,paper:x.e,registry:{get:()=>({id:x.input.scannerId,name:'cluster',status:'ok',patched:x.input.patched})},
  pool:{size:2,reserved:1,stats:{},run:async()=>{runs++;return x.input.result;}},candles:{has:()=>true,get:()=>x.input.bars},marketInfo:async()=>x.input.market,
  compareScan:(scan:any)=>{scans.push(scan);x.svc.observeScan(scan);}} as any);
 t.after(()=>runner.stop());await runner.sync();assert.equal(runner.active.length,1);
 assert.equal((runner as any).dispatch.opts.timely({r:runner.active[0]}),true,'use existing bounded research turns');
 await (runner as any).run(runner.active[0],T);x.fill();
 assert.equal(runs,1);assert.equal(depths,1);assert.equal(scans.length,1);assert.equal(x.svc.view().cohorts.length,2);
 const positions=x.e.openPositions();assert.equal(positions.length,1);assert.equal(positions[0].executionPlan!.comparison!.role,'candidate');
 assert.equal(x.db.get<any>('SELECT evidence_scope FROM positions WHERE id=?',positions[0].id)!.evidence_scope,'experiment');
});

test('held readings cannot take script exits from a replacement source',t=>{
 const x=setup(t,'liquidity');x.input.result.alerts=[{type:'alert',time:x.input.bars.at(-1)!.time,barIndex:59,message:'LONG | Price: 100'}];
 x.svc.observeScan(x.input);x.fill();assert.equal(x.e.openPositions().length,2);
 x.cfg.executionPlans!.forEach(p=>p.enabled=false);
 const replacement=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'changed-source');
 x.input.result.alerts=[{type:'alert',time:x.input.bars.at(-1)!.time,barIndex:59,message:'REVERSAL | Long → Short'}];
 replacement.observeScan(x.input);assert.equal(x.e.pendingExits().length,0);assert.equal(x.e.openPositions().length,2);
});
