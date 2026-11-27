import test from 'node:test';
import assert from 'node:assert/strict';
import {mapForView,singleFlightView} from './cooperativeView.ts';

test('large read-only views yield to live callbacks without skipping or reordering cells',async()=>{
 const rows=Array.from({length:2000},(_,i)=>i),visited:number[]=[];let clock=0,atYield=-1;
 const callback=new Promise<void>(resolve=>setImmediate(()=>{atYield=visited.length;resolve();}));
 const result=await mapForView(rows,row=>{visited.push(row);clock+=2;return row*2;},{now:()=>clock});
 await callback;
 assert.equal(atYield,5);assert.deepEqual(visited,rows);assert.deepEqual(result,rows.map(x=>x*2));
});
test('small/empty views and errors preserve normal map semantics',async()=>{
 assert.deepEqual(await mapForView([],()=>assert.fail('empty')),[]);
 assert.deepEqual(await mapForView([1,2],x=>x+1),[2,3]);
 const seen:number[]=[];
 await assert.rejects(mapForView([1,2,3],x=>{seen.push(x);if(x===2)throw Error('read failed');return x;}),/read failed/);
 assert.deepEqual(seen,[1,2]);
});


test('concurrent reports share work, while later requests and errors always rebuild',async()=>{
 let reads=0,finish!:(n:number)=>void;
 const read=singleFlightView(()=>{reads++;return new Promise<number>(resolve=>{finish=resolve;});});
 const first=read(),second=read();assert.equal(first,second);await Promise.resolve();assert.equal(reads,1);finish(1);assert.equal(await first,1);
 const third=read();assert.notEqual(third,first);await Promise.resolve();finish(2);assert.equal(await third,2);assert.equal(reads,2);
 let failures=0;const retry=singleFlightView(()=>{if(!failures++)throw Error('unavailable');return 3;});
 await assert.rejects(retry(),/unavailable/);assert.equal(await retry(),3);
});
