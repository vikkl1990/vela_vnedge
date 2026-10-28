import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ScannerEngine } from './engine.ts';
import type { WorkerResult } from '../pine/worker.ts';

for (const change of ['none', 'disabled', 'removed', 'reenabled', 'timeframe'] as const) {
  test(`pending 1m scanner run respects ${change} configuration`, async t => {
    const db = new Db(':memory:');
    t.after(() => db.db.close());
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.symbols = ['BTCUSD']; cfg.timeframes = ['1m'];
    cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'BTCUSD', tf: '1m' }] };
    cfg.paper.latencyMs = 0; // this test is about configuration changes between dispatch and result, not the fill model
    // anchor to real time: the entry path rejects signals whose bar closed more than
    // paper.maxSignalAgeSec ago, and epoch-0 fixtures would read as decades stale
    const lastClose = Math.floor(Date.now() / 60_000) * 60_000;
    const bars = Array.from({ length: 60 }, (_, i) => ({ time: lastClose - (60 - i) * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
    const candles = Object.assign(new EventEmitter(), { get: () => bars });
    let finish!: (result: WorkerResult) => void;
    const pool = { stats: { queued: 0 }, run: () => new Promise<WorkerResult>(resolve => { finish = resolve; }) };
    const scanner = { id: 's', name: 'Test', status: 'ok', patched: '' };
    const paper = new PaperEngine(db, () => cfg);
    const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper,
      candles: candles as any, pool: pool as any,
      registry: { all: () => [scanner] } as any,
      rest: { product: async () => ({ tick_size: '0.25', contract_value: '1' }) } as any });
    const complete = once(engine, 'scanner');
    candles.emit('closed', { symbol: 'BTCUSD', tf: '1m', bar: bars.at(-1)! });
    await setImmediate();
    assert.equal(typeof finish, 'function', '1m close must dispatch a job');
    if (change === 'disabled') cfg.scanners.s = { ...cfg.scanners.s, enabled: false };
    if (change === 'removed') cfg.scanners.s = { ...cfg.scanners.s, enabled: false, hidden: true };
    if (change === 'reenabled') cfg.scanners.s = { ...cfg.scanners.s, enabled: true };
    if (change === 'timeframe') cfg.scanners.s = { ...cfg.scanners.s, pairs: [{ symbol: 'BTCUSD', tf: '5m' }] };
    finish({ id: 1, ok: true, ms: 1, bars: bars.length, lastBarTime: bars.at(-1)!.time, warnings: 0,
      plots: [], shapes: [], labels: [], alerts: [{ type: 'alert', barIndex: 59, time: bars.at(-1)!.time,
        message: 'LONG | Entry: 100 | SL: 95 | TP1: 105 | TP2: 110 | TP3: 115' }] });
    await complete;
    // decision 184: the configuration is compared by value, so a scanner disabled and re-enabled unchanged while its run
    // was in flight trades its result; a scanner left disabled, removed, or on another timeframe does not
    const trades = change === 'none' || change === 'reenabled' ? 1 : 0;
    assert.equal(paper.openPositions().length, trades);
    assert.equal(db.all('SELECT * FROM signals').length, trades);
  });
}

test('audit 4: a bar that closes during a running job is not dropped, it runs next', async t => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.symbols = ['BTCUSD']; cfg.timeframes = ['1m'];
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'BTCUSD', tf: '1m' }] };
  const lastClose = Math.floor(Date.now() / 60_000) * 60_000;
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: lastClose - (60 - i) * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  const candles = Object.assign(new EventEmitter(), { get: () => bars });
  const finishers: Array<(r: WorkerResult) => void> = [];
  const pool = { stats: { queued: 0 }, run: () => new Promise<WorkerResult>(resolve => { finishers.push(resolve); }) };
  const scanner = { id: 's', name: 'Test', status: 'ok', patched: '' };
  const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper: new PaperEngine(db, () => cfg),
    candles: candles as any, pool: pool as any,
    registry: { all: () => [scanner] } as any,
    rest: { product: async () => ({ tick_size: '0.25', contract_value: '1' }) } as any });

  const idle = (r: WorkerResult) => ({ ...r });
  const result = (): WorkerResult => ({ id: 1, ok: true, ms: 1, bars: bars.length, lastBarTime: bars.at(-1)!.time, warnings: 0, plots: [], shapes: [], labels: [], alerts: [] });

  candles.emit('closed', { symbol: 'BTCUSD', tf: '1m', bar: bars.at(-1)! });
  await setImmediate();
  assert.equal(finishers.length, 1, 'first bar dispatched');
  // a second bar closes while the first job is still in flight
  candles.emit('closed', { symbol: 'BTCUSD', tf: '1m', bar: bars.at(-1)! });
  await setImmediate();
  assert.equal(finishers.length, 1, 'the second bar is deferred, not run concurrently');
  finishers[0](idle(result()));
  for (let i = 0; i < 10 && finishers.length < 2; i++) await setImmediate();
  assert.equal(finishers.length, 2, 'the deferred bar runs once the first job finishes');
  finishers[1](idle(result()));
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(finishers.length, 2, 'and it does not loop');
});

