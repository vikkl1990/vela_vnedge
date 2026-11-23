import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG, validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {SETUP_LIFECYCLE, invalidatesSetup} from './setupLifecycle.ts';
import {planSnapshot, planScannerId, planBacktest, type ExecutionPlan} from './executionPlans.ts';
import {PlanComparisons} from './planComparisons.ts';
import type {ScanEvent, Side} from '../scanners/extractor.ts';
import {ShadowRunner} from '../incubator/shadow.ts';
import {SetupExitInbox} from './setupExitInbox.ts';

const T = 1_800_000_000_000, H = 900_000;
const exitEvent = {barTime:T-H, source:'alert' as const, label:'Author invalidation'};

function fixture(t:TestContext, lifecycle=true, limit=false) {
  const db=new Db(':memory:');t.after(()=>db.db.close());
  const cfg=structuredClone(DEFAULT_CONFIG);let now=T;
  cfg.execution.mode='paper';
  Object.assign(cfg.paper,{initialEquity:1000,sizingMode:'margin',marginPerTrade:150,
    marginLeverage:{base:5,strong:10,weak:5,minTrades:20,lookback:30,strongAboveR:.05,weakBelowR:-.05},
    latencyMs:100,fillSource:'tape',requireQuote:false,useSpread:false,slippageBps:0,
    quotedSlippageBps:0,depthUsdPerBp:0,maxSignalAgeSec:0,minRiskFeeRatio:6,
    skipScriptStops:false,maxStopLossPct:3,liquidation:false,trailAfterR:0,floorAtR:0,
    tpSplit:[0,0,1],breakEvenAfterTp1:false,allowReversal:false,reversalMinR:.5,
    trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'},
    limitEntry:limit?{enabled:true,tfs:['15m'],books:['account'],atr:0,bars:2}:undefined});
  cfg.scanners.s={enabled:false,symbols:null,timeframes:null,exitMode:'both',reader:2};
  const plan:ExecutionPlan={id:'lifecycle-test',revision:1,enabled:true,scannerId:'s',symbol:'ETHUSD',tf:'15m',
    variant:'current',referenceEquity:1000,readingOverride:{version:1,reader:2},
    ...(lifecycle?{setupLifecycle:SETUP_LIFECYCLE}:{})};
  cfg.executionPlans=[plan];
  const snapshot=planSnapshot(cfg,plan,'pinned-source'),id=planScannerId(snapshot);
  let engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;
  const entry=(side:Side='long', patch:Partial<ScanEvent>={})=>{
    const event:ScanEvent={kind:'entry',side,price:100,sl:side==='long'?95:105,tp:side==='long'?[115]:[85],
      barTime:T-2*H,barIndex:0,label:'Author entry',message:'',source:'alert',...patch};
    return engine.onEntry(event,{scannerId:id,scannerName:'test',symbol:'ETHUSD',tf:'15m',
      market:{contractValue:1,tickSize:.01},atr:2,refPrice:100,at:now,signalId:null,exitMode:'both',executionPlan:snapshot});
  };
  const tick=(at:number,price=100,qty=1000)=>{now=at;engine.onTrade('ETHUSD',price,qty,at,at,`tick-${at}`);};
  const settle=(at:number,size=1000,price=99)=>{now=at;return engine.settleExits('ETHUSD',{
    receivedAt:at,exchangeAt:at,bids:[{price,size}],asks:[{price:price+.1,size}]},at);};
  const exit=(type:'close'|'flip'|'tp1'|'stop_update'='close',side:Side='long',event=exitEvent)=>
    engine.onScriptExit(id,'ETHUSD','15m',type,type==='stop_update'?96:undefined,now,'both',side,undefined,event);
  const restart=()=>{engine=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});engine.causalExits=true;};
  return {db,cfg,plan,snapshot,id,entry,tick,settle,exit,restart,get e(){return engine;},at:(at:number)=>{now=at;}};
}

function sourceClose(x:ReturnType<typeof fixture>,service:PlanComparisons,at:number,message='TRADE CLOSED LONG') {
  x.at(at);
  const b={time:T-H,open:100,high:101,low:99,close:100,volume:100};
  service.observeScan({scannerId:'s',scannerName:'test',symbol:'ETHUSD',tf:'15m',bars:[b],market:{contractValue:1,tickSize:.01},
    at,refPrice:100,patched:'alert("entry")',since:T-H,newLabelKeys:new Set(),refusal:()=>null,
    result:{alerts:[{type:'alert',barIndex:0,message,time:T-H}],shapes:[],plots:[],labels:[]} as any});
}

