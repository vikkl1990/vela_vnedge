import{test}from'node:test';import assert from'node:assert/strict';import{ScanRecovery}from'./recovery.ts';
const failure={ok:false,error:'memory-shared: pressure'};
test('shared-memory scan recovers once and never retries deterministic failures',async()=>{
 let now=0,n=0;const r=new ScanRecovery(()=>now,async ms=>{now+=ms;});
 assert.equal((await r.recover<{ok:boolean;error?:string}>(failure,async()=>{n++;return {ok:true};},()=>true,()=>true,10000)).ok,true);
 await r.recover<{ok:boolean;error?:string}>({ok:false,error:'syntax'},async()=>{n++;return {ok:true};},()=>true,()=>true,10000);assert.equal(n,1);
 await r.recover<{ok:boolean;error?:string}>(failure,async()=>{n++;return failure;},()=>true,()=>true,10000);assert.equal(n,2);
});
test('expired, disabled and still memory-constrained scans are not retried',async()=>{
 for(const cause of ['expired','changed','pressure']){
 let now=0;const r=new ScanRecovery(()=>now,async ms=>{now+=ms;});let n=0;
 await r.recover<{ok:boolean;error?:string}>(failure,async()=>{n++;return {ok:true};},()=>cause!=='changed',()=>cause!=='pressure',cause==='expired'?1000:60000);
 assert.equal(n,0,cause);assert.equal(r.counts.abandoned,1);
 }
});
test('recovery attempts are serialized rather than creating another memory burst',async()=>{
 let now=0,active=0,peak=0;const r=new ScanRecovery(()=>now,async ms=>{now+=ms;});
 await Promise.all(Array.from({length:3},()=>r.recover<{ok:boolean;error?:string}>(failure,async()=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return{ok:true};},()=>true,()=>true,20000)));
 assert.equal(peak,1);assert.equal(r.counts.recovered,3);
});
