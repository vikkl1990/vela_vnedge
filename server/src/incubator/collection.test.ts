import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {ShadowRunner} from './shadow.ts';
import {IncubatorStore} from './store.ts';

const TF=900_000,CLOSE=100*TF;
function fixture(t:any) {
 t.mock.timers.enable({apis:['Date','setTimeout'],now:CLOSE+30_000});
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db);
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.mirror={enabled:false};cfg.paper.maxSignalAgeSec=300;
 const pair=store.move({scannerId:'s',symbol:'BTCUSD',tf:'15m'},'shadow','screen');
 let readiness:string|null=null;
 const candles:any=new EventEmitter();Object.assign(candles,{has:()=>true,track:async()=>{},scanReadiness:()=>readiness,get:()=>[{time:CLOSE-TF}]});
 const runner:any=new ShadowRunner({store,cfgRef:()=>cfg,candles,registry:{get:()=>({status:'ok'})},paper:{openPositions:()=>[],pendingEntries:()=>[]},pool:{size:8,reserved:2,stats:{queuedLive:0},rssReader:()=>0,memoryGuardBytes:1}}as any);
 t.after(()=>runner.stop());const seen:number[]=[];
 runner.run=async(r:any,barAt:number)=>{seen.push(barAt);runner.marks.advance(`${r.scannerId}:${r.symbol}:${r.tf}`,barAt-TF);};
 return {db,store,cfg,pair,runner,candles,seen,block:(v:string|null)=>{readiness=v;}};
}
const flush=()=>new Promise<void>(r=>setImmediate(r));

test('startup recovers a fresh close once, deduplicates a concurrent WS event and repeated syncs',async t=>{
 const f=fixture(t);await Promise.all([f.runner.sync(),f.runner.sync()]);
 assert.equal(f.store.shadowScanActivity(f.pair)?.status,'scheduled');
 f.runner.onBarClosed('BTCUSD','15m',CLOSE);await f.runner.sync();
 t.mock.timers.tick(20_000);await flush();assert.deepEqual(f.seen,[CLOSE]);
 await f.runner.sync();f.runner.onBarClosed('BTCUSD','15m',CLOSE);t.mock.timers.tick(20_000);await flush();
 assert.deepEqual(f.seen,[CLOSE]);assert.equal(f.runner.dispatchStats.offered,1);
});

test('catch-up cannot bypass candle repair, disconnection, stale-entry budget or an existing watermark',async t=>{
 const f=fixture(t);f.block('candle repair in progress');await f.runner.sync();assert.equal(f.runner.scheduledBars.size,0);
 f.block('market feed disconnected');await f.runner.sync();assert.equal(f.runner.scheduledBars.size,0);
 f.block(null);f.runner.marks.advance('s:BTCUSD:15m',CLOSE-TF);await f.runner.sync();assert.equal(f.runner.scheduledBars.size,0);
 // A new runner has no recent watermark, but the close has become stale.
 f.runner.marks={get:()=>undefined};t.mock.timers.tick(270_000);await f.runner.sync();assert.equal(f.runner.scheduledBars.size,0);
 assert.equal(f.seen.length,0);
});

test('failed execution releases the scheduled key; a retry stays subject to the original deadline',async t=>{
 const f=fixture(t);f.runner.run=async()=>{throw Error('worker unavailable');};await f.runner.sync();
 t.mock.timers.tick(20_000);await flush();assert.equal(f.runner.scheduledBars.size,0);assert.equal(f.store.shadowScanActivity(f.pair)?.status,'failed');
 f.runner.run=async()=>{f.seen.push(CLOSE);};await f.runner.sync();t.mock.timers.tick(20_000);await flush();assert.deepEqual(f.seen,[CLOSE]);
});

test('scan receipts preserve the latest bar and success independently, and never become evidence',t=>{
 const f=fixture(t);f.store.noteShadowScan(f.pair,CLOSE,'scheduled',null,0,CLOSE+TF);
 f.store.noteShadowScan(f.pair,CLOSE-TF,'scanned',null,3,CLOSE+TF+1);
 let scan=f.store.shadowScanActivity(f.pair)!;assert.equal(scan.status,'scheduled');assert.equal(scan.bar_time,CLOSE);assert.equal(scan.last_success_bar,CLOSE-TF);
 f.store.noteShadowScan(f.pair,CLOSE,'scanned',null,0,CLOSE+TF+2);scan=f.store.shadowScanActivity(f.pair)!;
 assert.equal(scan.last_success_bar,CLOSE);assert.equal(scan.entry_signals,0);
 assert.equal(f.store.trades('s','BTCUSD','15m',2).length,0);assert.deepEqual({...f.store.shadowEntriesSince(f.pair,0)},{filled:0,open:0,pending:0});
});

test('collection status distinguishes a completed zero-signal scan from overdue and repair-blocked work',async t=>{
 const f=fixture(t);await f.runner.sync();t.mock.timers.tick(20_000);await flush();
 assert.equal(f.runner.collectionOf(f.pair,CLOSE).status,'up to date');
 t.mock.timers.tick(TF+300_000);assert.equal(f.runner.collectionOf(f.pair,CLOSE).status,'scan overdue');
 f.block('candle repair in progress');assert.equal(f.runner.collectionOf(f.pair,CLOSE).status,'candle repair in progress');
 assert.equal(f.runner.collectionOf(f.pair,CLOSE).funnel.entries,0);
});