test('confirmed close survives a rejected replacement and fills only at post-arrival depth',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);const p=x.e.openPositions()[0];
  x.at(T+200);x.exit('flip');assert.equal(p.status,'open');
  const d=x.entry('short',{sl:100.01});
  assert.equal(d.action,'rejected');assert.match(d.reason!,/independent close retained.*fees/);
  assert.equal(x.e.pendingExits().length,1);
  assert.equal(x.settle(T+299),0);assert.equal(p.qtyOpen,p.qty);
  assert.equal(x.settle(T+300,1000,98),1);
  assert.equal(p.status,'closed');assert.equal(p.exitPrice,98);
  assert.equal(p.exitReason,'script_flip');assert.equal(x.e.openPositions().length,0);
  assert.ok(p.fees>0,'the exit pays actual configured fees');
});

test('replacement waits for complete close, including partial depth, without a reversal profit threshold',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);const p=x.e.openPositions()[0];
  x.at(T+200);x.exit();const d=x.entry('short');
  assert.equal(d.action,'pending');assert.ok(p.qty>1);
  x.tick(T+300);assert.equal(x.e.openPositions().length,1);
  x.settle(T+300,1,99);assert.equal(p.qtyOpen,p.qty-1);
  x.tick(T+301);assert.equal(x.e.openPositions().length,1);
  x.settle(T+400,1000,99);assert.equal(p.status,'closed');
  x.tick(T+401);const replacement=x.e.openPositions()[0];
  assert.equal(replacement.side,'short');assert.equal(replacement.entryAt,T+401);
  assert.equal(p.fills.slice(1).reduce((n,f)=>n+f.qty,0),p.qty);
  assert.ok(replacement.riskAmount<=30);
});

test('an opposite entry alone never invalidates an existing setup',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);const p=x.e.openPositions()[0];x.at(T+200);
  assert.match(x.entry('short').reason!,/reversal disabled/);
  assert.equal(x.e.pendingExits().length,0);assert.equal(p.status,'open');
});

test('confirmed exit cancels a resting setup durably; no later tick or restart can fill it',t=>{
  const x=fixture(t,true,true);const d=x.entry();assert.equal(d.action,'pending');
  x.at(T+200);x.exit();assert.equal(x.e.pendingEntries().length,0);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,1);
  x.restart();x.tick(T+300,90);assert.equal(x.e.openPositions().length,0);
  assert.equal(x.e.position(d.pendingId!),undefined);
});

test('legacy controls retain their pending order and evidence signature',t=>{
  const x=fixture(t,false,true),baseline=planSnapshot(x.cfg,x.plan,'pinned-source');x.entry();
  x.at(T+200);x.exit();assert.equal(x.e.pendingEntries().length,1);
  assert.equal(planSnapshot(x.cfg,x.plan,'pinned-source').signature,baseline.signature);
  assert.notEqual(planSnapshot(x.cfg,{...x.plan,setupLifecycle:SETUP_LIFECYCLE},'pinned-source').signature,baseline.signature);
});

test('wrong-side, stale, future and partial notifications do not invalidate pending orders',t=>{
  const x=fixture(t,true,true);x.entry();
  x.at(T+200);x.exit('close','short');assert.equal(x.e.pendingEntries().length,1);
  x.at(T-1);x.exit();assert.equal(x.e.pendingEntries().length,1);
  x.at(T+200);x.exit('close','long',{...exitEvent,barTime:T});assert.equal(x.e.pendingEntries().length,1);
  x.exit('close','long',{...exitEvent,barTime:T-3*H});assert.equal(x.e.pendingEntries().length,1);
  x.exit('tp1');x.exit('stop_update');assert.equal(x.e.pendingEntries().length,1);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
  for(const milestone of ['tp1','tp2','tp3','stop_update'] as const)assert.equal(invalidatesSetup(milestone),false);
});

test('duplicate source exit after restart cannot close a later trade',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);x.at(T+200);x.exit();x.settle(T+300);
  x.at(T+400);x.entry();x.tick(T+500);const next=x.e.openPositions()[0];x.restart();
  x.at(T+600);x.exit();assert.equal(x.e.pendingExits().length,0);
  assert.equal(x.e.position(next.id)!.status,'open');
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,1);
});

