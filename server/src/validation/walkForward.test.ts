import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { makeWindows, statsOf, walkForward, weekKey, oosSummary } from './walkForward.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 6); // Monday 2026-07-06

test('makeWindows rolls train+test windows by step and ends at the history end', () => {
  const w = makeWindows(T0, T0 + 20 * DAY, { trainDays: 10, testDays: 3, stepDays: 1 });
  assert.equal(w.length, 8, 'starts 0..7 fit 13-day windows into 20 days');
  assert.equal(w[0].trainFrom, T0); assert.equal(w[0].trainTo, T0 + 10 * DAY); assert.equal(w[0].testFrom, T0 + 10 * DAY); assert.equal(w[0].testTo, T0 + 13 * DAY);
  assert.equal(w[7].trainFrom, T0 + 7 * DAY); assert.equal(w[7].testTo, T0 + 20 * DAY);
  assert.equal(makeWindows(T0, T0 + 12 * DAY, { trainDays: 10, testDays: 3, stepDays: 1 }).length, 0, 'too short → no windows');
  assert.equal(makeWindows(T0, T0 + 20 * DAY, { trainDays: 10, testDays: 3, stepDays: 3 }).length, 3);
});

test('weekKey is ISO-8601 and statsOf counts positive weeks from exit time', () => {
  assert.equal(weekKey(Date.UTC(2026, 0, 1)), '2026-W01');
  assert.equal(weekKey(Date.UTC(2024, 11, 30)), '2025-W01');
  assert.equal(weekKey(Date.UTC(2026, 6, 6)), '2026-W28');
  const s = statsOf([
    { pnl: 100, fees: 1, exitAt: T0, rMultiple: 1 }, { pnl: -50, fees: 1, exitAt: T0 + DAY, rMultiple: -1 },
    { pnl: -80, fees: 1, exitAt: T0 + 8 * DAY, rMultiple: -1 }, { pnl: 40, fees: 1, exitAt: T0 + 15 * DAY, rMultiple: 0.5 },
  ], 1000);
  assert.equal(s.trades, 4); assert.equal(s.wins, 2); assert.equal(s.pnl, 10); assert.equal(s.weeks, 3); assert.equal(s.positiveWeeks, 2); assert.equal(s.negativeWeeks, 1);
  assert.ok(Math.abs(s.profitFactor! - 140 / 130) < 1e-9);
  assert.ok(s.maxDrawdownPct > 11 && s.maxDrawdownPct < 12, `dd ${s.maxDrawdownPct}`); // peak 1100 → 970
});

/** 15m bars over `days`; price steps up 1 per bar in "good" regimes and down in "bad" ones (by day parity of the regime function). */
function synth(days: number, good: (day: number) => boolean) {
  const bars = [] as Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  let p = 10_000;
  for (let i = 0; i < days * 96; i++) {
    const day = Math.floor(i / 96);
    const dir = good(day) ? 1 : -1;
    const o = p; p += dir * 2; bars.push({ time: T0 + i * 900_000, open: o, high: Math.max(o, p) + 0.5, low: Math.min(o, p) - 0.5, close: p, volume: 10 });
  }
  return bars;
}

test('walk-forward: in-sample selection gates out-of-sample aggregation; overlapping test windows are de-duplicated', () => {
  // long entries every 8 bars; days 0..19 trend up (wins), days 20..29 trend down (losses)
  const bars = synth(30, d => d < 20);
  const events: ScanEvent[] = [];
  for (let i = 100; i < bars.length; i += 8) events.push({ kind: 'entry', side: 'long', price: bars[i].close, sl: bars[i].close - 10, tp: [bars[i].close + 10, bars[i].close + 20, bars[i].close + 30], label: 'L', message: '', source: 'alert', barTime: bars[i].time, barIndex: i });
  const cfg = { ...DEFAULT_CONFIG.paper, minRiskFeeRatio: 0 };
  const r = walkForward({ scannerId: 's', scannerName: 'S', symbol: 'BTCUSD', tf: '15m', bars, events, cfg, exitMode: 'levels', contractValue: 0.001, tickSize: 0.5, opts: { trainDays: 10, testDays: 3, stepDays: 1, minTrades: 3, minProfitFactor: 1 } });
  assert.ok(r.windows.length > 10);
  // windows trained entirely in the up-trend are selected; windows trained mostly in the down-trend are not
  assert.ok(r.windows[0].selected, 'first window selected');
  assert.ok(!r.windows.at(-1)!.selected, 'last window (trained on the down-trend) rejected');
  assert.ok(r.selectedWindows > 0 && r.selectedWindows < r.windows.length);
  // OOS from selected windows is dominated by the profitable regime, OOS-all includes the losing tail
  assert.ok(r.outOfSample.pnl > r.outOfSampleAll.pnl, `oos ${r.outOfSample.pnl} vs all ${r.outOfSampleAll.pnl}`);
  // de-dup: no two OOS trades share an entry time
  const entries = r.trades.map(t => t.entryAt);
  assert.equal(new Set(entries).size, entries.length);
  // every OOS trade lies inside some selected test window
  for (const t of r.trades) assert.ok(r.windows.some(w => w.selected && t.entryAt >= w.testFrom && t.entryAt < w.testTo));
  assert.ok(r.outOfSample.positiveWeeks >= 1);
  const s = oosSummary(r);
  assert.equal(s.trades, r.outOfSample.trades); assert.equal(s.windows, r.windows.length);
});
