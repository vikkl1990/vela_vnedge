import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG,TF_SECONDS,validateConfig} from '../config.ts';
import {Db} from '../db.ts';
import {PaperEngine} from '../paper/engine.ts';
import {PlanComparisons} from '../paper/planComparisons.ts';
import {planSnapshot,validateExecutionPlans} from '../paper/executionPlans.ts';
import {eligibleEvidence} from '../evidence/trades.ts';
import {MAKER_UNIVERSE_PLANS,MAKER_UNIVERSE_CELLS} from './makerUniverseStudy.ts';
import {enableMakerUniverseStudy} from '../../../ops/enable-maker-universe-study.ts';

function config(){
  const cfg=structuredClone(DEFAULT_CONFIG);
  cfg.execution.mode='paper';cfg.execution.allowProduction=false;cfg.incubator.enabled=true;
  cfg.paper.maxStopLossPct=3;
  for(const [,id] of MAKER_UNIVERSE_CELLS)cfg.scanners[id]={enabled:false,symbols:null,timeframes:null,exitMode:'both',
    entryLimit:{tfs:['15m','1h','4h'],atr:.1,minutes:5}};
  return cfg;
}
test('maker universe activation is atomic, idempotent, dry-runnable and changes only shadow plans',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maker-universe-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json'),cfg=config();fs.writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
  const before=fs.readFileSync(file,'utf8');
  assert.equal(enableMakerUniverseStudy(file,true).added,24);assert.equal(fs.readFileSync(file,'utf8'),before);
  enableMakerUniverseStudy(file);const after=fs.readFileSync(file,'utf8'),next=JSON.parse(after);
  const {executionPlans:_,...rest}=next;assert.deepEqual(rest,cfg);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  const modifiedAt=fs.statSync(file).mtimeMs;assert.equal(enableMakerUniverseStudy(file).changed,false);
  assert.equal(fs.readFileSync(file,'utf8'),after);assert.equal(fs.statSync(file).mtimeMs,modifiedAt);
  next.executionPlans[0].label='edited control';fs.writeFileSync(file,JSON.stringify(next));
  assert.throws(()=>enableMakerUniverseStudy(file),/refusing overwrite|maker arms/);
  for(const mutate of [(c:any)=>c.execution.mode='production',(c:any)=>c.execution.allowProduction=true,(c:any)=>c.paper.maxStopLossPct=0]){
    const bad=config();mutate(bad);fs.writeFileSync(file,JSON.stringify(bad));
    const bytes=fs.readFileSync(file,'utf8');assert.throws(()=>enableMakerUniverseStudy(file));assert.equal(fs.readFileSync(file,'utf8'),bytes);
  }
});
test('all twelve comparisons preserve reading, exits, fees and risk; incomplete or altered pairs fail validation',()=>{
  const cfg=config(),plans=structuredClone(MAKER_UNIVERSE_PLANS);cfg.executionPlans=plans;
  assert.deepEqual(validateConfig(cfg),[]);
  for(let i=0;i<plans.length;i+=2){
    const control=planSnapshot(cfg,plans[i],'same'),candidate=planSnapshot(cfg,plans[i+1],'same');
    assert.deepEqual(control.paper,candidate.paper);assert.deepEqual(control.reading,candidate.reading);
    assert.equal(control.paper.maxStopLossPct,3);assert.equal(candidate.paper.marginPerTrade,cfg.paper.marginPerTrade);
    assert.equal(candidate.paper.scalperOffer?.enabled,false);assert.notEqual(control.signature,candidate.signature);
    for(const edit of [{makerFill:'tick-depth-v1'},{referenceEquity:2000},{enabled:false},{trailing:{afterR:.1,giveBackPct:10,floorAtR:0,floorKeepR:0}}]){
      assert.ok(validateExecutionPlans([plans[i],{...plans[i+1],...edit} as any],TF_SECONDS,cfg).length);
    }
    assert.ok(validateExecutionPlans([plans[i+1]],TF_SECONDS,cfg).length);
  }
  const old=Array.from({length:111},(_,i)=>({...plans[0],id:'old-'+i,comparison:undefined}));
  assert.deepEqual(validateExecutionPlans([...old,...plans],TF_SECONDS,cfg),[]);
  assert.ok(validateExecutionPlans([...old,...plans,{...old[0],id:'too-many'}],TF_SECONDS,cfg).length);
});
test('one source event records both arms once; only fresh depth and prints fill v2, independently of candles',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=config(),T=1800000000000,H=900000;
  cfg.executionPlans=structuredClone(MAKER_UNIVERSE_PLANS.filter(p=>p.comparison?.group==='maker-v2-sol-liquidity'));
  Object.assign(cfg.paper,{fillSource:'candles',initialEquity:1000,marginPerTrade:150,latencyMs:100,requireQuote:false,useSpread:false,
    minRiskFeeRatio:0,maxSignalAgeSec:0,skipScriptStops:false,liquidation:false,slippageBps:0,trailAfterR:0,floorAtR:0});
  let now=T;const e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now}),service=new PlanComparisons(db,()=>cfg,e,()=> 'source');
  e.causalExits=true;
  const bars=Array.from({length:40},(_,i)=>({time:T-(40-i)*H,open:100,close:100,high:101,low:99,volume:1000}));
  const input={scannerId:cfg.executionPlans[0].scannerId,scannerName:'Liquidity maker',symbol:'SOLUSD',tf:'15m',market:{contractValue:1,tickSize:.01},
    at:T,refPrice:100,bars,event:{kind:'entry' as const,side:'long' as const,price:100,sl:98,tp:[],barTime:T-H,barIndex:39,label:'Long',source:'alert' as const,message:''}};
  service.observe(input);service.observe(input);assert.equal(e.pendingEntries().length,2);
  assert.ok(service.view().cohorts.every(c=>c.signals===1));
  const candidate=e.pendingEntries().find(p=>p.executionPlan?.makerFill)!,limit=candidate.limit!.price;
  now=T+100;e.observeMakerBook('SOLUSD',{receivedAt:now,exchangeAt:now,bids:[{price:100,size:1000}],asks:[{price:100.1,size:1000}]},now,'tick-depth-v2');
  now=T+120000;e.onBar('SOLUSD',{time:T+60000,high:101,low:99,close:100,volume:100},now);
  assert.equal(e.openPositions().length,1);assert.equal(e.openPositions()[0].executionPlan?.makerFill,undefined);
  assert.equal(e.pendingEntries().length,1,JSON.stringify(db.all('SELECT stage,reason FROM decision_trace')));
  e.makerFillBook=()=>({receivedAt:T+120100,exchangeAt:T+120100,bids:[{price:100,size:1000}],asks:[{price:100.1,size:1000}]});
  now=T+120300;e.onTrade('SOLUSD',limit-.01,1,now-1,now,'first');
  assert.equal(e.openPositions().length,2);
  const p=e.openPositions().find(p=>p.executionPlan?.makerFill)!;assert.equal(p.qty,1);assert.equal(p.entryAt,now);
  now=T+120400;e.onTrade('SOLUSD',limit-.01,100,now-1,now,'second');
  assert.equal(e.pendingEntries().length,0);assert.equal(p.fills.filter(f=>f.reason==='entry').length,2);
  assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`).n,0);
  // Closed outcomes use different entry times and quantities, which is the experiment under test.
  for(const pos of e.openPositions())db.run("UPDATE positions SET status='closed',exit_at=?,exit_reason=?,realized_pnl=?,fees=? WHERE id=?",
    now+500,pos.executionPlan?.makerFill?'sl':'trail',pos.executionPlan?.makerFill?-5:8,1,pos.id);
  const result=service.view().comparisons[0];
  assert.equal(result.kind,'maker-fill');assert.equal(result.matchedClosed,1);assert.equal(result.matchedDeltaNet,-13);
  assert.equal(result.matchedControlStops,0);assert.equal(result.matchedCandidateStops,1);assert.equal(result.matchedWinnersCut,1);
  assert.equal(result.promotionEligible,false);assert.equal(result.matchedEntryMismatch,0);
});