for(const limit of [false,true])test(`same-bar or older exits cannot affect a newer ${limit?'pending setup':'held position'}`,t=>{
  const x=fixture(t,true,limit);x.entry();if(!limit)x.tick(T+100);x.at(T+200);
  for(const barTime of [T-3*H,T-2*H])for(const type of ['close','tp1','stop_update'] as const)x.exit(type,'long',{...exitEvent,barTime,label:`old-${barTime}`});
  assert.equal(x.e.pendingExits().length,0);
  assert.equal(limit?x.e.pendingEntries().length:x.e.openPositions().length,1);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
  if(!limit)assert.equal(x.e.view(x.e.openPositions()[0]).execution!.desiredStop,null);
});

test('failed close request rolls back receipt, maker cancellation, position and observer events',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);const p=x.e.openPositions()[0];x.at(T+200);
  x.db.db.exec("CREATE TRIGGER fail_close BEFORE INSERT ON paper_exit_intents BEGIN SELECT RAISE(ABORT,'injected close failure'); END");
  let updates=0;x.e.on('position',()=>updates++);
  assert.throws(()=>x.exit(),/injected close failure/);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
  assert.equal(p.status,'open');assert.equal(updates,0);assert.equal(x.e.pendingExits().length,0);
  x.db.db.exec('DROP TRIGGER fail_close');x.exit();assert.equal(x.e.pendingExits().length,1);
});

test('lifecycle plans cannot run on the account, an unpinned source, a noncausal adapter or candle replay',t=>{
  const x=fixture(t);const account=new PaperEngine(x.db,()=>x.cfg,{now:()=>T});account.causalExits=true;
  const ev:ScanEvent={kind:'entry',side:'long',sl:95,tp:[115],barTime:T-H,barIndex:0,label:'entry',message:'',source:'alert'};
  const ctx={scannerId:x.id,scannerName:'test',symbol:'ETHUSD',tf:'15m',market:{contractValue:1,tickSize:.01},refPrice:100,at:T,signalId:null,exitMode:'both' as const,executionPlan:x.snapshot};
  assert.match(account.onEntry(ev,ctx).reason!,/wrong book/);
  x.e.causalExits=false;assert.match(x.entry().reason!,/causal paper shadow/);
  assert.throws(()=>planSnapshot(x.cfg,x.plan,null),/pinned source/);
  assert.throws(()=>planBacktest(x.snapshot),/causal event\/tick\/depth/);
  assert.deepEqual(validateConfig(x.cfg).filter(e=>e.includes('executionPlans')),[]);
  x.cfg.scanners.s.exitMode='levels';assert.ok(validateConfig(x.cfg).some(e=>e.includes('setup lifecycle')));
});

test('paired lifecycle validation refuses an entry, risk or enabled-state difference',t=>{
  const x=fixture(t);const control={...x.plan,id:'control',setupLifecycle:undefined,comparison:{group:'lifecycle',role:'control' as const,kind:'setup-lifecycle' as const}};
  const candidate={...x.plan,id:'candidate',comparison:{group:'lifecycle',role:'candidate' as const,kind:'setup-lifecycle' as const}};
  x.cfg.executionPlans=[control,candidate];assert.deepEqual(validateConfig(x.cfg).filter(e=>e.includes('executionPlans')),[]);
  candidate.referenceEquity=2000;assert.ok(validateConfig(x.cfg).some(e=>e.includes('lifecycle arms')));
  candidate.referenceEquity=1000;candidate.enabled=false;assert.ok(validateConfig(x.cfg).some(e=>e.includes('lifecycle arms')));
});

test('lifecycle comparison reports only closed identical entries and never grants promotion',t=>{
  const x=fixture(t);
  x.cfg.executionPlans=[
    {...x.plan,id:'control',setupLifecycle:undefined,comparison:{group:'lifecycle',kind:'setup-lifecycle',role:'control'}},
    {...x.plan,id:'candidate',comparison:{group:'lifecycle',kind:'setup-lifecycle',role:'candidate'}}];
  assert.deepEqual(validateConfig(x.cfg).filter(e=>e.includes('executionPlans')),[]);
  const service=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  sourceClose(x,service,T,'LONG | Entry:100 | SL:95 | TP1:115');x.tick(T+100);
  const positions=x.e.openPositions();assert.equal(positions.length,2);
  assert.equal(service.view().comparisons[0].matchedDeltaNet,null);
  x.at(T+200);for(const p of positions)x.e.closeManual(p.id,'manual',T+200);
  x.settle(T+300,1000,101);
  let result=service.view().comparisons[0];
  assert.equal(result.kind,'setup-lifecycle');assert.equal(result.matchedClosed,1);
  assert.equal(result.matchedDeltaNet,0);assert.equal(result.promotionEligible,false);
  const candidate=positions.find(p=>p.executionPlan!.id==='candidate')!;
  x.db.run('UPDATE positions SET entry_price=entry_price+.1 WHERE id=?',candidate.id);
  result=service.view().comparisons[0];assert.equal(result.matchedEntryMismatch,1);
  assert.equal(result.matchedClosed,0);assert.equal(result.matchedDeltaNet,null);
});

