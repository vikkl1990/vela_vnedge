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
  const paper: any = new EventEmitter(); paper.onEntry = () => ({ action: 'opened' }); paper.onScriptExit = () => {}; paper.openPositions = () => []; paper.mark = () => 1;
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
