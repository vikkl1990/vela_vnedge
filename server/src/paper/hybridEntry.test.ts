import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { runBacktest } from './backtest.ts';

const H = 3600_000;
const bar = (t: number, o: number, h: number, l: number, c: number) => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 });

test('a break entry fills on the first lower bar beyond the signal bar, or lapses', () => {
  const T0 = Date.UTC(2026, 0, 5);
  // 40 flat 1h bars, a signal on bar 30 (high 102), then one bar that breaks 102 on its second 15m sub-bar
  const bars = Array.from({ length: 40 }, (_, i) => bar(T0 + i * H, 100, 101, 99, 100));
  bars[30] = bar(T0 + 30 * H, 100, 102, 99, 101);
  bars[31] = bar(T0 + 31 * H, 101, 103, 100, 102.5);
  bars[36] = bar(T0 + 36 * H, 102, 125, 101, 124);   // the move that closes the trade at its targets
  const sub = bars.flatMap(b => [0, 1, 2, 3].map(q => bar(b.time + q * 15 * 60_000, b.open, b.high, b.low, b.close)));
  sub[31 * 4] = bar(bars[31].time, 101, 101.5, 100, 101); sub[31 * 4 + 1] = bar(bars[31].time + 15 * 60_000, 101, 103, 100.5, 102.5);
  const events = [{ kind: 'entry' as const, side: 'long' as const, tp: [], label: 'buy', message: 'buy', source: 'alert' as const, barTime: bars[30].time, barIndex: 30 }];
  const base = { scannerId: 's', scannerName: 's', symbol: 'XUSD', tf: '1h', bars, events, cfg: { ...DEFAULT_CONFIG.paper, minRiskFeeRatio: 0 }, exitMode: 'both' as const, contractValue: 1, tickSize: 0.01, subBars: sub };
  const direct = runBacktest(base); const hybrid = runBacktest({ ...base, entry: { breakAtr: 0, breakBars: 4 } });
  assert.equal(direct.trades.length, 1); assert.equal(hybrid.trades.length, 1);
  assert.equal(direct.trades[0].entryAt, bars[30].time, 'direct: at the signal bar');
  assert.equal(hybrid.trades[0].entryAt, bars[31].time + 15 * 60_000, 'hybrid: on the 15m bar that crossed the signal high');
  assert.ok(hybrid.trades[0].entryPrice >= 102, 'filled at the trigger, as a taker');
  // no continuation: the signal lapses
  const flat = bars.map((b, i) => (i === 30 ? b : bar(b.time, 100, 101, 99, 100)));   // no continuation after the signal bar
  const lapsed = runBacktest({ ...base, bars: flat, subBars: flat.flatMap(b => [0, 1, 2, 3].map(q => bar(b.time + q * 15 * 60_000, b.open, b.high, b.low, b.close))), entry: { breakAtr: 0, breakBars: 4 } });
  assert.equal(lapsed.trades.length, 0);
});
