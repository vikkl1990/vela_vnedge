import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {IncubatorStore} from './store.ts';
import {recoverPendingFunnel} from './pendingFunnel.ts';
import {ShadowRunner} from './shadow.ts';

const key='s|LABUSD|1h',T=Date.now()-10_000;
function setup(t:any){
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const trace=(stage:string,at:number,snapshot:any={},id=7,book=2)=>db.run(`INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage,snapshot) VALUES(?,?,?,'s','LABUSD','1h',?,?)`,at,book,id,stage,JSON.stringify(snapshot));
 const fill=(at:number,id=7,book=2)=>db.run(`INSERT INTO orders(at,position_id,scanner_id,symbol,side,qty,price,fee,reason,bt) VALUES(?,?,'s','LABUSD','long',1,100,.1,'entry',?)`,at,id,book);
 trace('pending',T+2,{signalAt:T});return {db,trace,fill};
}
test('restart repairs an expired order by exact signal link, even when its ID was later reused',t=>{
 const {db,trace,fill}=setup(t);trace('cancelled',T+1000);trace('pending',T+2000,{signalAt:T+2000});fill(T+3000);trace('filled',T+3000);
 const before=db.all('SELECT * FROM decision_trace'),store=new IncubatorStore(db);
 store.setShadowFunnel({[key]:[[T,'pending','pending:resting limit']]});
 const runner=new ShadowRunner({store,paper:new EventEmitter()}as any);t.after(()=>runner.stop());
 assert.equal(runner.funnelOf(key,0).pending,0);assert.equal(runner.funnelOf(key,0).other,1);
 assert.equal(runner.funnelOf(key,0).opened,0);assert.equal(runner.stats.entries,0);
 assert.deepEqual(db.all('SELECT * FROM decision_trace'),before,'no journal rewriting');
 const second=new ShadowRunner({store,paper:new EventEmitter()}as any);t.after(()=>second.stop());
 assert.equal(second.funnelOf(key,0).other,1,'idempotent across another restart');
});
test('restart restores a still-resting link and counts its later fill once',t=>{
 const {db}=setup(t),store=new IncubatorStore(db),paper=new EventEmitter();
 db.run("INSERT INTO positions(id,scanner_id,scanner_name,symbol,tf,side,status,qty,qty_open,contract_value,entry_price,entry_at,bt) VALUES(7,'s','s','LABUSD','1h','long','pending',0,0,1,100,?,2)",T);
 store.setShadowFunnel({[key]:[[T,'pending']]});
 const runner=new ShadowRunner({store,paper}as any);t.after(()=>runner.stop());
 assert.equal(runner.funnelOf(key,0).pending,1);
 paper.emit('order',{positionId:7,reason:'entry'});paper.emit('order',{positionId:7,reason:'entry'});
 assert.equal(runner.funnelOf(key,0).opened,1);assert.equal(runner.stats.entries,1);
});
test('historical fill requires an actual shadow entry order and does not inflate since-restart totals',t=>{
 const {db,trace,fill}=setup(t);trace('filled',T+1000);
 assert.deepEqual(recoverPendingFunnel(db,[{key,at:T}],T+2000),[]);
 fill(T+500,7,0);assert.deepEqual(recoverPendingFunnel(db,[{key,at:T}],T+2000),[],'account order is not shadow proof');
 fill(T+500);const store=new IncubatorStore(db);store.setShadowFunnel({[key]:[[T,'pending']]});
 const runner=new ShadowRunner({store,paper:new EventEmitter()}as any);t.after(()=>runner.stop());
 assert.equal(runner.funnelOf(key,0).opened,1);assert.equal(runner.stats.entries,0);
});
test('ambiguous links, different signals, future terminals and reused IDs cannot invent fills',t=>{
 const {db,trace,fill}=setup(t);fill(T+500);trace('filled',T+1000);
 assert.deepEqual(recoverPendingFunnel(db,[{key,at:T+1}],T+2000),[]);
 assert.deepEqual(recoverPendingFunnel(db,[{key,at:T}],T+100),[]);
 trace('pending',T+1500,{signalAt:T});
 assert.deepEqual(recoverPendingFunnel(db,[{key,at:T}],T+2000),[],'duplicate signal links held');
 const next=T+3000;trace('pending',next,{signalAt:next},8);trace('pending',next+100,{signalAt:next+100},8);fill(next+200,8);trace('filled',next+200,{},8);
 assert.deepEqual(recoverPendingFunnel(db,[{key,at:next}],next+300),[]);
});
