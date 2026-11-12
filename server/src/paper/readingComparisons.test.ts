import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {PlanComparisons,type ComparisonScan} from './planComparisons.ts';
import {planSnapshot,planScannerId} from './executionPlans.ts';
import {READER_COMPARISONS,enableReaderComparisons} from '../../../ops/enable-reader-comparisons.ts';
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
test('rollout adds exactly eight arms, preserves every existing setting and is idempotent',t=>{
 const x=setup(t);x.cfg.executionPlans=[];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reader-rollout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(x.cfg));const before=fs.readFileSync(file,'utf8');
 assert.equal(enableReaderComparisons(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);enableReaderComparisons(file);const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(next.executionPlans.length,8);delete next.executionPlans;const old=JSON.parse(before);delete old.executionPlans;assert.deepEqual(next,old);assert.equal(enableReaderComparisons(file).changed,false);
 for(const d of READER_COMPARISONS){const p=planSnapshot(x.cfg,d);assert.equal(p.paper.marginPerTrade,150);assert.equal(p.paper.maxStopLossPct,3);}
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
