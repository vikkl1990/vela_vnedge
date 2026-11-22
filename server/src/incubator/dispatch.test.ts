import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShadowDispatch} from './dispatch.ts';
const flush=()=>new Promise<void>(r=>setImmediate(r));
test('slow admission releases compute capacity but retains bounded results and cell ownership',async()=>{
 const compute=new Map<string,()=>void>(),finish=new Map<string,()=>void>(),seen:string[]=[];
 const d=new ShadowDispatch<string>({limit:()=>2,maxInFlight:()=>4,ready:()=>true,now:()=>0,
  run:async(v,release)=>{seen.push(v);compute.set(v,release);await new Promise<void>(r=>finish.set(v,r));}});
 for(let i=0;i<6;i++)d.enqueue('cell'+i,'run'+i,100);
 d.drain();await flush();assert.equal(d.stats.computing,2);
 compute.get('run0')!();compute.get('run1')!();await flush();
 assert.deepEqual(seen,['run0','run1','run2','run3']);
 compute.get('run2')!();compute.get('run3')!();await flush();
 assert.equal(d.stats.inFlight,4);assert.equal(d.stats.settling,4);assert.equal(d.stats.pending,2);
 d.enqueue('cell0','next0',100);d.drain();await flush();assert.equal(seen.length,4);
 finish.get('run0')!();await flush();assert.equal(d.stats.computing,1);assert.equal(d.stats.inFlight,4);
 compute.get('run0')!();assert.equal(d.stats.computing,1,'duplicate releases cannot free a newer permit');
 d.stop();for(const r of finish.values())r();await flush();
 assert.equal(d.stats.inFlight,0);assert.equal(d.stats.computing,0);
});

test('late release from a completed run cannot release the next run of the same cell',async()=>{
 const release:Array<()=>void>=[],finish:Array<()=>void>=[];
 const d=new ShadowDispatch<number>({limit:()=>1,maxInFlight:()=>4,ready:()=>true,now:()=>0,
  run:async(_v,r)=>{release.push(r);await new Promise<void>(f=>finish.push(f));}});
 d.enqueue('a',1,100);d.drain();await flush();d.enqueue('a',2,100);
 finish[0]();await flush();assert.equal(release.length,2);assert.equal(d.stats.computing,1);
 release[0]();assert.equal(d.stats.computing,1);
 finish[1]();await flush();assert.equal(d.stats.inFlight,0);
});

test('split stages preserve paper readiness, freshness and failure cleanup',async()=>{
 let ready=true,now=0,release!:()=>void;const rejects:Array<(e:Error)=>void>=[],seen:string[]=[],dropped:string[]=[];
 const d=new ShadowDispatch<string>({limit:()=>1,maxInFlight:()=>4,ready:()=>ready,now:()=>now,
  dropped:v=>dropped.push(v),run:async(v,r)=>{seen.push(v);release=r;await new Promise<void>((_f,j)=>{rejects.push(j);});}});
 d.enqueue('a','a',100);d.enqueue('stale','stale',10);d.enqueue('fresh','fresh',100);d.drain();await flush();
 ready=false;release();await flush();assert.deepEqual(seen,['a']);assert.equal(d.stats.settling,1);
 now=10;ready=true;d.drain();await flush();assert.deepEqual(dropped,['stale']);assert.deepEqual(seen,['a','fresh']);
 d.stop();rejects.forEach(r=>r(new Error('failed admission')));await flush();assert.equal(d.stats.failed,2);assert.equal(d.stats.computing,0);assert.equal(d.stats.inFlight,0);
});
test('1,000-cell burst stays bounded and every cell gets dispatched',async()=>{
 const releases:Array<()=>void>=[];let active=0,maxActive=0;const seen:number[]=[];
 const d=new ShadowDispatch<number>({limit:()=>6,ready:()=>true,now:()=>0,run:async v=>{active++;maxActive=Math.max(active,maxActive);seen.push(v);await new Promise<void>(r=>releases.push(r));active--;}});
 for(let i=0;i<1000;i++)d.enqueue('cell'+i,i,10000);
 d.drain();await flush();assert.equal(d.stats.inFlight,6);assert.equal(d.stats.pending,994);
 while(d.stats.pending||d.stats.inFlight){releases.splice(0).forEach(r=>r());await flush();}
 assert.equal(seen.length,1000);assert.equal(new Set(seen).size,1000);assert.equal(maxActive,6);assert.equal(d.stats.expired,0);
});
test('coalesces latest bars, yields under pressure, expires stale work and prunes retired pairs',async()=>{
 let now=0,ready=false;const seen:number[]=[];
 const d=new ShadowDispatch<number>({limit:()=>1,ready:()=>ready,now:()=>now,run:async v=>{seen.push(v);}});
 d.enqueue('a',1,10);d.enqueue('a',2,20);d.enqueue('b',3,10);d.drain();assert.equal(d.stats.pending,2);assert.equal(d.stats.replaced,1);
 now=11;ready=true;d.drain();await flush();assert.deepEqual(seen,[2]);assert.equal(d.stats.expired,1);
 d.enqueue('retired',4,50);d.prune(new Set());assert.equal(d.stats.pending,0);
 d.enqueue('stopped',5,50);d.stop();d.drain();assert.deepEqual(seen,[2]);
});
test('least-recently served fairness and no simultaneous runs for one cell',async()=>{
 const releases:Array<()=>void>=[];const seen:string[]=[];
 const d=new ShadowDispatch<string>({limit:()=>1,ready:()=>true,now:()=>0,run:async v=>{seen.push(v);await new Promise<void>(r=>releases.push(r));}});
 d.enqueue('a','a1',100);d.drain();await flush();d.enqueue('a','a2',100);d.enqueue('b','b1',100);releases.shift()!();await flush();assert.deepEqual(seen,['a1','b1']);releases.shift()!();await flush();assert.deepEqual(seen,['a1','b1','a2']);releases.shift()!();await flush();
});
test('evidence priority preserves an exploration turn under repeated priority arrivals',async()=>{
 const releases:Array<()=>void>=[];const seen:string[]=[];
 const d=new ShadowDispatch<string>({limit:()=>1,ready:()=>true,now:()=>0,priority:v=>v.startsWith('high')?1:0,run:async v=>{seen.push(v);await new Promise<void>(r=>releases.push(r));}});
 d.enqueue('low','low',10000);for(let i=0;i<6;i++)d.enqueue('h'+i,'high'+i,10000);
 d.drain();await flush();for(let i=0;i<3;i++){releases.shift()!();await flush();}
 assert.deepEqual(seen,['high0','high1','high2','low']);assert.equal(d.stats.fairTurns,1);
 d.stop();releases.shift()!();await flush();
});

