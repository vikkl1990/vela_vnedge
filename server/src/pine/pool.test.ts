import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PinePool } from './pool.ts';
import { workerBudget } from './pool.ts';
import type { WorkerJob, WorkerResult } from './worker.ts';

class FakeWorker extends EventEmitter {
  jobs: WorkerJob[] = [];
  terminated = 0;
  postMessage(job: WorkerJob) { this.jobs.push(job); }
  async terminate() { this.terminated++; return 1; }
  ready() { this.emit('message', { ready: true }); }
  finish() { const job = this.jobs.at(-1)!; this.emit('message', { id: job.id, ok: true }); }
}
const job: Omit<WorkerJob, 'id'> = { scannerId: 's', source: '', symbol: 'BTCUSD', tf: '1m', tickSize: 0.5, bars: [], tailBars: 1, plotTail: 1 };
function setup() {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(1, 100, () => { const w = new FakeWorker(); workers.push(w); return w; });
  return { pool, workers };
}

test('crash plus exit creates one replacement and preserves queued jobs', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const first = pool.run(job), second = pool.run(job);
  assert.equal(workers[0].jobs.length, 0, 'waits for readiness');
  workers[0].ready();
  workers[0].emit('error', new Error('crash'));
  assert.equal((await first).ok, false);
  assert.equal(workers.length, 1, 'replacement waits for exit');
  workers[0].emit('exit', 1);
  workers[0].emit('exit', 1);
  assert.equal(workers.length, 2);
  workers[1].ready(); workers[1].finish();
  assert.equal((await second).ok, true);
  assert.equal(pool.stats.queued, 0);
});

test('timeout retires slot until exit and cannot spawn twice', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 });
  const { pool, workers } = setup(); t.after(() => pool.stop());
  workers[0].ready();
  const first = pool.run(job);
  t.mock.timers.tick(5_001);
  assert.match((await first).error!, /timeout/);
  const second = pool.run(job);
  assert.equal(workers[0].jobs.length, 1, 'retired worker receives no new work');
  workers[0].emit('exit', 1);
  assert.equal(workers.length, 2);
  workers[1].ready(); workers[1].finish();
  assert.equal((await second).ok, true);
});

test('unexpected clean exit settles busy work; stop settles all pending work without respawn', async () => {
  const { pool, workers } = setup(); workers[0].ready();
  const first = pool.run(job);
  workers[0].emit('exit', 0);
  assert.equal((await first).ok, false);
  workers[1].ready();
  const busy = pool.run(job), queued = pool.run(job);
  await pool.stop();
  for (const result of await Promise.all([busy, queued, pool.run(job)])) assert.match(result.error!, /stopped/);
  workers[1].emit('exit', 1);
  assert.equal(workers.length, 2);
});

test('real worker becomes ready and executes a Pine job', { timeout: 30_000 }, async t => {
  const pool = new PinePool(1, 20_000);
  t.after(() => pool.stop());
  const result = await pool.run({ ...job, source: '//@version=5\nindicator("Smoke")\nplot(close)',
    bars: Array.from({ length: 60 }, (_, i) => ({ time: i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 })) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.bars, 60);
});

test('live jobs dispatch before queued background work', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const bg1 = pool.run({ ...job, scannerId: 'bg1' }), bg2 = pool.run({ ...job, scannerId: 'bg2' });
  const live = pool.run({ ...job, scannerId: 'live' }, { priority: 'live' });
  assert.equal(pool.stats.queuedLive, 1);
  workers[0].ready();
  assert.equal(workers[0].jobs[0].scannerId, 'live', 'the live job overtakes background work queued before it');
  workers[0].finish(); assert.equal((await live).ok, true);
  workers[0].finish(); workers[0].finish();
  assert.deepEqual(workers[0].jobs.map(j => j.scannerId), ['live', 'bg1', 'bg2']);
  await Promise.all([bg1, bg2]);
});

test('decision 268: a higher-ranked live job overtakes queued lower-ranked ones; equal ranks keep arrival order', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const run = (id: string, rank?: number) => pool.run({ ...job, scannerId: id }, { priority: 'live', ...(rank === undefined ? {} : { rank }) });
  // a bar close queues every timeframe that ended at that instant, the shortest first: 15m, 15m, 1h, unranked, 4h, 1h
  const all = [run('a15', 900), run('b15', 900), run('c1h', 3600), run('plain'), run('d4h', 14400), run('e1h', 3600)];
  workers[0].ready();
  for (let i = 0; i < 6; i++) workers[0].finish();
  await Promise.all(all);
  assert.deepEqual(workers[0].jobs.map(j => j.scannerId), ['d4h', 'c1h', 'e1h', 'a15', 'b15', 'plain']);
});

