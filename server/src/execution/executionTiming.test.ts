import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {ExecutionTiming} from './executionTiming.ts';
const T=1800000000000;
test('timing separates queue, request and event-loop delays without writing orders or policies',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const m=new ExecutionTiming(db);
 m.record({kind:'fetch',at:T+5000,book:0,symbol:'BTCUSD',readyAt:T,startedAt:T+1000,receivedAt:T+4900,exchangeAt:T+4800});
 m.record({kind:'loop-delay',at:T+5000,delayMs:3000});assert.equal(db.get<any>('select count(*) n from execution_timing')!.n,0);
 m.flush(T+5000);const v=m.view(T+5000),f=v.summary.find((x:any)=>x.kind==='fetch') as any;
 assert.equal(f.maxFetchMs,4000);assert.equal(f.maxQueueMs,1000);assert.equal(db.get<any>('select count(*) n from orders')!.n,0);
 assert.equal(db.get<any>('select count(*) n from trade_policies')!.n,0);
 const restarted=new ExecutionTiming(db);assert.equal(restarted.view(T+5000).recent.length,2);
 m.flush(T+15*86400000);assert.equal(m.view(T+15*86400000).recent.length,0);
});
test('timing queue overflow and failed flush are bounded and explicitly reported',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const m=new ExecutionTiming(db);
 for(let i=0;i<2005;i++)m.record({kind:'loop-delay',at:T,delayMs:1000});assert.equal(m.view(T).queued,2000);assert.equal(m.view(T).dropped,5);
 db.db.exec("CREATE TRIGGER fail_timing BEFORE INSERT ON execution_timing BEGIN SELECT RAISE(ABORT,'disk'); END");
 assert.doesNotThrow(()=>m.flush(T));assert.equal(m.view(T).failures,1);assert.equal(m.view(T).dropped,2005);assert.equal(m.view(T).queued,0);
});