test('a scanner the configuration has never seen is off, not on', async t => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.symbols = ['BTCUSD']; cfg.timeframes = ['15m'];
  cfg.scanners.known = { enabled: true, symbols: ['BTCUSD'], timeframes: null, exitMode: 'both' };   // decision 79: its own symbols, never the global list
  const scanners = [
    { id: 'known', name: 'Configured and on', status: 'ok', patched: '' },
    { id: 'freshly-imported', name: 'Never configured', status: 'ok', patched: '' },
  ];
  const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper: new PaperEngine(db, () => cfg),
    candles: Object.assign(new EventEmitter(), { get: () => [] }) as any,
    pool: { stats: { queued: 0 }, run: async () => ({}) } as any,
    registry: { all: () => scanners } as any, rest: {} as any });

  assert.equal(engine.isActive(scanners[0] as any), true, 'an explicitly enabled scanner still runs');
  assert.equal(engine.isActive(scanners[1] as any), false, 'an imported scanner must not trade until someone enables it');
  // and it contributes no work: importing a thousand scripts must not touch the candle feed
  assert.deepEqual(engine.requiredSeries().map(r => r.symbol), ['BTCUSD']);
  assert.equal(engine.scannerConfig('freshly-imported').enabled, false);
});

test('explicit pairs replace the symbols × timeframes product (decision 70)', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.symbols = ['BTCUSD', 'ETHUSD']; cfg.timeframes = ['15m'];
  cfg.scanners.p = { enabled: true, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'UNIUSD', tf: '1h' }, { symbol: 'ZECUSD', tf: '4h' }] } as any;
  cfg.scanners.q = { enabled: true, symbols: ['BTCUSD', 'ETHUSD'], timeframes: null, exitMode: 'both' } as any;
  cfg.scanners.bare = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' } as any;
  const scanner = (id: string) => ({ id, name: id, status: 'ok', patched: 'x', source: 'x' } as any);
  const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper: new PaperEngine(db, () => cfg), candles: { on() {}, get: () => [], track: async () => {}, has: () => true } as any, pool: {} as any, registry: { all: () => [scanner('p'), scanner('q')], get: (id: string) => scanner(id) } as any, rest: { product: async () => ({}) } as any });
  assert.deepEqual(engine.pairsFor('p'), [{ symbol: 'UNIUSD', tf: '1h' }, { symbol: 'ZECUSD', tf: '4h' }]);
  assert.deepEqual(engine.symbolsFor('p'), ['UNIUSD', 'ZECUSD']); assert.deepEqual(engine.timeframesFor('p'), ['1h', '4h']);
  assert.equal(engine.runsOn('p', 'UNIUSD', '1h'), true); assert.equal(engine.runsOn('p', 'UNIUSD', '4h'), false, 'a pair is a market AND a timeframe');
  assert.deepEqual(engine.pairsFor('q'), [{ symbol: 'BTCUSD', tf: '15m' }, { symbol: 'ETHUSD', tf: '15m' }], 'no pairs → its own symbols × timeframes');
  assert.deepEqual(engine.pairsFor('bare'), [], 'decision 79: no symbols of its own → it runs nowhere, the global list never feeds a scanner');
  assert.deepEqual(engine.requiredSeries().map(r => `${r.symbol}:${r.tf}`).sort(), ['BTCUSD:15m', 'ETHUSD:15m', 'UNIUSD:1h', 'ZECUSD:4h']);
  db.db.close();
});

test('decision 116: a mirrored shadow event goes down the live path — signal row, gates, paper engine — with its label marked', async t => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.incubator.mirror!.enabled = true;
  cfg.symbols = ['BTCUSD']; cfg.timeframes = ['1m'];
  cfg.paper.latencyMs = 0; cfg.paper.requireQuote = false; cfg.paper.minRiskFeeRatio = 0;
  cfg.risk.regime = { ...cfg.risk.regime, enabled: false }; cfg.paper.trendGate = { enabled: false, emaLen: 50, tf: '', mode: 'follow' };
  const lastClose = Math.floor(Date.now() / 60_000) * 60_000;
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: lastClose - (60 - i) * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
  const candles = Object.assign(new EventEmitter(), { get: () => bars });
  const pool = { stats: { queued: 0 }, run: () => new Promise<WorkerResult>(() => {}) };
  const scanner = { id: 'shadow-only', name: 'Shadow Only', status: 'ok', patched: '' };
  const paper = new PaperEngine(db, () => cfg);
  paper.setMark('BTCUSD', 100);
  const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper, candles: candles as any, pool: pool as any, registry: { all: () => [scanner], get: () => scanner } as any, rest: { product: async () => ({ tick_size: '0.25', contract_value: '1' }) } as any });
  const ev = { kind: 'entry', side: 'long', price: 100, sl: 98, tp: [102, 104, 106], barTime: bars.at(-1)!.time, barIndex: 59, source: 'alert', label: 'LONG', message: 'long' } as any;
  engine.ingestEvent(scanner as any, 'BTCUSD', '1m', ev, bars as any, { contractValue: 1, tickSize: 0.25 }, 'both', bars.at(-1)! as any);
  const rows = db.all<any>('SELECT label, action, scanner_id FROM signals');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'LONG (shadow mirror)');
  assert.equal(rows[0].scanner_id, 'shadow-only');
  assert.equal(rows[0].action, 'opened', `the account opened it: ${rows[0].action}`);
  assert.equal(paper.openPositions().length, 1);
  // the same event again is a duplicate on the signals table, not a second position
  engine.ingestEvent(scanner as any, 'BTCUSD', '1m', ev, bars as any, { contractValue: 1, tickSize: 0.25 }, 'both', bars.at(-1)! as any);
  assert.equal(db.all<any>('SELECT 1 FROM signals').length, 1);
});

