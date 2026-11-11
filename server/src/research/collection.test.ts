import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {AdvisoryDepthPool} from './depthPool.ts';
import {OrderFlowStore} from '../orderflow/store.ts';
import {crc32} from '../execution/depthRecorder.ts';
const T=1_800_000_000_000,M=60000;
class Feed extends EventEmitter {subscriptions=new Set<string>();stopped=false;start(){this.emit('status',{connected:true});}stop(){this.stopped=true;this.emit('status',{connected:false});}subscribe(_c:string,symbols:string[]){symbols.forEach(s=>this.subscriptions.add(s));assert.ok(this.subscriptions.size<=100);}unsubscribe(_c:string,symbols:string[]){symbols.forEach(s=>this.subscriptions.delete(s));}}
test('all active depth pairs are sharded below Delta limit, without touching the raw execution tape',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const feeds:Feed[]=[];
 const pool=new AdvisoryDepthPool(db,()=>{const f=new Feed();feeds.push(f);return f;});
 const symbols=['INITUSD','PARTIUSD',...Array.from({length:205},(_,i)=>`X${i}USD`)];pool.setSymbols(symbols);assert.equal(pool.summary().symbols,207);assert.equal(feeds.length,3);assert.equal(feeds.reduce((a,f)=>a+f.subscriptions.size,0),207);
 const owner=feeds.find(f=>f.subscriptions.has('INITUSD'))!;
 owner.emit('depth',{sy:'INITUSD',action:'snapshot',seq:1,ts:Date.now()*1000,a:[['101','2']],b:[['100','3']],cs:crc32('101:2|100:3')});assert.ok(pool.recorder.bookAt('INITUSD',Date.now()));
 assert.equal(db.get<any>('SELECT count(*) n FROM depth_tape')!.n,0);
 owner.emit('status',{connected:false});assert.equal(pool.recorder.bookAt('INITUSD',Date.now()),null);
 pool.setSymbols(['INITUSD','PARTIUSD']);assert.equal(pool.summary().connections,1);assert.ok(feeds[1].stopped&&feeds[2].stopped);pool.stop();assert.ok(feeds[0].stopped);
});
test('INIT and PARTI get compact flow, without changing existing scanner footprint support',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const f=new OrderFlowStore(db);f.observeSymbols(['INITUSD','PARTIUSD'],T);f.connection(true,T);
 for(let i=0;i<6;i++){
  for(const symbol of ['INITUSD','PARTIUSD'])f.onTrade({symbol,timeMs:T+i*M+1,price:1,qty:10,aggressor:'buy'},T+i*M+1);
  f.flush(T+(i+1)*M+10000);
 }
 assert.equal(f.summary('INITUSD',T+6*M+10000).covered,true);assert.equal(f.summary('PARTIUSD',T+6*M+10000).imbalance,1);
 assert.equal(f.minutes('INITUSD',T,T+6*M).length,0);assert.deepEqual(f.symbols,['BTCUSD','ETHUSD','SOLUSD']);
 assert.equal(db.get<any>("SELECT count(*) n FROM advisory_flow_minutes WHERE symbol='INITUSD'")!.n,6);
});
test('new mid-minute subscriptions and silent never-seen channels cannot fabricate flow coverage',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const f=new OrderFlowStore(db);f.connection(true,T);f.observeSymbols(['INITUSD','PARTIUSD'],T+30000);
 f.onTrade({symbol:'INITUSD',timeMs:T+31000,price:1,qty:10,aggressor:'buy'},T+31000);f.flush(T+M+10000);
 assert.equal(db.get<any>("SELECT covered FROM advisory_flow_minutes WHERE symbol='INITUSD'")!.covered,0);
 assert.equal(db.get<any>("SELECT covered FROM advisory_flow_minutes WHERE symbol='PARTIUSD'")!.covered,0);
 assert.equal(f.summary('INITUSD',T+M+10000).covered,false);
});
test('late prints invalidate compact summaries and reconnects require fresh coverage',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const f=new OrderFlowStore(db);f.observeSymbols(['INITUSD'],T);f.connection(true,T);
 f.onTrade({symbol:'INITUSD',timeMs:T+1,price:1,qty:10,aggressor:'buy'},T+1);f.flush(T+M+10000);
 f.onTrade({symbol:'INITUSD',timeMs:T+10,price:1,qty:10,aggressor:'buy'},T+M+11000);
 assert.equal(db.get<any>("SELECT covered FROM advisory_flow_minutes WHERE symbol='INITUSD'")!.covered,0);
 f.connection(false,T+M+12000);assert.equal(f.summary('INITUSD',T+M+12000).covered,false);
});
