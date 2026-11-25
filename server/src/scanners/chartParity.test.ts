import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { initChartReceipts } from './chartReceipts.ts';
import { parseObservation, ParityInputError, parityReport, recordParity } from './chartParity.ts';
import { permissionFor } from '../auth/routes.ts';
import type { ChartObservation, SignalReceipt } from '../../../shared/chartVerification.ts';

const BAR = 1_700_000_000_000;
function receipt(over: Partial<SignalReceipt> = {}): SignalReceipt {
  return { scannerId: 's', symbol: 'BTCUSD', tf: '15m', barTime: BAR, at: BAR + 60_000, sourceHash: 'h1', inputs: { len: 14 }, timezone: 'UTC',
    historyFrom: BAR - 999 * 900_000, bars: 1000, historyHash: 'hist', candle: { time: BAR, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    outputs: { trend: { kind: 'plot', value: 1.25 }, buy: { kind: 'shape', value: 1 } }, signals: [], signalCoverage: 'outputs-only', truncated: false, ...over };
}
function observation(over: Partial<ChartObservation> = {}): ChartObservation {
  return { scannerId: 's', symbol: 'BTCUSD', tf: '15m', barTime: BAR, sourceHash: 'h1', historyFrom: BAR - 999 * 900_000, inputs: { len: 14 }, inputsChanged: false,
    timezone: 'UTC', values: { trend: 1.25, buy: 1 }, complete: true, historyHash: 'hist', historyBars: 1000, ...over };
}
function setup(r: SignalReceipt | null = receipt()) {
  const db = new Db(':memory:'); initChartReceipts(db);
  if (r) db.run('INSERT INTO chart_signal_receipts VALUES(?,?,?,?,?)', r.scannerId, r.symbol, r.tf, r.at, JSON.stringify(r));
  return db;
}

test('parity: the server recomputes each verdict against its own receipt for the same bar', t => {
  const db = setup(); t.after(() => db.db.close());
  assert.deepEqual(recordParity(db, observation(), BAR + 1), { recorded: true, status: 'Outputs agree; other signal channels unverified' });
  // the same bar observed again replaces, not duplicates; a value now differs
  assert.equal(recordParity(db, observation({ values: { trend: 1.3, buy: 1 } }), BAR + 2).recorded, true);
  let [s] = parityReport(db, 7, BAR + 3).scanners;
  assert.deepEqual([s.checks, s.comparable, s.agreed, s.differed, s.verdict], [1, 1, 0, 1, 'diverges']);
  assert.deepEqual(s.lastDifference, { symbol: 'BTCUSD', tf: '15m', barTime: BAR, outputs: ['trend'] });
  recordParity(db, observation(), BAR + 4);
  [s] = parityReport(db, 7, BAR + 5).scanners;
  assert.deepEqual([s.checks, s.agreed, s.differed, s.verdict], [1, 1, 0, 'agrees']);
});

test('parity: nothing is recorded before the bot has scanned that bar; mismatched context is not comparable', t => {
  const db = setup(); t.after(() => db.db.close());
  assert.equal(recordParity(db, observation({ barTime: BAR + 900_000 }), BAR + 1).recorded, false, 'chart ran ahead of the scan');
  assert.equal(recordParity(setup(null), observation(), BAR + 1).recorded, false, 'no receipt at all');
  recordParity(db, observation({ sourceHash: 'edited' }), BAR + 2);
  const [s] = parityReport(db, 7, BAR + 3).scanners;
  assert.deepEqual([s.comparable, s.differed, s.verdict], [0, 0, 'unverified']);
  assert.deepEqual(s.notComparable, { 'Source, inputs or execution context differs': 1 });
});

test('parity: the window bounds the report', t => {
  const db = setup(); t.after(() => db.db.close());
  recordParity(db, observation(), BAR);
  assert.equal(parityReport(db, 1, BAR + 2 * 86_400_000).scanners.length, 0);
  assert.equal(parityReport(db, 7, BAR + 2 * 86_400_000).scanners.length, 1);
  assert.equal(parityReport(db, 999, BAR).days, 30, 'window capped at 30 days');
});

test('parity: observations are validated and bounded; recording is a diagnostic permission', () => {
  assert.equal(parseObservation(observation()).scannerId, 's');
  for (const bad of [null, [], { ...observation(), barTime: 'x' }, { ...observation(), scannerId: '' }, { ...observation(), values: { a: 'x' } },
    { ...observation(), values: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`v${i}`, 1])) }, { ...observation(), inputs: { a: {} } }])
    assert.throws(() => parseObservation(bad), ParityInputError);
  assert.equal(permissionFor('POST', '/api/parity/observations'), 'backtest');
  assert.equal(permissionFor('GET', '/api/parity'), 'read');
});