test('depth preparation completes before entry gates and expiry are rechecked',async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.mirror!.enabled=true;
 Object.assign(cfg.paper,{latencyMs:0,requireQuote:false,useSpread:false,minRiskFeeRatio:0,skipScriptStops:false,trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'},maxSignalAgeSec:60});
 cfg.risk.regime.enabled=false;
 const now=Date.now(),lastClose=Math.floor(now/60000)*60000;
 const bars=Array.from({length:60},(_,i)=>({time:lastClose-(60-i)*60000,open:100,high:101,low:99,close:100,volume:100}));
 const paper=new PaperEngine(db,()=>cfg);paper.setMark('BTCUSD',100);
 let finish!:()=>void,halted=false;paper.prepareEntryDepth=()=>new Promise<void>(r=>finish=r);
 paper.risk={gate:()=>halted?{reject:'manual halt',leverageMult:1}:{leverageMult:1},exposureCheck:()=>null};
 const scanner={id:'s',name:'s',status:'ok',patched:''};
 const engine=new ScannerEngine({db,cfgRef:()=>cfg,paper,candles:Object.assign(new EventEmitter(),{get:()=>bars})as any,pool:{}as any,registry:{all:()=>[scanner],get:()=>scanner}as any,rest:{}as any});
 const ev={kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],barTime:bars.at(-1)!.time,barIndex:59,source:'alert',label:'LONG',message:'long'}as any;
 const task=engine.ingestEvent(scanner as any,'BTCUSD','1m',ev,bars as any,{contractValue:1,tickSize:.25},'both',bars.at(-1)!as any);
 assert.equal(paper.openPositions().length,0);halted=true;finish();await task;
 assert.equal(paper.openPositions().length,0);assert.match(db.get<any>('SELECT action FROM signals')!.action,/manual halt/);
 // A signal that was already old when depth arrived must not be revived by the new quote.
 paper.prepareEntryDepth=async()=>{};halted=false;await engine.ingestEvent(scanner as any,'BTCUSD','1m',{...ev,label:'old',barTime:ev.barTime-300000},bars as any,{contractValue:1,tickSize:.25},'both',bars.at(-1)!as any);
 assert.match(db.get<any>("SELECT action FROM signals WHERE label LIKE 'old%'")!.action,/stale signal/);
});

test('a recovered account scan emits its signal once and logs both attempts',async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.symbols=['BTCUSD'];cfg.timeframes=['1m'];cfg.paper.latencyMs=0;
 cfg.scanners.s={enabled:true,symbols:null,timeframes:null,exitMode:'both',pairs:[{symbol:'BTCUSD',tf:'1m'}]};
 const close=Math.floor(Date.now()/60000)*60000;
 const bars=Array.from({length:60},(_,i)=>({time:close-(60-i)*60000,open:100,high:101,low:99,close:100,volume:100}));
 const candles=Object.assign(new EventEmitter(),{get:()=>bars});let n=0;
 const pool={stats:{queued:0},rssReader:()=>0,memoryGuardBytes:100,run:async()=>{
 n++;return {id:n,ok:n>1,error:n===1?'memory-shared: test pressure':undefined,ms:1,bars:60,lastBarTime:bars.at(-1)!.time,warnings:0,plots:[],shapes:[],labels:[],alerts:n===1?[]:[{type:'alert',barIndex:59,time:bars.at(-1)!.time,message:'LONG | Entry: 100 | SL: 95 | TP1: 105 | TP2: 110 | TP3: 115'}]};}};
 const scanner={id:'s',name:'Test',status:'ok',patched:''};const paper=new PaperEngine(db,()=>cfg);
 const engine=new ScannerEngine({db,cfgRef:()=>cfg,paper,candles:candles as any,pool:pool as any,registry:{all:()=>[scanner]}as any,rest:{product:async()=>({tick_size:'.25',contract_value:'1'})}as any});
 const done=once(engine,'scanner');candles.emit('closed',{symbol:'BTCUSD',tf:'1m',bar:bars.at(-1)!});await done;
 assert.equal(n,2);assert.equal(engine.recovery.counts.recovered,1);assert.equal(paper.openPositions().length,1);
 assert.equal(db.get<any>('SELECT count(*) n FROM signals')!.n,1);
 assert.deepEqual(db.all<any>('SELECT outcome FROM scanner_run_log').map(r=>r.outcome),['failed','ok']);
});
