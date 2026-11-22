import { DEFAULT_CONFIG } from '../config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { funnelClass } from './store.ts';
import { ShadowRunner } from './shadow.ts';

test('decision 190: a resting order is pending, not opened, in the account\'s funnel', () => {
  assert.equal(funnelClass('pending'), 'pending');
  assert.equal(funnelClass('pending:resting limit at 99.4'), 'pending');
  assert.equal(funnelClass('opened'), 'opened');
});

test('decision 190: a shadow limit counts as opened only when it fills; a lapsed one counts as other', () => {
  const paper = new EventEmitter();
  let saved: any = {};
  const store = { shadowFunnel: () => ({}), setShadowFunnel: (r: any) => { saved = r; }, liveMarks: () => undefined, setLiveMarks: () => {} };
  const runner = new ShadowRunner({ store, paper } as any) as any;
  const key = 's|XUSD|1h';
  runner.note(key, 'pending', 1000); runner.pendingFunnel.set(7, { key, at: 1000 });
  runner.note(key, 'pending', 2000); runner.pendingFunnel.set(8, { key, at: 2000 });
  let f = runner.funnelOf(key, 0);
  assert.deepEqual([f.entries, f.opened, f.pending], [2, 0, 2]);
  paper.emit('order', { positionId: 7, reason: 'entry' });
  paper.emit('pending', { type: 'cancelled', id: 8, reason: 'no fill' });
  f = runner.funnelOf(key, 0);
  assert.deepEqual([f.entries, f.opened, f.pending, f.other, f.lastOpenAt], [2, 1, 0, 1, 1000]);
  paper.emit('order', {positionId:7,reason:'entry'});
  assert.equal(runner.stats.entries,1,'delayed fill counts once; cancellation and duplicate events do not');
  runner.saveFunnel();
  assert.deepEqual(saved[key], [[1000, 'opened'], [2000, 'other']]);
});

