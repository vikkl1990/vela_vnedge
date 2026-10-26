import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShadowDispatch} from './dispatch.ts';
const flush=()=>new Promise<void>(r=>setImmediate(r));
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
