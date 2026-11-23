import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PinePool} from '../pine/pool.ts';
import {ShadowDispatch} from './dispatch.ts';

// Deliberately controlled saturation scenario, not a forecast of exchange volume.
// Exercise the real pool/reservations as well as the dispatcher under identical load.
test('split admission waits clear a saturated wave without delaying paper or extending deadlines',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1_000_000});
 const flush=()=>new Promise<void>(r=>setImmediate(r));
 async function scenario(split:boolean){
  const pool=new PinePool(8,90_000,()=>{
   const w:any=new EventEmitter();w.postMessage=(job:any)=>setTimeout(()=>w.emit('message',{id:job.id,ok:true}),job.scannerId==='paper'?200:800);
   w.terminate=async()=>0;queueMicrotask(()=>w.emit('message',{ready:true}));return w;
  },Number.MAX_SAFE_INTEGER);
  pool.rssReader=()=>0;
  const start=Date.now(),latency:number[]=[],papers:Promise<unknown>[]=[];let maxOutstanding=0,maxResearch=0;
  const job={source:'',symbol:'ETHUSD',tf:'15m',tickSize:.01,bars:[],tailBars:1,plotTail:1};
  const d=new ShadowDispatch<number>({limit:()=>6,maxInFlight:()=>split?24:6,now:()=>Date.now(),
   ready:()=>pool.stats.queuedLive===0&&pool.stats.queuedMirror===0,
   run:async(v,release)=>{const result=await pool.run({...job,scannerId:String(v)},{priority:'shadow',deadlineMs:start+295_000-Date.now()});
    assert.equal(result.ok,true);if(split)release();await new Promise<void>(r=>setTimeout(r,1000));}});
  for(let i=0;i<1600;i++)d.enqueue(String(i),i,start+295_000);
  for(let elapsed=0;elapsed<=310_000;elapsed+=100){
   if([0,60_000,120_000,180_000,240_000].includes(elapsed)){
    const at=Date.now();for(let i=0;i<2;i++)papers.push(pool.run({...job,scannerId:'paper'},{priority:'live'}).then(r=>{assert.equal(r.ok,true);latency.push(Date.now()-at);}));
   }
   d.drain();await flush();maxOutstanding=Math.max(maxOutstanding,d.stats.inFlight);maxResearch=Math.max(maxResearch,d.stats.computing);
   t.mock.timers.tick(100);await flush();
  }
  await Promise.all(papers);d.stop();await pool.stop();assert.equal(d.stats.inFlight,0);
  return{...d.stats,latency,maxOutstanding,maxResearch};
 }
 const before=await scenario(false),after=await scenario(true);
 assert.ok(before.expired>0,'baseline must reproduce overload');assert.equal(after.expired,0);assert.equal(after.finished,1600);
 assert.deepEqual(after.latency,before.latency,'paper uses its reserved slots in both workloads');
 assert.ok(after.latency.every(ms=>ms===200));assert.ok(after.maxOutstanding<=24);assert.ok(after.maxResearch<=6);
 t.diagnostic(JSON.stringify({baseline:{finished:before.finished,expired:before.expired},split:{finished:after.finished,expired:after.expired,maxOutstanding:after.maxOutstanding},paperLatencyMs:after.latency}));
});

test('restored sample collection survives a saturated wave without borrowing paper capacity',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:2_000_000});
 const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
 async function scenario(restoredLane:boolean){
  const pool=new PinePool(8,90_000,()=>{
   const w:any=new EventEmitter();w.postMessage=(job:any)=>setTimeout(()=>w.emit('message',{id:job.id,ok:true}),job.scannerId==='paper'?200:800);
   w.terminate=async()=>0;queueMicrotask(()=>w.emit('message',{ready:true}));return w;
  },Number.MAX_SAFE_INTEGER);
  pool.rssReader=()=>0;
  const start=Date.now(),latency:number[]=[],papers:Promise<unknown>[]=[],restored:number[]=[];
  const job={source:'',symbol:'XRPUSD',tf:'4h',tickSize:.01,bars:[],tailBars:1,plotTail:1};
  const d=new ShadowDispatch<number>({limit:()=>6,maxInFlight:()=>24,priority:i=>i<2300?.8:.2,
   timely:i=>restoredLane&&i>=2300,ready:()=>pool.stats.queuedLive===0&&pool.stats.queuedMirror===0,
   run:async(i,release)=>{const r=await pool.run({...job,scannerId:String(i)},{priority:'shadow',deadlineMs:start+295000-Date.now()});
    assert.equal(r.ok,true);release();if(i>=2300)restored.push(i);}});
  for(let i=0;i<2386;i++)d.enqueue(String(i),i,start+295000);
  for(let elapsed=0;elapsed<=310000;elapsed+=100){
   if([0,60000,120000,180000,240000].includes(elapsed)){
    const at=Date.now();for(let i=0;i<2;i++)papers.push(pool.run({...job,scannerId:'paper'},{priority:'live'}).then(r=>{assert.equal(r.ok,true);latency.push(Date.now()-at);}));
   }
   d.drain();await flush();assert.ok(d.stats.computing<=6);assert.ok(d.stats.inFlight<=24);
   t.mock.timers.tick(100);await flush();
  }
  await Promise.all(papers);d.stop();await pool.stop();
  return {...d.stats,restored:restored.length,latency};
 }
 const before=await scenario(false),after=await scenario(true);
 assert.equal(before.restored,0,'baseline reproduces missing the restored cells');
 assert.equal(after.restored,86);assert.equal(after.finished,before.finished,'total throughput is preserved');
 assert.deepEqual(after.latency,before.latency);assert.ok(after.latency.every(ms=>ms===200));
 assert.ok(after.fairTurns>0);assert.ok(after.timelyTurns<=Math.ceil(after.started/4));
 t.diagnostic(JSON.stringify({before:{restored:before.restored,finished:before.finished,expired:before.expired},after:{restored:after.restored,finished:after.finished,expired:after.expired},paperLatencyMs:after.latency}));
});
