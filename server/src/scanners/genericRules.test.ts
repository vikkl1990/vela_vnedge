import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, selectOscillator, selectTrail } from './rules.ts';
import type { WorkerPlot } from '../pine/worker.ts';

const N = 120;
/** Price: 40 bars up, 40 down, 40 up (2 per bar). */
const bars = Array.from({ length: N }, (_, i) => {
  const dir = i < 40 ? 1 : i < 80 ? -1 : 1;
  const c = 1000 + (i < 40 ? i * 2 : i < 80 ? 80 - (i - 40) * 2 : (i - 80) * 2);
  return { time: 1_000_000 + i * 900_000, open: c - dir * 2, high: c + 3, low: c - 3, close: c, volume: 1 };
});
const plot = (title: string, overlay: boolean, f: (i: number) => number | null, style = 'line'): WorkerPlot => ({ title, style, overlay, data: bars.map((b, i) => ({ time: b.time, value: f(i) })) });

// a supertrend-like trail: 10 below price in up-legs, 10 above in down-legs, flipping with the trend (with a 3-bar lag)
const trail = (i: number) => { const j = Math.max(0, i - 3); const up = j < 40 || j >= 80; return bars[i].close + (up ? -10 : 10); };

test('trailing rule: picks the trail-like overlay plot and fires on close flips with the trail as stop', () => {
  const plots = [plot('EMA fast', true, i => bars[i].close + (i % 2 ? 1 : -1)), plot('Trail', true, trail), plot('RSI', false, i => 50 + Math.sin(i / 3) * 40)];
  const sel = selectTrail(plots, bars)!;
  assert.equal(sel.title, 'Trail');
  const ev = applyRules({ scannerId: 'x', alerts: [], shapes: [], labels: [], bars, plots, rule: 'trailing', mode: 'backtest' });
  assert.equal(ev.length, 2, JSON.stringify(ev.map(e => [e.side, e.barTime])));
  assert.equal(ev[0].side, 'short'); assert.equal(ev[1].side, 'long');
  for (const e of ev) { assert.equal(e.source, 'derived'); assert.ok(e.sl !== undefined); assert.ok(e.side === 'long' ? e.sl! < e.price! : e.sl! > e.price!); }
  // without a title hint the least-flipping candidate wins over the noisy EMA
  const sel2 = selectTrail([plot('A', true, i => bars[i].close + (i % 2 ? 1 : -1)), plot('B', true, trail)], bars)!;
  assert.equal(sel2.title, 'B');
  // complementary up/down plots merge into one trail
  const merged = selectTrail([plot('Up Trend', true, i => (trail(i) < bars[i].close ? trail(i) : null)), plot('Down Trend', true, i => (trail(i) > bars[i].close ? trail(i) : null))], bars)!;
  assert.ok(merged.merged); assert.equal(merged.flips, 2);
  // not configured → nothing
  assert.equal(applyRules({ scannerId: 'x', alerts: [], shapes: [], labels: [], bars, plots, mode: 'backtest' }).length, 0);
});

test('oscillator rule: OB/OS on a 0..100 series, zero-line on a signed series; overlay plots ignored', () => {
  const rsi = (i: number) => 50 + 45 * Math.sin(i / 6);
  const obos = applyRules({ scannerId: 'x', alerts: [], shapes: [], labels: [], bars, plots: [plot('RSI', false, rsi), plot('Trail', true, trail)], rule: 'oscillator', mode: 'backtest' });
  assert.ok(obos.length >= 4, `got ${obos.length}`);
  for (const e of obos) {
    const i = bars.findIndex(b => b.time === e.barTime);
    if (e.side === 'long') assert.ok(rsi(i - 1) < 30 && rsi(i) >= 30, `long must leave oversold at ${i}`);
    else assert.ok(rsi(i - 1) > 70 && rsi(i) <= 70, `short must leave overbought at ${i}`);
    assert.equal(e.sl, undefined, 'stops come from ATR');
  }
  const macd = (i: number) => Math.sin(i / 8) * 5;
  const sel = selectOscillator([plot('MACD', false, macd, 'histogram'), plot('Zero', false, () => 0)], bars)!;
  assert.equal(sel.mode, 'zero'); assert.equal(sel.title, 'MACD');
  const zero = applyRules({ scannerId: 'x', alerts: [], shapes: [], labels: [], bars, plots: [plot('MACD', false, macd, 'histogram')], rule: 'oscillator', mode: 'backtest' });
  assert.ok(zero.length >= 4);
  for (const e of zero) { const i = bars.findIndex(b => b.time === e.barTime); assert.equal(e.side, macd(i) > 0 ? 'long' : 'short'); }
  assert.equal(selectOscillator([plot('Trail', true, trail)], bars), null);
});