test('decision 268: rank does not lift a live job past its deadline, nor past the mirror and background queues', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 });
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const bg = pool.run({ ...job, scannerId: 'bg' });
  const mirror = pool.run({ ...job, scannerId: 'mirror' }, { priority: 'mirror' });
  const old = pool.run({ ...job, scannerId: 'old4h' }, { priority: 'live', rank: 14400, deadlineMs: 5_000 });
  t.mock.timers.tick(6_000);
  const fresh = pool.run({ ...job, scannerId: 'fresh15m' }, { priority: 'live', rank: 900 });
  workers[0].ready();
  assert.equal((await old).ok, false, 'the old job was dropped, not run late');
  assert.equal(workers[0].jobs[0].scannerId, 'fresh15m', 'live still precedes mirror and background');
  workers[0].finish(); workers[0].finish(); workers[0].finish();
  await Promise.all([bg, mirror, fresh]);
  assert.deepEqual(workers[0].jobs.map(j => j.scannerId), ['fresh15m', 'mirror', 'bg']);
});

test('a live job that waited past its deadline is dropped, not run late', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 });
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const live = pool.run(job, { priority: 'live' });
  t.mock.timers.tick(241_000);
  workers[0].ready();
  const r = await live;
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /expired/);
  assert.equal(workers[0].jobs.length, 0);
  assert.equal(pool.stats.expiredLive, 1);
});

test('mirror ranking serves account exits and eligible copies before shadow positions across symbols', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const jobs: Array<[string, 'live' | 'mirror' | 'shadow' | 'background', number?]> = [
    ['research', 'background'], ['shadow-scan', 'shadow'], ['shadow-held-a', 'mirror', 1],
    ['copy-a', 'mirror', 2], ['shadow-held-b', 'mirror', 1], ['copy-b', 'mirror', 2],
    ['account-exit', 'mirror', 3], ['account-direct', 'live'],
  ];
  const pending = jobs.map(([id, priority, rank]) => pool.run(
    { ...job, scannerId: id, symbol: id.toUpperCase() }, { priority, rank }));
  workers[0].ready();
  for (const _ of jobs) workers[0].finish();
  assert.deepEqual(workers[0].jobs.map(j => j.scannerId), [
    'account-direct', 'account-exit', 'copy-a', 'copy-b',
    'shadow-held-a', 'shadow-held-b', 'shadow-scan', 'research',
  ]);
  assert.ok((await Promise.all(pending)).every(r => r.ok), 'all shadow exits still run');
});

test('a ranked mirror job cannot survive its original freshness deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 });
  const { pool, workers } = setup(); t.after(() => pool.stop());
  const stale = pool.run({ ...job, scannerId: 'old-copy' }, { priority: 'mirror', rank: 3, deadlineMs: 1_000 });
  t.mock.timers.tick(2_000);
  const fresh = pool.run({ ...job, scannerId: 'fresh-held' }, { priority: 'mirror', rank: 1, deadlineMs: 1_000 });
  workers[0].ready(); workers[0].finish();
  assert.equal((await stale).ok, false);
  assert.equal((await fresh).ok, true);
  assert.deepEqual(workers[0].jobs.map(j => j.scannerId), ['fresh-held']);
  assert.equal(pool.stats.expiredMirror, 1);
});

test('background work never takes the reserved workers', async t => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(4, 100, () => { const w = new FakeWorker(); workers.push(w); return w; });
  t.after(() => pool.stop());
  assert.equal(pool.reserved, 1, 'a quarter of four workers, at least one');
  for (const w of workers) w.ready();

  const dispatched = () => workers.reduce((n, w) => n + w.jobs.length, 0);
  // distinct jobs: identical in-flight jobs would be coalesced (S6) and never fill the workers
  for (let i = 0; i < 12; i++) void pool.run({ ...job, scannerId: `bg${i}` });
  assert.equal(dispatched(), 3, 'three of four workers on background work; one stays free for a bar close');

  // a live job takes the reserved worker immediately, without waiting for background work to finish
  void pool.run({ ...job, scannerId: 'live' }, { priority: 'live' });
  assert.equal(dispatched(), 4);

  workers.find(w => w.jobs.length)!.finish();
  await new Promise(r => setImmediate(r));
  assert.equal(dispatched(), 5, 'the freed worker picks up the next background job');
});

