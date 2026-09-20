import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainLogReg, predict, deriveRules, type Sample } from './model.ts';
import { computeFeatures, FEATURE_NAMES } from './features.ts';

function mk(i: number, win: number, score: number, hour: number): Sample {
  const f = computeFeatures({ bars: [{ time: Date.UTC(2026, 0, 1, hour), open: 100, high: 101, low: 99, close: 100, volume: 10 }], i: 0, ev: { side: 'long', score, source: 'alert' }, entry: 100, sl: 99, tp1: 102, atr: 1, levelsSource: 'script' });
  return { scannerId: 's', symbol: 'BTCUSD', tf: '15m', at: i, features: f, win, r: win ? 1.5 : -1, pnl: win ? 15 : -10, exitReason: win ? 'tp1' : 'sl', bt: true };
}

test('features have the declared shape', () => {
  const f = computeFeatures({ bars: [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }], i: 0, ev: { side: 'short', source: 'shape' }, entry: 1, sl: 1.01, atr: 0.01, levelsSource: 'atr-fallback' });
  for (const n of FEATURE_NAMES) assert.ok(Number.isFinite(f[n]), n);
  assert.equal(f.side_long, 0); assert.equal(f.has_score, 0); assert.equal(f.src_shape, 1);
});

test('logistic regression learns a score→win relationship and rules surface it', () => {
  const samples: Sample[] = [];
  for (let i = 0; i < 300; i++) { const score = (i * 37) % 100; const hour = (i * 7) % 24; const win = score > 60 ? ((i % 10) < 8 ? 1 : 0) : ((i % 10) < 3 ? 1 : 0); samples.push(mk(i, win, score, hour)); }
  const m = trainLogReg(samples)!;
  assert.ok(m, 'model trained');
  assert.ok(m.metrics.auc > 0.75, `auc ${m.metrics.auc}`);
  assert.ok(predict(m, samples.find(s => s.features.score > 80)!.features) > predict(m, samples.find(s => s.features.score < 20)!.features));
  assert.equal(m.importance[0].feature, 'score');
  const { rules, baseline } = deriveRules(samples);
  assert.ok(baseline.n === 300);
  assert.ok(rules.some(r => r.feature === 'score' && r.kind === 'prefer'), JSON.stringify(rules.slice(0, 3)));
});
