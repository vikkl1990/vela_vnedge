import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {IncubatorStore} from './store.ts';
import {saveTracker,removeTracker,listTrackers,trackerView} from './tracker.ts';
const def=(id:string)=>({id,name:id,scanners:['s'],symbols:['BTCUSD'],tfs:['15m']});
function setup(t:any){const db=new Db(':memory:');t.after(()=>db.db.close());return {db,store:new IncubatorStore(db)};}
test('removing or narrowing one tracker retains shared cells until the last subscription leaves',t=>{
 const {db,store}=setup(t);saveTracker(db,store,def('first'),1000);saveTracker(db,store,def('second'),2000);
 assert.equal(removeTracker(db,store,'first',3000),0);
 const held=store.find('s','BTCUSD','15m')!;assert.equal(held.stage,'tracked');assert.equal(held.since,1000);assert.equal(held.note,'tracker:second');
 saveTracker(db,store,{...def('third'),symbols:['BTCUSD','ETHUSD']},4000);
 assert.equal(saveTracker(db,store,{...def('second'),symbols:['ETHUSD']},5000).released,0);
 assert.equal(store.find('s','BTCUSD','15m')!.note,'tracker:third');
 assert.equal(removeTracker(db,store,'third',6000),1);assert.equal(store.find('s','ETHUSD','15m')!.stage,'tracked');
 assert.equal(removeTracker(db,store,'second',7000),1);
});
test('duplicate dimensions do not create duplicate subscriptions or multiply reported evidence',t=>{
 const {db,store}=setup(t);const saved=saveTracker(db,store,{...def('duplicates'),scanners:['s','s'],symbols:['BTCUSD','BTCUSD'],tfs:['15m','15m']},1000);
 assert.equal(saved.added,1);assert.equal(saved.tracker.scanners.length,1);
 db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt,realized_pnl,fees,risk_amount,exit_at,exit_reason) VALUES('closed','s','S','BTCUSD','15m','long',1,0,1,100,2000,2,12,2,10,3000,'tp1')");
 const v=trackerView(db,store,{...saved.tracker,scanners:['s','s']});assert.equal(v.totals.cells,1);assert.equal(v.totals.trades,1);assert.equal(v.totals.sumR,1);
});
test('tracker updates roll back both membership and cell transitions on failure',t=>{
 const {db,store}=setup(t);saveTracker(db,store,def('atomic'),1000);const move=store.move.bind(store);
 store.move=((...args:Parameters<typeof store.move>)=>{const r=move(...args);if(args[0].symbol==='ETHUSD')throw Error('injected failure');return r;});
 assert.throws(()=>saveTracker(db,store,{...def('atomic'),symbols:['ETHUSD']},2000),/injected/);
 assert.deepEqual(listTrackers(db)[0].symbols,['BTCUSD']);assert.equal(store.find('s','BTCUSD','15m')!.stage,'tracked');assert.equal(store.find('s','ETHUSD','15m'),null);
});
test('nested transaction failure can be caught without committing its partial writes',t=>{
 const {db}=setup(t);db.transaction(()=>{db.kvSet('outer',1);assert.throws(()=>db.transaction(()=>{db.kvSet('inner',1);throw Error('abort');}));db.kvSet('after',1);});
 assert.equal(db.kvGet('outer'),1);assert.equal(db.kvGet('after'),1);assert.equal(db.kvGet('inner'),undefined);
});
