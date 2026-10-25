import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { MlService } from './service.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';

test('simulation upgrade discards obsolete backtests and models but preserves live samples', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  new MlService(db, () => ({}));
  for (const bt of [0, 1]) db.run('INSERT INTO ml_samples(scanner_id,symbol,tf,at,features,win,r,pnl,exit_reason,bt) VALUES (?,?,?,?,?,?,?,?,?,?)', 's', 'BTCUSD', '1m', 1, '{}', 1, 1, 10, 'tp1', bt);
  db.kvSet('ml.simulationVersion', SIMULATION_VERSION - 1);
  db.kvSet('ml.model', { global: {}, models: {}, snapshot: {} });
  const ml = new MlService(db, () => ({}));
  assert.deepEqual(ml.count(), { total: 1, live: 1 });
  assert.equal(db.kvGet('ml.model'), undefined);
  assert.equal(db.kvGet('ml.simulationVersion'), SIMULATION_VERSION);
});


test('timeframe scoring isolates opposing horizons, survives reload and abstains on unseen TFs', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const ml = new MlService(db, () => ({}));
  for (const tf of ['15m', '1h']) for (let i = 0; i < 100; i++) {
    const win = tf === '15m' ? i % 10 !== 0 : i % 10 === 0;
    ml.addLiveSample('s', 'BTCUSD', tf, i * 1000, {} as any, win, win ? 1 : -1, 0, 'sl', i * 1000 + 1);
  }
  // Legacy samples without an exit timestamp cannot participate in chronological validation.
  db.run("INSERT INTO ml_samples(scanner_id,symbol,tf,at,features,win,r,pnl,exit_reason,bt) VALUES ('old','BTCUSD','4h',1,'{}',1,1,1,'tp',0)");
  assert.equal(ml.train().samples, 200);
  const long = ml.score('s', {} as any, { tf: '15m', record: false })!;
  const short = ml.score('s', {} as any, { tf: '1h', record: false })!;
  assert.ok(long.prob > short.prob + 0.4);
  assert.equal(ml.score('s', {} as any, { tf: '4h', record: false }), null);
  assert.equal(ml.score('unseen', {} as any, { tf: '15m', record: false })?.model, 'global');
  const reloaded = new MlService(db, () => ({}));
  assert.deepEqual(reloaded.score('s', {} as any, { tf: '1h', record: false }), short);
});
