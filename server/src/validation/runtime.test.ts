import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { App } from '../app.ts';
import { createValidation } from './runtime.ts';
import { validationRoutes } from './routes.ts';

test('runtime owns validation before HTTP; repeated route registration cannot add trading listeners',async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.validation.walkForward.autoRun=true;cfg.validation.shadow.enabled=true;
 const variants=Object.fromEntries(['ungated','ml-gated'].map(id=>[id,{open:[],closed:[],nextId:1,gated:0,entries:0,rejected:{},curve:[{at:123,equity:1000}]}]));
 const archive={since:123,initialEquity:1000,variants};db.kvSet('shadow.ledger',archive);
 let callback: ((c: typeof cfg)=>void)|undefined;let histories=0,filters=0,lookups=0;
 const scanners=Object.assign(new EventEmitter(),{
   setHistorySource:()=>histories++,setEntryFilter:()=>filters++,setWalkForwardSource:()=>lookups++,marketInfo:()=>{throw new Error('archived ledger must not fetch markets');}
 });
 const candles=Object.assign(new EventEmitter(),{get:()=>[]});
 const app={db,config:{get:()=>cfg,onChange:(fn:typeof callback)=>{callback=fn;return()=>{callback=undefined;};}},scanners,candles,registry:{all:()=>[],get:()=>undefined},rest:{},pool:{}} as unknown as App;
 const validation=createValidation(app);Object.assign(app,{validation});t.after(()=>validation.stop());
 assert.equal(histories,1);assert.equal(filters,1);assert.equal(lookups,1);
 validationRoutes(()=>{},app);validationRoutes(()=>{},app);
 assert.equal(filters,1);assert.equal(lookups,1);
 validation.shadow.attach();await validation.shadow.onSignal({kind:'entry'} as any);
 assert.equal(scanners.listenerCount('signal'),0);assert.equal(candles.listenerCount('bar'),0);
 assert.equal(validation.shadow.snapshot().archived,true);assert.equal(validation.shadow.enabled,false);
 assert.equal(validation.shadow.since,123);assert.deepEqual(db.kvGet('shadow.ledger'),archive);
 assert.equal(cfg.validation.shadow.enabled,true,'archive the old engine without mutating user settings');
 callback!(cfg);assert.equal(histories,2);
 validation.stop();assert.equal(callback,undefined);validation.service.reschedule();
 assert.equal((validation.service as any).timer,null);
});