test('the comparison dispatcher supplies exits to pending-only retired readings',t=>{
  const x=fixture(t,true,true);x.entry();x.cfg.executionPlans![0].enabled=false;
  const service=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  sourceClose(x,service,T+200);
  assert.equal(x.e.pendingEntries().length,0);
});

test('the actual shadow runner scans a retired pending reading and forwards its invalidation',async t=>{
  t.mock.timers.enable({apis:['Date'],now:T+200});
  const x=fixture(t,true,true);x.entry();x.cfg.executionPlans![0].enabled=false;
  x.cfg.incubator.enabled=true;x.cfg.incubator.mirror={enabled:false};
  const comparisons=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  const bars=Array.from({length:60},(_,i)=>({time:T-(60-i)*H,open:100,high:101,low:99,close:100,volume:100}));
  const scanner={id:'s',name:'test',status:'ok',patched:'alert("entry")'};
  const store={list:()=>[],liveMarks:()=>({}),setLiveMarks:()=>{},shadowFunnel:()=>({}),setShadowFunnel:()=>{}};
  let comparisonsRun=0;
  const runner:any=new ShadowRunner({store,cfgRef:()=>x.cfg,paper:x.e,
    registry:{get:()=>scanner},candles:{has:()=>true,get:()=>bars,scanReadiness:()=>null},
    marketInfo:async()=>({contractValue:1,tickSize:.01}),
    pool:{size:2,reserved:1,stats:{queuedLive:1},rssReader:()=>0,memoryGuardBytes:1000,
      run:async()=>({ok:true,alerts:[{type:'alert',barIndex:59,message:'TRADE CLOSED LONG',time:T-H}],shapes:[],labels:[],plots:[],ms:1})},
    compareScan:(input:any)=>{comparisonsRun++;comparisons.observeScan(input);}} as any);
  t.after(()=>runner.stop());await runner.sync();
  assert.equal(runner.active.length,1);assert.equal(runner.readingCells.has('s:ETHUSD:15m'),true);
  await runner.run(runner.active[0],T);
  assert.equal(comparisonsRun,1);assert.equal(x.e.pendingEntries().length,0);
});

for(const limit of [false,true])test(`failed ${limit?'setup cancellation':'close request'} survives scan advancement and restart`,t=>{
  const x=fixture(t,true,limit);x.entry();if(!limit)x.tick(T+100);
  const service=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  x.db.db.exec(limit
    ? "CREATE TRIGGER fail_receipt BEFORE DELETE ON positions BEGIN SELECT RAISE(ABORT,'cancel failure'); END"
    : "CREATE TRIGGER fail_receipt BEFORE INSERT ON paper_exit_intents BEGIN SELECT RAISE(ABORT,'close failure'); END");
  sourceClose(x,service,T+200);
  assert.equal(x.db.get<{status:string}>('SELECT status FROM execution_plan_exit_receipts')!.status,'pending');
  assert.equal(service.view().cohorts[0].exitDelivery!.pending,1);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
  x.db.db.exec('DROP TRIGGER fail_receipt');x.restart();
  new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  x.at(T+500);x.e.housekeeping(T+500);
  assert.equal(x.db.get<{status:string}>('SELECT status FROM execution_plan_exit_receipts')!.status,'done');
  assert.equal(service.view().cohorts[0].exitDelivery!.done,1);
  if(limit){
    assert.equal(x.e.pendingEntries().length,0);x.tick(T+600,90);assert.equal(x.e.openPositions().length,0);
  }else{
    const p=x.e.openPositions()[0];assert.equal(x.e.pendingExits()[0].trigger_at,T+500);
    assert.equal(x.settle(T+599),0);x.settle(T+600,1000,97);
    assert.equal(p.exitPrice,97);assert.equal(p.exitAt,T+600);
  }
});

