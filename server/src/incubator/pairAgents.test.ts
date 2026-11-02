import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {IncubatorStore} from './store.ts';
import {PairAgents,AGENT_DEFAULTS,coverageSignature,recordCoverage} from './pairAgents.ts';
import type {ScreenQueue,ScreenJob} from './screenQueue.ts';

function fixture(t: {after:(f:()=>void)=>void}) {
  const db=new Db(':memory:');const store=new IncubatorStore(db);const cfg=structuredClone(DEFAULT_CONFIG);
  cfg.incubator.agents={...AGENT_DEFAULTS,enabled:true};cfg.incubator.tfs=['15m'];cfg.risk.marketGate!.enabled=false;
  cfg.scanners={a:{enabled:true,symbols:null,timeframes:null,exitMode:'both'},b:{enabled:true,symbols:null,timeframes:null,exitMode:'both'}};
  const scanners=[{id:'a',name:'A',patched:'indicator("A")'},{id:'b',name:'B',patched:'indicator("B")'}];
  let now=1_800_000_000_000,pressure=false,evaluations=0;
  const markets=['XRPUSD','LINKUSD','DOGEUSD','AVAXUSD','SUIUSD','BNBUSD'].map((symbol,i)=>({symbol,description:symbol,volume24h:10e6-i*1e6,price:10}));
  const jobs:ScreenJob[]=[],history:ScreenJob[]=[];let running:ScreenJob|null=null;
  const queue={list:()=>({running,queued:[],history,nightlyRunning:false,capped:true}),enqueue:(req:any)=>{const job={...req,id:String(jobs.length+1),status:'running',tail:[],requestedAt:now} as ScreenJob;jobs.push(job);running=job;return job;}};
  const deps={db,cfg:()=>cfg,store,queue:queue as unknown as ScreenQueue,scanners:()=>scanners,markets:async()=>markets,verdict:()=>null,pressure:()=>pressure,evaluate:async()=>{evaluations++;},now:()=>now};
  const agent=new PairAgents(deps);agent.start();t.after(()=>{agent.stop();db.db.close();});
  return {db,store,cfg,scanners,markets,agent,jobs,deps,history,advance:(n:number)=>{now+=n;},now:()=>now,pressure:(p:boolean)=>{pressure=p;},evaluations:()=>evaluations,finish:(status:ScreenJob['status']='done')=>{if(running){history.unshift({...running,status,finishedAt:now});running=null;}}};
}
test('pair agents research alts beyond BTC/ETH/SOL and rotate past submitted cells',async t=>{
  const f=fixture(t);await f.agent.tick();assert.equal(f.jobs.length,1);assert.deepEqual(f.jobs[0].markets,['XRPUSD','LINKUSD','DOGEUSD']);
  assert.equal(f.jobs[0].budgetMinutes,15);f.finish();f.advance(11*60_000);await f.agent.tick();
  assert.deepEqual(f.jobs[1].markets,['AVAXUSD','SUIUSD','BNBUSD']);assert.equal(f.evaluations(),1);
  await f.agent.tick();assert.equal(f.evaluations(),1);assert.equal(f.jobs.length,2);
});
test('active account, shadow and watch cells are preserved without promotion or duplication',async t=>{
  const f=fixture(t);f.markets.splice(1);for(const id of ['a','b'])f.store.move({scannerId:id,symbol:'XRPUSD',tf:'15m'},'tracked','test',null,'tracker:test',f.now());
  await f.agent.tick();assert.equal(f.jobs.length,0);const v=await f.agent.view();assert.equal(v.markets[0].tracked,2);assert.equal(v.markets[0].account,0);assert.equal(v.markets[0].due,0);assert.equal(f.evaluations(),0);
});
test('a larger scanner pool still visits other markets before repeating the top trio',async t=>{
  const f=fixture(t);for(let i=0;i<8;i++)f.scanners.push({id:`extra${i}`,name:`Extra ${i}`,patched:`indicator("Extra ${i}")`});
  await f.agent.tick();assert.equal(f.jobs[0].ids.length,4);f.finish();f.advance(11*60_000);await f.agent.tick();
  assert.deepEqual(f.jobs[1].markets,['AVAXUSD','SUIUSD','BNBUSD']);
});
test('recent negative results count as tested; stale or changed-policy evidence does not',async t=>{
  const f=fixture(t),signature=coverageSignature(f.cfg,f.scanners[0],'15m');
  recordCoverage(f.db,'a','XRPUSD','15m',signature,{at:f.now(),pass:false,trades:20,avgR:-.1} as any);
  let v=await f.agent.view();assert.equal(v.markets[0].screened,1);assert.equal(v.markets[0].passed,0);assert.equal(v.markets[0].due,1);
  f.cfg.paper.feeRatePct+=.01;v=await f.agent.view();assert.equal(v.markets[0].screened,0);assert.equal(v.markets[0].due,2);
  f.cfg.paper.feeRatePct-=.01;f.advance(8*86400_000);assert.equal((await f.agent.view()).markets[0].screened,0);
});
test('failed and skipped jobs never become completed screens, with bounded retry',async t=>{
  const f=fixture(t);await f.agent.tick();f.finish('failed');f.advance(11*60_000);await f.agent.tick();
  assert.equal(f.evaluations(),0);assert.equal((await f.agent.view()).markets.reduce((n,m)=>n+m.screened,0),0);
  assert.ok(!f.jobs[1].markets?.includes('XRPUSD'));
});
test('daily budget survives restart, worker pressure yields, and pause prevents submission',async t=>{
  const f=fixture(t);f.cfg.incubator.agents!.maxJobsPerDay=1;f.pressure(true);await f.agent.tick();assert.equal(f.jobs.length,0);
  f.pressure(false);await Promise.all([f.agent.tick(),f.agent.tick()]);assert.equal(f.jobs.length,1);f.finish();f.advance(11*60_000);await f.agent.tick();assert.equal(f.jobs.length,1);
  const restarted=new PairAgents(f.deps);restarted.start();t.after(()=>restarted.stop());await restarted.tick();assert.equal(f.jobs.length,1);
  f.advance(86400_000);f.cfg.incubator.agents!.enabled=false;await restarted.tick();assert.equal(f.jobs.length,1);
  f.cfg.incubator.agents!.enabled=true;await restarted.tick();assert.equal(f.jobs.length,2);
});
test('excluded markets and non-crypto products cannot enter research',async t=>{
  const f=fixture(t);f.cfg.universe.exclude=['XRPUSD'];f.markets[1].description='Gold Token';f.markets[2].price=0;f.markets[3].volume24h=1;
  const v=await f.agent.view();assert.equal(v.markets.find(m=>m.symbol==='LINKUSD'),undefined);assert.equal(v.eligible,2);
  await f.agent.tick();assert.deepEqual(f.jobs[0].markets,['SUIUSD','BNBUSD']);
});
test('stopping discovery while the network is pending prevents a late queued job',async t=>{
  const f=fixture(t);let release!:()=>void;f.deps.markets=()=>new Promise(resolve=>{release=()=>resolve(f.markets);});
  const a=new PairAgents(f.deps);a.start();t.after(()=>a.stop());const run=a.tick();a.stop();release();await run;assert.equal(f.jobs.length,0);
});
test('pausing the incubator during market discovery prevents a late queued job',async t=>{
  const f=fixture(t);let release!:()=>void;f.deps.markets=()=>new Promise(resolve=>{release=()=>resolve(f.markets);});
  const a=new PairAgents(f.deps);a.start();t.after(()=>a.stop());const run=a.tick();f.cfg.incubator.enabled=false;release();await run;assert.equal(f.jobs.length,0);
});
test('agent bounds reject malformed and excessive workloads',()=>{
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.agents={...AGENT_DEFAULTS,marketsPerJob:300,maxJobsPerDay:0};
  const errors=validateConfig(cfg);assert.ok(errors.some(e=>e.includes('marketsPerJob')));assert.ok(errors.some(e=>e.includes('maxJobsPerDay')));
});