test('a background job whose deadline passes while queued is dropped unrun', async t => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(2, 100, () => { const w = new FakeWorker(); workers.push(w); return w; });
  t.after(() => pool.stop());
  for (const w of workers) w.ready();

  void pool.run({ ...job, scannerId: 'a' }); void pool.run({ ...job, scannerId: 'b' });   // both workers busy, so the next job waits
  const late = pool.run({ ...job, scannerId: 'c' }, { deadlineMs: 1 });
  const before = workers.reduce((n, w) => n + w.jobs.length, 0);
  await new Promise(r => setTimeout(r, 10));
  workers.find(w => w.jobs.length)!.finish();            // pumps the queue after the deadline passed

  const r = await late;
  assert.equal(r.ok, false);
  assert.match(String((r as any).error), /too late to be useful/);
  assert.equal(workers.reduce((n, w) => n + w.jobs.length, 0), before, 'it never reached a worker');
  assert.equal(pool.stats.expiredBackground, 1);
});

test('a worker due for recycling keeps serving a live burst and recycles when the burst is over (decision 342)', async () => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(1, 100, () => { const w = new FakeWorker(); workers.push(w); return w; }, 2);
  workers[0].ready();
  const burst = Array.from({ length: 5 }, (_, i) => pool.run({ ...job, symbol: `S${i}` }, { priority: 'live', rank: 300 }));
  for (let i = 0; i < 4; i++) { await Promise.resolve(); workers[0].finish(); await burst[i]; }
  assert.equal(workers[0].terminated, 0, 'four runs against a budget of two, but live jobs were still waiting');
  await Promise.resolve(); workers[0].finish(); await burst[4];
  assert.equal(workers[0].terminated, 1, 'recycled once the live queue emptied');
  assert.equal(workers[0].jobs.length, 5);
  workers[0].emit('exit', 0);
  await pool.stop();
});

test('a live burst cannot postpone a recycle past four times the budget', async () => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(1, 100, () => { const w = new FakeWorker(); workers.push(w); return w; }, 2);
  workers[0].ready();
  const burst = Array.from({ length: 10 }, (_, i) => pool.run({ ...job, symbol: `S${i}` }, { priority: 'live', rank: 300 }));
  for (let i = 0; i < 8; i++) { await Promise.resolve(); workers[0].finish(); await burst[i]; }
  assert.equal(workers[0].terminated, 1, 'retired at eight runs although two live jobs wait');
  workers[0].emit('exit', 0); workers[1].ready();
  for (let i = 8; i < 10; i++) { await Promise.resolve(); workers[1].finish(); await burst[i]; }
  await pool.stop();
});

test('a worker is recycled after maxRuns jobs: terminated once, replaced on exit, the next job runs on the replacement', async () => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(1, 100, () => { const w = new FakeWorker(); workers.push(w); return w; }, 3);
  workers[0].ready();
  for (let i = 0; i < 3; i++) { const p = pool.run({ ...job }); await Promise.resolve(); workers[0].finish(); await p; }
  assert.equal(workers[0].terminated, 1, 'retired after the third job');
  assert.equal(pool.stats.recycled, 1);
  workers[0].emit('exit', 0);
  assert.equal(workers.length, 2, 'the exit spawned a replacement');
  workers[1].ready();
  const p4 = pool.run({ ...job }); await Promise.resolve();
  assert.equal(workers[1].jobs.length, 1, 'the fourth job went to the new worker');
  workers[1].finish(); await p4;
  await pool.stop();
});

test('decision 78: the worker count fits 60% of the memory limit at the heap cap', () => {
  const G = 1_073_741_824;
  assert.deepEqual(workerBudget(10 * G, 1024, 8), { workers: 6, heapMb: 1024, limitMb: 10240 });   // the VM: 10 GB cgroup, 8 cores
  assert.equal(workerBudget(4 * G, 1024, 8).workers, 2, 'never fewer than two');
  assert.equal(workerBudget(64 * G, 1024, 4).workers, 4, 'never more than the cores');
  assert.equal(workerBudget(64 * G, 1024, 32).workers, 12, 'capped at twelve');
  assert.equal(workerBudget(10 * G, 1536, 8).workers, 4, 'a bigger heap means fewer workers, not a bigger sum');
});

test('memory watchdog: aggregate pressure with one busy worker retires it without blaming its script', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  pool.memoryGuardBytes = 1000;
  let rss = 500;
  pool.rssReader = () => rss;
  const p = pool.run(job);
  workers[0].ready();
  pool.reapMemory();
  assert.equal(workers[0].terminated, 0, 'under the guard nothing happens');
  rss = 5000;
  pool.reapMemory();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /^memory-shared: resident 0 MB over the guard/);
  const { ScriptHealth } = await import('../scanners/health.ts');
  const { Db } = await import('../db.ts');
  const db = new Db(':memory:'); t.after(()=>db.db.close());
  const health = new ScriptHealth(db);
  assert.equal(health.record('s',r.error),false);
  assert.equal(health.isQuarantined('s'),false);
  assert.equal(workers[0].terminated, 1);
  assert.equal(pool.memoryRetirements, 1);
  rss = 500; pool.reapMemory();
  assert.equal(pool.memoryRetirements, 1, 'idle: no further retirements');
});