test('decision 193: a shadow run that queued while its pair was retired or its scanner re-configured does not act', async () => {
  const { DEFAULT_CONFIG } = await import('../config.ts');
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.incubator.enabled = true;
  let pair: any = { id: 1, scannerId: 's', symbol: 'XUSD', tf: '1h', stage: 'shadow', since: 0, updated: 0, screen: null, gate: null, note: null };
  const bars = Array.from({ length: 80 }, (_, i) => ({ time: Date.now() - (80 - i) * 3600_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  let during: () => void = () => {};
  const entries: any[] = [];
  const paper: any = new EventEmitter(); paper.onEntry = (...a: any[]) => { entries.push(a); return { action: 'opened' }; }; paper.onScriptExit = () => {};
  const runner = new ShadowRunner({
    store: { shadowFunnel: () => ({}), setShadowFunnel: () => {}, liveMarks: () => undefined, setLiveMarks: () => {}, get: () => pair, trades: () => [] },
    cfgRef: () => cfg, candles: { get: () => bars }, registry: { get: () => ({ id: 's', name: 's', status: 'ok', patched: 'src' }) },
    pool: { run: async () => { during(); return { ok: true, alerts: [], shapes: [], labels: [], plots: [], ms: 1 }; } },
    paper, marketInfo: async () => ({ tickSize: 0.01, contractValue: 1 }),
  } as any) as any;
  const go = () => runner.run(pair, Date.now(), false, Date.now());
  await go();
  assert.equal(runner.stats.superseded, 0, 'an unchanged pair is acted on');
  during = () => { pair = { ...pair, stage: 'retired' }; };
  await go();
  assert.equal(runner.stats.superseded, 1, 'retired while queued');
  pair = { ...pair, stage: 'shadow' };
  during = () => { cfg.scanners.s = { enabled: false, symbols: null, timeframes: null, exitMode: 'script' } as any; };
  await go();
  assert.equal(runner.stats.superseded, 2, 're-configured while queued');
});

test('decision 201: with copying off, an exit still reaches the account when it holds the position; entries do not', async () => {
  const { DEFAULT_CONFIG } = await import('../config.ts');
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.incubator.enabled = true; cfg.incubator.mirror = { ...cfg.incubator.mirror!, enabled: false };
  const pair: any = { id: 1, scannerId: 's', symbol: 'XUSD', tf: '1h', stage: 'shadow', since: 0, updated: 0, screen: null, gate: null, note: null };
  const H = 3600_000, last = Math.floor(Date.now() / H) * H - H;
  const bars = Array.from({ length: 80 }, (_, i) => ({ time: last - (79 - i) * H, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  let alerts: any[] = [];
  const forwarded: any[] = [];
  const paper: any = new EventEmitter(); paper.onEntry = () => ({ action: 'opened' }); paper.onScriptExit = () => {}; paper.findOpen = () => undefined; paper.openPositions = () => []; paper.mark = () => 1; paper.recordGatedEntry = () => {};
  let holds = true;
  const runner = new ShadowRunner({
    store: { shadowFunnel: () => ({}), setShadowFunnel: () => {}, liveMarks: () => undefined, setLiveMarks: () => {}, get: () => pair, trades: () => [] },
    cfgRef: () => cfg, candles: { get: () => bars }, registry: { get: () => ({ id: 's', name: 's', status: 'ok', patched: 'alert("x")' }) },
    pool: { run: async () => ({ ok: true, alerts, shapes: [], labels: [], plots: [], ms: 1 }), stats: { queued: 0 }, rssReader: () => 0, memoryGuardBytes: 1 },
    paper, marketInfo: async () => ({ tickSize: 0.01, contractValue: 1 }),
    mirror: (_s: any, _sym: string, _tf: string, ev: any) => forwarded.push(ev.kind),
    accountHolds: () => holds,
  } as any) as any;
  alerts = [{ type: 'alert', time: last, barIndex: 79, message: '🛑 SL HIT | Long | Entry: 1 | SL: 0.9' }];
  await runner.run(pair, Date.now(), true, Date.now());
  assert.deepEqual(forwarded, ['exit'], 'the held position gets its exit');
  assert.equal(runner.stats.exitsForHeld, 1);
  alerts = [{ type: 'alert', time: last, barIndex: 79, message: '🟢 LONG | Price: 1' }];
  runner.seen.clear();
  await runner.run(pair, Date.now(), true, Date.now());
  assert.deepEqual(forwarded, ['exit'], 'no entry is copied while copying is off');
  holds = false;
  alerts = [{ type: 'alert', time: last, barIndex: 79, message: '🎯 TP1 HIT | Long' }];
  runner.seen.clear(); runner.marks = { since: () => 0, advance: () => {}, window: () => ({ since: 0, tailBars: 3, missed: 0 }) };
  await runner.run(pair, Date.now(), true, Date.now());
  assert.deepEqual(forwarded, ['exit'], 'nothing held, nothing forwarded');
});

test('decision 201: the memory guard retires background work first and spares the account\'s live runs', async () => {
  const { PinePool } = await import('../pine/pool.ts');
  const { EventEmitter: EE } = await import('node:events');
  const made: any[] = [];
  const pool = new PinePool(3, undefined, (i: number) => { const w: any = new EE(); w.postMessage = () => {}; w.terminate = () => { w.dead = true; queueMicrotask(() => w.emit('exit', 1)); return Promise.resolve(0); }; made.push(w); setTimeout(() => w.emit('message', { ready: true }), 0); return w; }) as any;
  await new Promise(r => setTimeout(r, 10));
  const job = (id: string) => ({ scannerId: id, source: '', symbol: 'X', tf: '1h', tickSize: 0.01, bars: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }], tailBars: 3 as const });
  const r1 = pool.run(job('live'), { priority: 'live' });
  const r2 = pool.run(job('mirror'), { priority: 'mirror' });
  const r3 = pool.run(job('bg'), { priority: 'background' });
  await new Promise(r => setTimeout(r, 10));
  pool.rssReader = () => pool.memoryGuardBytes + 1;
  pool.reapMemory();
  const out = await r3;
  assert.equal(out.ok, false); assert.match(out.error ?? '', /memory/);
  const busy = pool.workers.filter((w: any) => w?.busy).map((w: any) => w.busy.job.scannerId).sort();
  assert.deepEqual(busy, ['live', 'mirror'], 'the account and the mirror tier keep running');
  pool.stop?.(); void r1; void r2;
});

test('shadow waves wait fairly instead of dropping whole symbols behind a research backlog',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.mirror={enabled:false};
 const runner=new ShadowRunner({store:{shadowFunnel:()=>({}),liveMarks:()=>undefined,setLiveMarks:()=>{},setShadowFunnel:()=>{}},cfgRef:()=>cfg,paper:{openPositions:()=>[]},pool:{size:8,reserved:2,stats:{queued:500,queuedLive:0},rssReader:()=>0,memoryGuardBytes:1}}as any)as any;
 runner.pairs=Array.from({length:500},(_,i)=>({id:i,scannerId:'s'+i,symbol:i<250?'AAAUSD':'BBBUSD',tf:'15m',stage:'shadow'}));
 const seen=new Set<number>();const releases:Array<()=>void>=[];
 runner.run=async(r:any)=>{seen.add(r.id);await new Promise<void>(resolve=>releases.push(resolve));};
 runner.onBarClosed('AAAUSD','15m',Date.now());runner.onBarClosed('BBBUSD','15m',Date.now());t.mock.timers.tick(20_000);
 await new Promise<void>(r=>setImmediate(r));assert.equal(runner.dispatchStats.inFlight,6);assert.equal(runner.dispatchStats.pending,494);assert.equal(runner.stats.skipped,0);
 while(runner.dispatchStats.pending||runner.dispatchStats.inFlight){releases.splice(0).forEach(r=>r());await new Promise<void>(r=>setImmediate(r));}
 assert.equal(seen.size,500);runner.stop();
});

test('research scans continue while completed results await depth without duplicating cells',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1_800_000});
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.mirror={enabled:false};cfg.paper.trendGate={...cfg.paper.trendGate!,enabled:false};
 const rows=['a','b','c','d','e'].map((scannerId,id)=>({id:id+1,scannerId,symbol:'ETHUSD',tf:'15m',stage:'shadow'}));
 const bars=Array.from({length:80},(_,i)=>({time:900_000-(79-i)*900_000,open:100,high:101,low:99,close:100,volume:1}));
 const scanned:string[]=[],entered:string[]=[],depth:Array<()=>void>=[];
 const paper:any=new EventEmitter();paper.openPositions=()=>[];paper.mark=()=>100;paper.recordGatedEntry=()=>{};
 paper.prepareEntryDepth=()=>new Promise<void>(r=>depth.push(r));
 paper.onEntry=(_ev:any,c:any)=>{entered.push(c.scannerId);return{action:'refused',reason:'test gate'};};
 const runner=new ShadowRunner({cfgRef:()=>cfg,paper,candles:{get:()=>bars},
  store:{shadowFunnel:()=>({}),liveMarks:()=>undefined,setLiveMarks:()=>{},setShadowFunnel:()=>{},get:(id:number)=>rows.find(r=>r.id===id)},
  registry:{get:(id:string)=>({id,name:id,status:'ok',patched:'alert("LONG")'})},
  marketInfo:async()=>({tickSize:.01,contractValue:1}),
  pool:{size:3,reserved:2,stats:{queuedLive:0,queuedMirror:0},rssReader:()=>0,memoryGuardBytes:1,run:async(job:any)=>{
   scanned.push(job.scannerId);return{ok:true,alerts:[{type:'alert',time:900_000,barIndex:79,message:'LONG | Price: 100'}],shapes:[],labels:[],plots:[],ms:1};}},
 }as any)as any;
 t.after(()=>runner.stop());runner.pairs=rows;runner.onBarClosed('ETHUSD','15m',Date.now());
 await new Promise<void>(r=>setImmediate(r));
 assert.equal(scanned.length,4,'one compute worker can serve four bounded depth waits');assert.equal(depth.length,4);assert.equal(entered.length,0);
 assert.equal(runner.dispatchStats.settling,4);assert.equal(runner.dispatchStats.pending,1);
 runner.onBarClosed('ETHUSD','15m',Date.now());assert.equal(runner.dispatchStats.offered,5,'the same bar is never duplicated');
 depth.shift()!();await new Promise<void>(r=>setImmediate(r));assert.equal(scanned.length,5);assert.equal(entered.length,1);
 depth.splice(0).forEach(r=>r());await new Promise<void>(r=>setImmediate(r));
 assert.equal(entered.length,5);assert.equal(runner.dispatchStats.inFlight,0);
});

