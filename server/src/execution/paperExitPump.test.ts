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

test('verified streaming exit bypasses two blocked REST slots without changing arrival or freshness',async()=>{
 let now=10000,rows=[{...intent('S1'),book:2},{...intent('S2'),book:2}],receipt=10249;
 const calls:string[]=[],applied:string[]=[],done:Array<(b:ExitBook)=>void>=[];
 const pump=new PaperExitPump({now:()=>now,pending:()=>rows,fetch:s=>{calls.push(s);return new Promise(r=>done.push(r));},
  cached:s=>s==='BTCUSD'?{receivedAt:receipt,exchangeAt:receipt,bids:[{price:99,size:2}],asks:[{price:100,size:2}]}:null,
  apply:s=>{applied.push(s);rows=rows.filter(i=>i.symbol!==s);}});
 pump.tick();now=10250;pump.tick();assert.deepEqual(calls,['S1','S2']);
 rows.push({...intent('BTCUSD',10300),book:0});now=10299;pump.tick();assert.equal(applied.length,0);
 now=10300;pump.tick();assert.equal(applied.length,0,'old cache cannot satisfy a new order arrival');
 receipt=10301;now=10300;pump.tick();assert.equal(applied.length,0,'future receipt cannot fill');
 receipt=10300;pump.tick();assert.deepEqual(applied,['BTCUSD']);assert.deepEqual(calls,['S1','S2']);
 pump.stop();done.forEach(r=>r({} as ExitBook));await flush();assert.equal(applied.length,1);
});

test('an account position reserves a public-read slot while research retains bounded progress',async()=>{
 let now=10000,exposure=true;const calls:string[]=[],done:Array<(b:ExitBook)=>void>=[];
 const rows=[{...intent('S1'),book:2},{...intent('S2'),book:2}];
 const pump=new PaperExitPump({now:()=>now,paperExposure:()=>exposure,pending:()=>rows,fetch:s=>{calls.push(s);return new Promise(r=>done.push(r));},apply:()=>{}});
 pump.tick();now+=250;pump.tick();assert.deepEqual(calls,['S1']);
 rows.push({...intent('A',now),book:0});pump.tick();assert.deepEqual(calls,['S1','A']);
 pump.stop();done.forEach(r=>r({} as ExitBook));await flush();
 exposure=false;const noAccount=new PaperExitPump({now:()=>now,paperExposure:()=>exposure,pending:()=>rows.filter(i=>i.book===2),fetch:s=>{calls.push(s);return new Promise(()=>{});},apply:()=>{}});
 noAccount.tick();now+=250;noAccount.tick();assert.deepEqual(calls.slice(-2),['S1','S2']);noAccount.stop();
});

test('stream deduplication, source failures and diagnostic failures cannot create or block fills',async()=>{
 let now=10000,receipt=10000,applied=0;const events:any[]=[];
 const pump=new PaperExitPump({now:()=>now,pending:()=>[{...intent('BTCUSD'),book:0}],cached:()=>({receivedAt:receipt,exchangeAt:receipt,bids:[],asks:[]}),fetch:()=>new Promise(()=>{}),apply:()=>{applied++;},observe:e=>{events.push(e);throw Error('storage unavailable');}});
 pump.tick();pump.tick();assert.equal(applied,1);now+=2000;pump.tick();assert.equal(applied,1,'stale observation remains rejected');
 assert.ok(events.some(e=>e.kind==='loop-delay'&&e.delayMs===1900));receipt=now;pump.tick();assert.equal(applied,2);pump.stop();
 const broken=new PaperExitPump({now:()=>now,pending:()=>[intent('A')],cached:()=>{throw Error('bad cache');},fetch:async()=>({} as ExitBook),apply:()=>{applied++;}});
 broken.tick();await flush();assert.equal(applied,3);broken.stop();
});

test('replenished depth at the same timestamps reaches a partial exit',()=>{
 let size=1,applied=0;
 const pump=new PaperExitPump({now:()=>10000,pending:()=>[{...intent('BTCUSD'),book:0}],
  cached:()=>({receivedAt:10000,exchangeAt:10000,bids:[{price:99,size}],asks:[{price:100,size:2}]}),
  fetch:()=>new Promise(()=>{}),apply:()=>{applied++;}});
 pump.tick();pump.tick();assert.equal(applied,1);
 size=2;pump.tick();assert.equal(applied,2);pump.tick();assert.equal(applied,2);pump.stop();
});