test('a duplicate comparison receipt retains its original target after restart and re-entry',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);
  const service=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  sourceClose(x,service,T+200);x.settle(T+300);
  x.at(T+400);x.entry();x.tick(T+500);const next=x.e.openPositions()[0];x.restart();
  const restarted=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');sourceClose(x,restarted,T+600);
  x.e.housekeeping(T+700);assert.equal(x.e.position(next.id)!.status,'open');
  assert.equal(x.e.pendingExits().length,0);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM execution_plan_exit_receipts')!.n,1);
});

test('receipt completion failure rolls back the close intent and retries once',t=>{
  const x=fixture(t);x.entry();x.tick(T+100);
  const service=new PlanComparisons(x.db,()=>x.cfg,x.e,()=> 'pinned-source');
  x.db.db.exec("CREATE TRIGGER fail_done BEFORE UPDATE OF status ON execution_plan_exit_receipts BEGIN SELECT RAISE(ABORT,'completion failure'); END");
  sourceClose(x,service,T+200);assert.equal(x.e.pendingExits().length,0);
  assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
  x.db.db.exec('DROP TRIGGER fail_done');x.e.housekeeping(T+500);
  assert.equal(x.e.pendingExits().length,1);x.e.housekeeping(T+600);
  assert.equal(x.e.pendingExits().length,1);
});

test('failing receipts cannot starve later valid instructions beyond the bounded retry turn',t=>{
  const x=fixture(t),inbox=new SetupExitInbox(x.db);
  for(let i=0;i<21;i++)inbox.enqueue(x.id,{plan:x.snapshot,at:T,event:{
    kind:'exit',exitType:'close',side:'long',tp:[],message:'',barTime:T-H,barIndex:0,source:'alert',label:String(i)},
    targets:{positionId:null,pendingIds:[]}});
  let delivered=0;
  const apply=(receipt:Parameters<Parameters<typeof inbox.drain>[1]>[0],complete:()=>void)=>{
    if(receipt.event.label!=='20')throw Error('injected persistent failure');delivered++;complete();
  };
  inbox.drain(T+100,apply);assert.equal(delivered,0);
  inbox.drain(T+200,apply);assert.equal(delivered,1);
  assert.equal(inbox.summary().get(x.id)!.pending,20);
});

for(const rollback of [false,true])test(`partial maker invalidation preserves filled exposure${rollback?' through a failed close transaction':''}`,t=>{
  const x=fixture(t,true,true);
  const book={receivedAt:T+100,exchangeAt:T+100,bids:[{price:99.9,size:1000}],asks:[{price:100.1,size:1000}]};
  x.e.makerFillBook=()=>book;x.e.quotes={executable:(_symbol,side)=>side==='buy'?100.1:99.9};
  x.entry();x.at(T+100);x.e.observeMakerBook('ETHUSD',book,T+100);x.tick(T+200,99.8,1);
  const p=x.e.openPositions()[0];assert.ok(p);assert.equal(p.qty,1);assert.equal(x.e.pendingEntries().length,1);
  x.at(T+300);
  if(rollback){
    x.db.db.exec("CREATE TRIGGER fail_partial_close BEFORE INSERT ON paper_exit_intents BEGIN SELECT RAISE(ABORT,'partial close failure'); END");
    assert.throws(()=>x.exit(),/partial close failure/);
    assert.equal(x.e.pendingEntries().length,1);assert.equal(p.qtyOpen,1);
    assert.equal(x.db.get<{status:string}>('SELECT status FROM paper_maker_orders WHERE position_id=?',p.id)!.status,'partial');
    assert.equal(x.db.get<{n:number}>('SELECT count(*) n FROM paper_setup_exits')!.n,0);
    x.db.db.exec('DROP TRIGGER fail_partial_close');
  }
  x.exit();assert.equal(x.e.pendingEntries().length,0);assert.equal(p.status,'open');assert.equal(p.qtyOpen,1);
  assert.equal(x.e.pendingExits()[0].qty,1);x.restart();x.tick(T+350,99.8,1000);
  assert.equal(x.e.openPositions()[0].qty,1,'unfilled contracts cannot return after restart');
  x.settle(T+400,1000,99.5);const closed=x.e.position(p.id)!;
  assert.equal(closed.status,'closed');assert.equal(closed.fills.filter(f=>f.reason!=='entry').reduce((n,f)=>n+f.qty,0),1);
  assert.equal(closed.fills[0].liquidity,'maker');assert.equal(closed.fills.at(-1)!.liquidity,'taker');
});