test('held positions stay urgent; unqualified mirror cells use bounded shadow scheduling',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:0};
 const runner=new ShadowRunner({store:{shadowFunnel:()=>({}),liveMarks:()=>undefined,setLiveMarks:()=>{},setShadowFunnel:()=>{},copyRefusal:()=>'mirror held: 0/5 shadow closes',marketsToday:()=>new Map()},cfgRef:()=>cfg,paper:{openPositions:()=>[{scannerId:'held',symbol:'BTCUSD',tf:'15m'}]},mirror:()=>{},pool:{size:8,reserved:2,stats:{queued:0,queuedLive:0},rssReader:()=>0,memoryGuardBytes:1}}as any)as any;
 runner.pairs=['held','research'].map((scannerId,id)=>({id,scannerId,symbol:'BTCUSD',tf:'15m',stage:'shadow'}));
 const got:Array<[string,boolean]>=[];runner.run=async(r:any,_bar:any,live:boolean)=>{got.push([r.scannerId,live]);};runner.onBarClosed('BTCUSD','15m',Date.now());assert.deepEqual(got,[['held',true]]);
 t.mock.timers.tick(20_000);await new Promise<void>(r=>setImmediate(r));assert.deepEqual(got,[['held',true],['research',false]]);runner.stop();
});
test('enrolled forward cells get timely research service while copy holds and worker limits remain intact',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});const cfg=structuredClone(DEFAULT_CONFIG);cfg.incubator.enabled=true;cfg.incubator.mirror={enabled:true,minTrades:5};
 const runner=new ShadowRunner({store:{shadowFunnel:()=>({}),liveMarks:()=>undefined,setLiveMarks:()=>{},setShadowFunnel:()=>{},copyRefusal:()=>'restored cell in forward shadow evaluation',marketsToday:()=>new Map()},cfgRef:()=>cfg,paper:{openPositions:()=>[]},mirror:()=>assert.fail('unqualified entry copied'),pool:{size:3,reserved:2,stats:{queuedLive:0},rssReader:()=>0,memoryGuardBytes:1}}as any)as any;
 runner.pairs=['ordinary','forward'].map((scannerId,id)=>({id,scannerId,symbol:'BTCUSD',tf:'15m',stage:'shadow'}));
 runner.forwardCells=new Set(['forward:BTCUSD:15m']);
 const got:Array<[string,boolean]>=[],releases:Array<()=>void>=[];
 runner.run=async(r:any,_bar:any,live:boolean)=>{got.push([r.scannerId,live]);await new Promise<void>(resolve=>releases.push(resolve));};
 runner.onBarClosed('BTCUSD','15m',Date.now());await new Promise<void>(r=>setImmediate(r));
 assert.deepEqual(got,[['forward',false]]);assert.equal(runner.dispatchStats.inFlight,1);assert.equal(runner.dispatchStats.pending,1);
 releases.shift()!();await new Promise<void>(r=>setImmediate(r));assert.deepEqual(got,[['forward',false],['ordinary',false]]);
 releases.shift()!();await new Promise<void>(r=>setImmediate(r));runner.stop();
});

