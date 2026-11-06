import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {Db} from '../src/db.ts';

async function setup(t:any,releaseAfterMs:number) {
  const dir=mkdtempSync(join(tmpdir(),'vnedge-contention-')),file=join(dir,'book.db');
  const db=new Db(file);db.kvSet('revision',0);
  const control=new Int32Array(new SharedArrayBuffer(4));
  const worker=new Worker(`
    const {workerData,parentPort}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const c=new Int32Array(workerData.control),db=new DatabaseSync(workerData.file);
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
    db.prepare("UPDATE kv SET v='1' WHERE k='revision'").run();
    parentPort.postMessage('locked');
    Atomics.wait(c,0,0,5000);
    if(workerData.delay>=0)Atomics.wait(c,0,1,workerData.delay);
    else Atomics.wait(c,0,1,5000);
    db.exec('COMMIT');db.close();parentPort.postMessage('committed');
  `,{eval:true,workerData:{file,control:control.buffer,delay:releaseAfterMs}});
  const committed=new Promise<void>((resolve,reject)=>{worker.on('message',m=>{if(m==='committed')resolve();});worker.on('error',reject);});
  await new Promise<void>((resolve,reject)=>{worker.on('message',m=>{if(m==='locked')resolve();});worker.on('error',reject);});
  t.after(async()=>{Atomics.store(control,0,2);Atomics.notify(control,0);await committed;await worker.terminate();db.db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,file,committed,start:()=>{Atomics.store(control,0,1);Atomics.notify(control,0);},release:()=>{Atomics.store(control,0,2);Atomics.notify(control,0);}};
}

test('write transaction waits before reading and commits against the other writer’s latest state',async t=>{
  const a=await setup(t,250);a.start();
  let calls=0;const observed:number[]=[],notifications:number[]=[];
  const result=a.db.transaction(()=>{
    calls++;const revision=a.db.kvGet<number>('revision')!;observed.push(revision);
    a.db.kvSet('revision',revision+1);
    a.db.afterCommit(()=>notifications.push(a.db.kvGet<number>('revision')!));
    return revision+1;
  });
  await a.committed;
  assert.equal(result,2);assert.deepEqual(observed,[1]);assert.equal(calls,1);
  assert.deepEqual(notifications,[2]);assert.equal(a.db.kvGet('revision'),2);
  assert.equal(a.db.errors,0);assert.equal(a.db.inTransaction,false);
});

test('failed lock acquisition reports an error without running or leaking decision callbacks',async t=>{
  const a=await setup(t,-1);a.db.db.exec('PRAGMA busy_timeout=25');a.start();
  let calls=0;
  assert.throws(()=>a.db.transaction(()=>{calls++;a.db.afterCommit(()=>calls++);a.db.kvSet('unexpected',1);}),/locked/);
  assert.equal(calls,0);assert.equal(a.db.inTransaction,false);assert.equal(a.db.errors,1);
  assert.match(a.db.lastError!.message,/locked/);
  a.release();await a.committed;
  a.db.transaction(()=>{a.db.kvSet('recovered',1);a.db.afterCommit(()=>calls++);});
  assert.equal(calls,1);assert.equal(a.db.kvGet('unexpected'),undefined);assert.equal(a.db.kvGet('recovered'),1);
});

test('write reservations preserve WAL readers and nested rollback/notification behavior',t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-wal-')),file=join(dir,'book.db');
  const db=new Db(file),reader=new DatabaseSync(file,{readOnly:true});
  t.after(()=>{reader.close();db.db.close();rmSync(dir,{recursive:true,force:true});});
  db.kvSet('revision',0);const notifications:string[]=[];
  db.transaction(()=>{
    db.kvSet('revision',1);db.afterCommit(()=>notifications.push('outer'));
    assert.equal(reader.prepare("SELECT v FROM kv WHERE k='revision'").get()!.v,'0');
    assert.throws(()=>db.transaction(()=>{db.kvSet('revision',99);db.afterCommit(()=>notifications.push('rolled back'));throw Error('abort');}),/abort/);
    db.transaction(()=>{db.kvSet('nested',true);db.afterCommit(()=>notifications.push('inner'));});
    assert.equal(db.kvGet('revision'),1);assert.deepEqual(notifications,[]);
  });
  assert.equal(reader.prepare("SELECT v FROM kv WHERE k='revision'").get()!.v,'1');
  assert.deepEqual(notifications,['outer','inner']);assert.equal(db.kvGet('nested'),true);
});
