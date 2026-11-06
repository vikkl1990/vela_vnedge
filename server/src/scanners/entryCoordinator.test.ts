import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {EntryCoordinator,orderEntries} from './entryCoordinator.ts';
const cells=['s1','s2','s3'].map(key=>({key,scannerId:key,symbol:'BTCUSD',tf:'15m',barTime:0}));
test('ready-set allocation has stable ordering independent of callback arrival',async t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());
  const run=async(cs:typeof cells)=>{const q=new EntryCoordinator(db,()=>10,()=>1000),seen:string[]=[];
    const all=cs.map(c=>q.enqueue(c,()=>{seen.push(c.key);return seen.length===1?'accepted':'capacity';}));
    await Promise.all(all);q.stop();return seen;};
  assert.deepEqual(await run(cells),await run([...cells].reverse()));
  assert.equal(db.get<{n:number}>('SELECT COUNT(*) n FROM entry_batches')!.n,2);
  assert.deepEqual(orderEntries(cells,1000),orderEntries([...cells].reverse(),1000));
});
test('admission rechecks current state; one failed decision cannot block the batch',async t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const q=new EntryCoordinator(db,()=>10,()=>1000);
  let halted=false;const results=cells.map((c,i)=>q.enqueue(c,()=>{if(i===0)throw Error('write failed');return halted?'halted':'opened';}));
  halted=true;const values=await Promise.allSettled(results);q.stop();
  assert.equal(values.filter(x=>x.status==='rejected').length,1);
  assert.deepEqual(values.filter(x=>x.status==='fulfilled').map(x=>x.value),['halted','halted']);
});
test('stopping abandons queued decisions without executing them',async t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const q=new EntryCoordinator(db,()=>1000,()=>1000);
  let called=false;const result=q.enqueue(cells[0],()=>{called=true;});q.stop();
  await assert.rejects(result,/receipt retained/);assert.equal(called,false);
});