test('shadow dispatch ranks account exits and qualified copies globally without upgrading unqualified cells', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const cfg=structuredClone(DEFAULT_CONFIG); cfg.incubator.enabled=true;
  cfg.incubator.mirror={enabled:true,minTrades:5};
  const runner=new ShadowRunner({
    store:{shadowFunnel:()=>({}),liveMarks:()=>undefined,setLiveMarks:()=>{},setShadowFunnel:()=>{},
      copyRefusal:(r:any)=>r.scannerId==='copy'?null:'mirror held: insufficient evidence',marketsToday:()=>new Map()},
    cfgRef:()=>cfg, paper:{openPositions:()=>[{scannerId:'held',symbol:'AAAUSD',tf:'15m'}]},
    mirror:()=>{}, accountHolds:(id:string)=>id==='account',
    pool:{size:8,reserved:2,stats:{queuedLive:1},rssReader:()=>0,memoryGuardBytes:1},
  } as any) as any;
  t.after(()=>runner.stop());
  runner.pairs=['held','unqualified','copy','account'].map((scannerId,id)=>({
    id,scannerId,symbol:scannerId==='held'||scannerId==='unqualified'?'AAAUSD':'BBBUSD',tf:'15m',stage:'shadow'}));
  const got:Array<[string,boolean,number|undefined]>=[];
  runner.run=async(r:any,_bar:number,live:boolean,_seen:number,rank?:number)=>{got.push([r.scannerId,live,rank]);};
  runner.onBarClosed('AAAUSD','15m',Date.now());
  runner.onBarClosed('BBBUSD','15m',Date.now());
  assert.deepEqual(got,[['held',true,1],['copy',true,2],['account',true,3]]);
  assert.equal(runner.dispatchStats.pending,1,'unqualified research is still bounded behind account work');
});

test('capped shadow diagnostics are labelled without changing counts or evidence', () => {
  const store={shadowFunnel:()=>({}),setShadowFunnel:()=>{},liveMarks:()=>undefined,setLiveMarks:()=>{}};
  const runner=new ShadowRunner({store,paper:new EventEmitter()} as any) as any;
  const key='s|ETHUSD|15m';
  for(let i=1;i<=119;i++)runner.note(key,'opened',i);
  assert.equal(runner.funnelOf(key,0).historyCapped,false);
  runner.note(key,'opened',120);
  assert.equal(runner.funnelOf(key,0).historyCapped,true);
  runner.note(key,'other',121);
  const f=runner.funnelOf(key,0);
  assert.equal(f.entries,120);assert.equal(f.opened,119);assert.equal(f.other,1);
  assert.equal(f.retainedSince,2);
  assert.equal(runner.funnelOf(key,100).historyCapped,false);
  assert.equal(runner.funnelOf('missing',0).historyCapped,false);
  runner.stop();
});
