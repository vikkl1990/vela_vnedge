import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../db.ts';
import { MlService } from './service.ts';

function seed(ml: MlService) {
  for (const tf of ['15m', '1h']) for (let i = 0; i < 120; i++) {
    const win = tf === '15m' ? i % 10 !== 0 : i % 10 === 0;
    ml.addLiveSample(i % 2 ? 'a' : 'b', 'BTCUSD', tf, i * 1000, { atrPct: (i % 7) / 10, dir: i % 2 ? 1 : -1 } as any, win, win ? 1 : -1, win ? 1 : -1, win ? 'tp1' : 'sl', i * 1000 + 1);
  }
}
const strip = (s: any) => ({ ...s, trainedAt: 0 });

test('S4: a worker-thread training run produces exactly the in-process models and snapshot', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-ml-'));
  const db = new Db(path.join(dir, 'vnedge.db'));
  t.after(() => { db.db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ } });
  const ml = new MlService(db, () => ({ a: 'A', b: 'B' }));
  t.after(() => ml.stop());
  seed(ml);
  const inProcess = ml.train();
  const probe = { atrPct: 0.3, dir: 1 } as any;
  const before = ['15m', '1h'].map(tf => ml.score('a', probe, { tf, record: false }));
  let started = 0;
  const real = ml.startWorker;
  ml.startWorker = (file, input) => { started++; return real(file, input); };
  const viaWorker = await ml.trainAsync();
  assert.equal(started, 1, 'the fit ran in a worker thread');
  assert.deepEqual(strip(viaWorker), strip(inProcess));
  assert.deepEqual(['15m', '1h'].map(tf => ml.score('a', probe, { tf, record: false })), before, 'identical scores after the worker run');
});

test('S4: one training run at a time; a failed worker falls back to in-process training', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const ml = new MlService(db, () => ({}));
  seed(ml);
  // pretend the database is file-backed so the worker path is taken, and make the worker fail
  Object.defineProperty(db, 'file', { value: 'fake.db' });
  let started = 0;
  ml.startWorker = () => { started++; return { promise: Promise.reject(new Error('worker crashed')), terminate() {} }; };
  const [a, b] = [ml.trainAsync(), ml.trainAsync()];
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(started, 1, 'the second request joined the running one');
  assert.equal(ra.samples, 240); assert.equal(rb, ra);
});

test('S4: in-memory databases and VNEDGE_ML_WORKER=0 train in-process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const ml = new MlService(db, () => ({}));
  seed(ml);
  let started = 0;
  ml.startWorker = () => { started++; throw new Error('must not start'); };
  assert.equal((await ml.trainAsync()).samples, 240);
  Object.defineProperty(db, 'file', { value: 'fake.db' }); ml.useWorker = false;
  assert.equal((await ml.trainAsync()).samples, 240);
  assert.equal(started, 0);
});
