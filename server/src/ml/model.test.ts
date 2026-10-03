import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainLogReg, predict, deriveRules, type Sample } from './model.ts';
import { computeFeatures, FEATURE_NAMES, adx, dayRangeUsed } from './features.ts';

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

test('rules survive samples recorded before a feature existed', () => {
  const mk = (i: number, extra: Record<string, number>) => ({ scannerId: 's', symbol: 'X', tf: '1h', at: i, features: { side_long: i % 2, hour: i % 24, ...extra } as any, win: i % 3 === 0 ? 1 : 0, r: i % 3 === 0 ? 1.5 : -1, pnl: 0, exitReason: 'sl', bt: true });
  const old = Array.from({ length: 40 }, (_, i) => mk(i, {}));
  const fresh = Array.from({ length: 40 }, (_, i) => mk(100 + i, { er20: i / 40, chop14: 30 + i }));
  const { baseline, rules } = deriveRules([...old, ...fresh]);
  assert.equal(baseline.n, 80);
  assert.ok(Array.isArray(rules));
});

test('ADX and day-range-used are built from closed bars only', () => {
  // 30 UTC days of hourly bars: a steady uptrend, 1 point an hour, range 2 a bar
  const bars = Array.from({ length: 30 * 24 }, (_, i) => ({ time: Date.UTC(2026, 0, 1) + i * 3_600_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  const a = adx(bars, bars.length - 1);
  assert.ok(a !== undefined && a > 50, `a steady trend reads as strong (${a})`);
  assert.equal(adx(bars, 10), undefined, 'no reading before the warm-up');
  // at 06:00 UTC on the last day six bars have printed: range so far 1+6 = 7 points vs a full day's 25
  const i = 29 * 24 + 5;
  const used = dayRangeUsed(bars, i);
  assert.ok(used !== undefined && Math.abs(used - 7 / 25) < 1e-9, `used ${used}`);
  assert.equal(dayRangeUsed(bars, 12), undefined, 'no reading without complete earlier days');
});