test('decision 140: a guard kill with several runs in progress is shared and quarantines nobody', async t => {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(2, 100, () => { const w = new FakeWorker(); workers.push(w); return w; }); t.after(() => pool.stop());
  pool.memoryGuardBytes = 1000; pool.rssReader = () => 5000;
  const a = pool.run(job), b = pool.run({ ...job, scannerId: 'other' });
  for (const w of workers) w.ready();
  assert.equal(workers.length, 2, 'two workers, both busy');
  pool.reapMemory();
  const [ra, rb] = await Promise.all([a, b]);
  assert.match(ra.error ?? '', /^memory-shared: resident 0 MB over the guard with 2 runs in progress/);
  assert.match(rb.error ?? '', /^memory-shared: /);
  const { ScriptHealth } = await import('../scanners/health.ts');
  const { Db } = await import('../db.ts');
  const h = new ScriptHealth(new Db(':memory:'));
  assert.equal(h.record('s', 'memory-shared: resident 6678 MB over the guard with 6 runs in progress'), false);
  assert.equal(h.isQuarantined('s'), false, 'a shared kill quarantines nobody');
  assert.equal(h.record('s', 'memory: resident 6678 MB over the guard while it ran'), true, 'explicit attributed memory verdicts remain supported');
});

test('a process worker becomes ready, runs a Pine job, and dies at once when retired', { timeout: 30_000 }, async t => {
  const { processWorker } = await import('./pool.ts');
  const pool = new PinePool(1, 20_000, processWorker);
  t.after(() => pool.stop());
  const result = await pool.run({ ...job, source: '//@version=5\nindicator("Smoke")\nplot(close)',
    bars: Array.from({ length: 60 }, (_, i) => ({ time: i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 })) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.bars, 60);
  const before = pool.stats.recycled;
  assert.ok(pool.recycleAll() >= 1, 'the busy-free worker is recycled');
  const again = await pool.run({ ...job, source: '//@version=5\nindicator("Smoke")\nplot(close)',
    bars: Array.from({ length: 30 }, (_, i) => ({ time: i * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 10 })) });
  assert.equal(again.ok, true, again.error);
  assert.ok(pool.stats.recycled > before);
});

test('decision 165: queued work runs live first, then mirror, then background; mirror is not counted as live', async t => {
  const { pool, workers } = setup(); t.after(() => pool.stop());
  workers[0].ready();
  void pool.run({ ...job, scannerId: 'busy' });                          // occupies the only worker
  const order: string[] = [];
  const run = (id: string, priority: 'live' | 'mirror' | 'background') => pool.run({ ...job, scannerId: id }, { priority }).then(() => order.push(id));
  const all = [run('bg', 'background'), run('mirror-1', 'mirror'), run('live-1', 'live'), run('mirror-2', 'mirror'), run('live-2', 'live')];
  assert.equal(pool.stats.queuedLive, 2, 'the live backlog guard sees only live work');
  assert.equal(pool.stats.queuedMirror, 2);
  for (let i = 0; i < 6; i++) { workers[0].finish(); await new Promise(r => setImmediate(r)); }
  await Promise.all(all);
  assert.deepEqual(order, ['live-1', 'live-2', 'mirror-1', 'mirror-2', 'bg']);
});

test('fresh shadow scans beat research while preserving reserved account capacity',()=>{
 const {pool,workers}=setup();
 void pool.run({...job,scannerId:'research'});void pool.run({...job,scannerId:'shadow'},{priority:'shadow'});void pool.run({...job,scannerId:'live'},{priority:'live'});
 workers[0].ready();assert.equal(workers[0].jobs[0].scannerId,'live');workers[0].finish();assert.equal(workers[0].jobs[1].scannerId,'shadow');workers[0].finish();assert.equal(workers[0].jobs[2].scannerId,'research');workers[0].finish();void pool.stop();
});

test('footprint data waits outside workers and settlement time counts toward the deadline', async t => {
  const {pool, workers} = setup(); t.after(() => pool.stop()); workers[0].ready();
  let release!: (value: []) => void;
  pool.footprintLoader = () => new Promise<[]>(resolve => {release = resolve;});
  const waiting = pool.run({...job, source:'request.footprint(1)'}, {priority:'live', deadlineMs:1});
  const ordinary = pool.run(job);
  assert.equal(workers[0].jobs.length, 1, 'ordinary scans run while the footprint settles');
  workers[0].finish(); await ordinary;
  await new Promise(resolve => setTimeout(resolve, 10)); release([]);
  assert.match((await waiting).error!, /expired/);
  assert.equal(workers[0].jobs.length, 1, 'expired footprint job never reaches a worker');
});