test('expired and retired work reports an explicit collection outcome without starting a run',()=>{
 const dropped:Array<[number,string]>=[];let now=0;let ran=0;
 const d=new ShadowDispatch<number>({limit:()=>1,ready:()=>false,now:()=>now,run:async()=>{ran++;},dropped:(v,r)=>dropped.push([v,r])});
 d.enqueue('a',1,10);d.enqueue('b',2,20);now=10;d.drain();d.prune(new Set());
 assert.deepEqual(dropped,[[1,'expired'],[2,'removed']]);assert.equal(ran,0);
});

test('watched research gets one priority turn without starving evidence or exploration',async()=>{
 const releases:Array<()=>void>=[],seen:string[]=[];
 const d=new ShadowDispatch<string>({limit:()=>1,ready:()=>true,now:()=>0,
  timely:v=>v.startsWith('watch'),priority:v=>v.startsWith('high')?1:0,
  run:async v=>{seen.push(v);await new Promise<void>(r=>releases.push(r));}});
 d.enqueue('low','low',10000);
 for(let i=0;i<12;i++){d.enqueue('h'+i,'high'+i,10000);d.enqueue('w'+i,'watch'+i,10000);}
 d.drain();await flush();for(let i=0;i<7;i++){releases.shift()!();await flush();}
 assert.deepEqual(seen.slice(0,5),['watch0','high0','high1','low','watch1']);
 assert.equal(d.stats.timelyTurns,2);assert.equal(d.stats.evidenceTurns,4);assert.equal(d.stats.fairTurns,2);
 while(d.stats.pending||d.stats.inFlight){releases.splice(0).forEach(r=>r());await flush();}
 assert.equal(new Set(seen).size,25);assert.equal(d.stats.expired,0);
});

test('watched cells from the previous 15m wave do not wait behind untouched hourly cells',async()=>{
 const seen:string[]=[];let ready=true;
 const d=new ShadowDispatch<string>({limit:()=>1,ready:()=>ready,now:()=>0,timely:v=>v==='watched',priority:()=>0,run:async v=>{seen.push(v);}});
 for(const v of ['watched','prior1','prior2','prior3']){d.enqueue(v,v,10000);d.drain();await flush();}
 ready=false;for(let i=0;i<1000;i++)d.enqueue('hour'+i,'hour'+i,10000);
 d.enqueue('watched','watched',10000);ready=true;d.drain();await flush();
 assert.equal(seen[4],'watched');assert.equal(seen.length,1005);
});

test('timely preference cannot bypass readiness, expiry, coalescing or capacity',async()=>{
 const releases:Array<()=>void>=[],seen:number[]=[];let now=0,ready=false;
 const d=new ShadowDispatch<number>({limit:()=>2,ready:()=>ready,now:()=>now,timely:()=>true,
  run:async v=>{seen.push(v);await new Promise<void>(r=>releases.push(r));}});
 d.enqueue('stale',0,10);d.enqueue('updated',1,100);d.enqueue('updated',2,100);
 d.enqueue('third',3,100);d.enqueue('fourth',4,100);d.drain();await flush();assert.deepEqual(seen,[]);
 now=10;ready=true;d.drain();await flush();assert.deepEqual(seen,[2,3]);assert.equal(d.stats.inFlight,2);assert.equal(d.stats.expired,1);
 d.stop();releases.splice(0).forEach(r=>r());await flush();assert.deepEqual(seen,[2,3]);
});
