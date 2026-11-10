import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PaperExitPump} from './paperExitPump.ts';
import type {ExitIntent,ExitBook} from '../paper/exitExecution.ts';
const intent=(symbol:string,ready_at=10000)=>({symbol,ready_at} as ExitIntent);
const flush=()=>new Promise<void>(r=>setImmediate(r));
test('exit pump respects arrival, single flight, global request pace and two concurrent requests',async()=>{
 let now=9999;const calls:string[]=[],done:Array<(b:ExitBook)=>void>=[];
 const pump=new PaperExitPump({now:()=>now,pending:()=>['A','A','B','C'].map(s=>intent(s)),fetch:s=>{calls.push(s);return new Promise(r=>done.push(r));},apply:()=>{}});
 pump.tick();assert.equal(calls.length,0);now=10000;pump.tick();pump.tick();assert.deepEqual(calls,['A']);
 now=10249;pump.tick();assert.equal(calls.length,1);now=10250;pump.tick();assert.deepEqual(calls,['A','B']);
 now=10500;pump.tick();assert.equal(calls.length,2);done[0]({} as ExitBook);await flush();pump.tick();assert.deepEqual(calls,['A','B','C']);pump.stop();
});
test('exit pump retains failures for bounded retry and ignores in-flight results after stop',async()=>{
 let now=10000;const applied:Array<ExitBook|null>=[];let calls=0;
 const pump=new PaperExitPump({now:()=>now,pending:()=>[intent('A')],fetch:async()=>{calls++;throw Error('unavailable');},apply:(_s,b)=>applied.push(b)});
 pump.tick();await flush();assert.deepEqual(applied,[null]);now=10999;pump.tick();assert.equal(calls,1);now=11000;pump.tick();await flush();assert.equal(calls,2);pump.stop();now=12000;pump.tick();assert.equal(calls,2);
 let resolve!:(b:ExitBook)=>void;const stopped=new PaperExitPump({pending:()=>[intent('A')],now:()=>now,fetch:()=>new Promise(r=>resolve=r),apply:()=>assert.fail('stopped pump settled')});stopped.tick();stopped.stop();resolve({} as ExitBook);await flush();
});

test('failing shadow symbols do not starve the account, and retries rotate fairly',async()=>{
 let now=10000;const calls:string[]=[];let rows=[intent('S1'),intent('S2'),intent('S3'),intent('S4'),intent('S5')].map(i=>({...i,book:2}));
 const pump=new PaperExitPump({pending:()=>rows,now:()=>now,fetch:async s=>{calls.push(s);throw Error('missing depth');},apply:()=>{}});
 for(let j=0;j<4;j++){pump.tick();await flush();now+=250;}
 rows.push({...intent('A'),book:0});pump.tick();await flush();assert.equal(calls[4],'A');
 rows=rows.filter(i=>i.symbol!=='A');now+=250;pump.tick();await flush();assert.equal(calls[5],'S5');pump.stop();
});
