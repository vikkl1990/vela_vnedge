import test from 'node:test';
import assert from 'node:assert/strict';
import {mapForView} from './cooperativeView.ts';

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
