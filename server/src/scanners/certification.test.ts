import {test} from 'node:test';
import assert from 'node:assert/strict';
import {certifyContract} from './certification.ts';
import type {WorkerJob} from '../pine/worker.ts';
const bars=Array.from({length:1000},(_,i)=>({time:(i+1)*60000,open:100,high:102,low:98,close:100,volume:10}));
const job={scannerId:'audit',symbol:'INITUSD',tf:'1m',tickSize:.01,source:'indicator("test")',bars,tailBars:'all' as const,plotTail:1000};
const run=async(j:Omit<WorkerJob,'id'>,sl=99)=>({id:1,ok:true,ms:1,bars:j.bars.length,lastBarTime:j.bars.at(-1)!.time,warnings:0,shapes:[],labels:[],plots:[],alerts:j.bars.filter(b=>b.time%600000===0).map((b,i)=>({barIndex:i,time:b.time,type:'alert' as const,message:`LONG | Price: 100 | SL: ${sl} | TP1: 102`}))});
test('certification checks sequential closed-bar prefixes and multiple warm-up lengths with pinned inputs',async()=>{
 const result=await certifyContract(job,{sources:['alert']},run);
 assert.equal(result.status,'stable-in-tested-windows');assert.equal(result.checks.length,6);assert.equal(result.identity.source.length,64);assert.equal(result.identity.runtime.length,64);
 const unstable=await certifyContract(job,{sources:['alert']},j=>run(j,j.bars[0].time===bars[0].time?99:95));
 assert.equal(unstable.status,'unstable');assert.ok(unstable.checks.some(c=>c.kind==='warmup'&&c.result!.planChanged>0));
});
test('too little history, failed runs and unfrozen external frames cannot be certified',async()=>{
 const external=await certifyContract({...job,source:'request.security("BTC", "60", close)'},{sources:['alert']},run);
 assert.equal(external.status,'unknown');assert.equal(external.identity.externalInputsFrozen,false);
 const sparse=await certifyContract({...job,bars:bars.slice(0,20)},{sources:['alert']},run);assert.equal(sparse.status,'unknown');
 const failed=await certifyContract(job,{},async j=>({...await run(j),ok:false,error:'timeout'}));assert.equal(failed.status,'unknown');
 const warned=await certifyContract(job,{},async j=>({...await run(j),dataWarnings:['missing requested data']}));assert.equal(warned.status,'unknown');
 const lower=await certifyContract({...job,source:'request.security_lower_tf("BTC", "1", close)'},{sources:['alert']},run);assert.equal(lower.status,'unknown');
});
