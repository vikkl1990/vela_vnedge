import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PinePool } from './pool.ts';
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
