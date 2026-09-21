import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { fitPlatt, predict, reliability, trainLogReg, type Sample } from './model.ts';
import { computeFeatures } from './features.ts';
import { MlService } from './service.ts';

function mk(i: number, win: number, score: number): Sample {
  const f = computeFeatures({ bars: [{ time: Date.UTC(2026, 0, 1) + i * 900_000, open: 100, high: 101, low: 99, close: 100, volume: 10 }], i: 0, ev: { side: 'long', score, source: 'alert' }, entry: 100, sl: 99, tp1: 102, atr: 1, levelsSource: 'script' });
  return { scannerId: 's', symbol: 'BTCUSD', tf: '15m', at: Date.UTC(2026, 0, 1) + i * 900_000, features: f, win, r: win ? 1.5 : -1, pnl: win ? 15 : -10, exitReason: win ? 'tp1' : 'sl', bt: true };
}

test('Platt scaling fixes over-confident logits and reliability buckets report predicted vs observed', () => {
  // truth: P(win) = sigmoid(0.5·z); the model's logits are 4× too confident (2·z)
  const logits: number[] = [], ys: number[] = [];
  let seed = 7; const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2000; i++) { const z = (rnd() - 0.5) * 8; logits.push(2 * z); ys.push(rnd() < 1 / (1 + Math.exp(-0.5 * z)) ? 1 : 0); }
  const cal = fitPlatt(logits, ys);
  assert.ok(cal.a > 0.18 && cal.a < 0.33, `a=${cal.a} should shrink logits by ~4×`);
  assert.ok(Math.abs(cal.b) < 0.2, `b=${cal.b}`);
  const raw = logits.map(z => 1 / (1 + Math.exp(-z)));
  const calibrated = logits.map(z => 1 / (1 + Math.exp(-(cal.a * z + cal.b))));
  const rawR = reliability(raw, ys), calR = reliability(calibrated, ys);
  const gap = (r: typeof rawR) => r.filter(b => b.n > 20).reduce((a, b) => a + Math.abs(b.predicted - b.observed), 0) / Math.max(1, r.filter(b => b.n > 20).length);
  assert.ok(gap(calR) < gap(rawR), `calibrated gap ${gap(calR)} vs raw ${gap(rawR)}`);
  assert.equal(rawR.length, 5); assert.equal(rawR.reduce((a, b) => a + b.n, 0), 2000);
});

test('trainLogReg evaluates on the newest 20% by time, stores calibration, and predict() applies it', () => {
  const samples: Sample[] = [];
  for (let i = 0; i < 300; i++) { const score = (i * 37) % 100; const win = score > 60 ? ((i % 10) < 8 ? 1 : 0) : ((i % 10) < 3 ? 1 : 0); samples.push(mk(i, win, score)); }
  const m = trainLogReg(samples)!;
  assert.equal(m.metrics.walkForward.trainN + m.metrics.walkForward.testN, 300);
  assert.equal(m.metrics.walkForward.testN, 60);
  assert.ok(m.metrics.walkForward.trainTo < m.metrics.walkForward.testFrom, 'test set is strictly newer than the training set');
  assert.ok(m.calibration && Number.isFinite(m.calibration.a) && Number.isFinite(m.calibration.b));
  assert.equal(m.metrics.reliability.length, 5); assert.equal(m.metrics.reliabilityCalibrated.length, 5);
  assert.ok(m.metrics.brier >= 0 && m.metrics.brierCalibrated >= 0);
  const f = samples[10].features;
  const raw = predict(m, f, false), cal = predict(m, f, true);
  assert.ok(raw > 0 && raw < 1 && cal > 0 && cal < 1);
  assert.notEqual(raw, cal, 'calibration changes the probability');
});

test('MlService.score returns calibrated probabilities and feeds the drift monitor', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const ml = new MlService(db, () => ({ s: 'S' }));
  for (let i = 0; i < 300; i++) { const score = (i * 37) % 100; const win = score > 60 ? ((i % 10) < 8 ? 1 : 0) : ((i % 10) < 3 ? 1 : 0); const smp = mk(i, win, score); db.run('INSERT INTO ml_samples(scanner_id,symbol,tf,at,features,win,r,pnl,exit_reason,bt) VALUES (?,?,?,?,?,?,?,?,?,1)', 's', 'BTCUSD', '15m', smp.at, JSON.stringify(smp.features), win, smp.r, smp.pnl, smp.exitReason); }
  const snap = ml.train();
  assert.ok(snap.global?.model?.reliabilityCalibrated.length === 5);
  assert.ok(snap.global?.calibration);
  assert.equal(ml.drift().n, 0);
  // live entries with a shifted ATR% distribution
  for (let i = 0; i < 40; i++) {
    const f = computeFeatures({ bars: [{ time: Date.UTC(2026, 1, 1) + i * 900_000, open: 100, high: 110, low: 90, close: 100, volume: 10 }], i: 0, ev: { side: 'long', score: 50, source: 'alert' }, entry: 100, sl: 99, tp1: 102, atr: 12, levelsSource: 'script' });
    const sc = ml.score('s', f)!;
    assert.ok(sc.calibrated); assert.ok(sc.prob > 0 && sc.prob < 1); assert.equal(sc.model, 'scanner');
  }
  const d = ml.drift();
  assert.equal(d.n, 40);
  const atr = d.features.find(f => f.feature === 'atr_pct')!;
  assert.ok(atr.drifted, `atr_pct shift ${atr.shift}`);
  assert.ok(d.drifted >= 1);
  assert.ok(ml.insights()!.drift.n === 40, 'insights carry the drift report');
  // persisted across restarts
  const ml2 = new MlService(db, () => ({}));
  assert.equal(ml2.drift().n, 40);
});
