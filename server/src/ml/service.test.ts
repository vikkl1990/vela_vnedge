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
