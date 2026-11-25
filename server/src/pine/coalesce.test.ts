import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PinePool, coalesceKey } from './pool.ts';
import type { WorkerJob } from './worker.ts';

class FakeWorker extends EventEmitter {
  jobs: WorkerJob[] = [];
  postMessage(job: WorkerJob) { this.jobs.push(job); }
  async terminate() { return 1; }
  ready() { this.emit('message', { ready: true }); }
  finish(i = -1, extra: Record<string, unknown> = {}) { const job = this.jobs.at(i)!; this.emit('message', { id: job.id, ok: true, alerts: [{ time: 1, message: 'x' }], shapes: [], labels: [], plots: [], ...extra }); }
  fail(i = -1) { const job = this.jobs.at(i)!; this.emit('message', { id: job.id, ok: false, error: 'script error' }); }
}
const bars = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, { time: 2, open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 }];
const job: Omit<WorkerJob, 'id'> = { scannerId: 's', source: 'indicator("x")', symbol: 'BTCUSD', tf: '15m', tickSize: 0.5, bars, tailBars: 3, plotTail: 400, inputs: { a: 1, b: 2 } };
function setup(n = 2) {
  const workers: FakeWorker[] = [];
  const pool = new PinePool(n, 1000, () => { const w = new FakeWorker(); workers.push(w); return w; });
  for (const w of workers) w.ready();
  const dispatched = () => workers.reduce((k, w) => k + w.jobs.length, 0);
  return { pool, workers, dispatched };
}

test('S6: identical in-flight jobs from two schedulers run once; each caller gets its own copy', async t => {
  const { pool, workers, dispatched } = setup(); t.after(() => pool.stop());
  const account = pool.run(job, { priority: 'live' });
  const shadow = pool.run({ ...job, inputs: { b: 2, a: 1 } }, { priority: 'shadow' });   // input order does not matter
  assert.equal(dispatched(), 1);
  workers.find(w => w.jobs.length)!.finish();
  const [a, b] = await Promise.all([account, shadow]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'separate objects: one consumer sorting its arrays cannot affect the other');
  assert.notEqual(a.alerts, b.alerts);
  assert.deepEqual(pool.coalescing, { joined: 1, unique: 1 });
  // after it settles, the next identical request runs again (no result cache)
  void pool.run(job, { priority: 'live' });
  assert.equal(dispatched(), 2);
});

test('S6: an account scan never waits behind a queued shadow twin; a shadow scan may join the account run', async t => {
  const { pool, workers, dispatched } = setup(1); t.after(() => pool.stop());
  void pool.run({ ...job, scannerId: 'busy' });             // occupy the only worker
  const queuedShadow = pool.run(job, { priority: 'shadow' });
  const account = pool.run(job, { priority: 'live' });      // must not join the lower-tier queued twin
  const shadow2 = pool.run(job, { priority: 'shadow' });    // joins the account run, the higher tier
  assert.deepEqual(pool.coalescing, { joined: 1, unique: 3 });
  workers[0].finish(0);                                     // free the worker: the live job dispatches first
  await new Promise(r => setImmediate(r));
  assert.equal(workers[0].jobs.at(-1)!.scannerId, 's');
  workers[0].finish(-1);
  assert.equal((await account).ok, true);
  assert.equal((await shadow2).ok, true);
  await new Promise(r => setImmediate(r));
  workers[0].finish(-1);
  assert.equal((await queuedShadow).ok, true);
  assert.equal(dispatched(), 3);
});

test('S6: a shared failure does not fail the joiner; it runs on its own', async t => {
  const { pool, workers, dispatched } = setup(1); t.after(() => pool.stop());
  const first = pool.run(job, { priority: 'live' });
  const joiner = pool.run(job, { priority: 'shadow' });
  workers[0].fail();
  assert.equal((await first).ok, false);
  await new Promise(r => setImmediate(r));
  assert.equal(dispatched(), 2, 'the joiner re-ran');
  workers[0].finish();
  assert.equal((await joiner).ok, true);
});

test('S6: what never coalesces, and what makes two jobs different', () => {
  assert.equal(coalesceKey({ ...job, tailBars: 'all' }), null, 'backtests');
  assert.equal(coalesceKey({ ...job, ledger: true }), null, 'strategy ledgers');
  assert.equal(coalesceKey({ ...job, footprints: [] }), null, 'footprint data');
  assert.equal(coalesceKey({ ...job, source: 'x = request.footprint(1)' }), null, 'footprint scripts');
  const k = coalesceKey(job);
  assert.ok(k);
  for (const changed of [
    { ...job, source: 'indicator("y")' }, { ...job, inputs: { a: 1, b: 3 } }, { ...job, timezone: 'Asia/Kolkata' }, { ...job, tailBars: 4 },
    { ...job, plotTail: 10 }, { ...job, symbol: 'ETHUSD' }, { ...job, tf: '1h' },
    { ...job, bars: [bars[0], { ...bars[1], close: 1.9 }] },   // a revised bar (gap fill) is a different job
  ]) assert.notEqual(coalesceKey(changed), k);
});
