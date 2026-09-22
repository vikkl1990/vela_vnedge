import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { runBacktest } from './backtest.ts';

const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, trailAfterR: 0, floorAtR: 0, staleBars: 0, breakEvenAfterTp1: false, tpSplit: [0, 0, 1] as [number, number, number] };
const M15 = 900_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: i * M15, open: o, high: h, low: l, close: c, volume: 1 });
// bar 0 signals a long at 100 (stop 95, target 105); bar 1 spans both 94 and 106
const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 106, 94, 100), bar(2, 100, 100, 100, 100)];
const events = [{ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 105, 105], barTime: 0, barIndex: 0, source: 'alert', label: 'buy', message: '' }] as any;
const base = { scannerId: 't', scannerName: 't', symbol: 'X', tf: '15m', bars, events, cfg, exitMode: 'levels' as const, contractValue: 1, tickSize: 0.5 };
// 1m path inside bar 1: up to the target first, then down through the stop
const up = Array.from({ length: 15 }, (_, k) => ({ time: M15 + k * 60_000, open: 100, high: k === 2 ? 106 : 101, low: k === 10 ? 94 : 99.5, close: 100, volume: 1 }));

test('without 1m data an ambiguous bar is scored stop-first', () => {
  const r = runBacktest(base);
  assert.equal(r.trades.length, 1);
  assert.ok(r.trades[0].pnl < 0);
});

test('with 1m data the exit follows the order prices actually traded', () => {
  const r = runBacktest({ ...base, subBars: up });
  assert.equal(r.trades.length, 1);
  assert.ok(r.trades[0].pnl > 0, `expected the target to fill first, got ${r.trades[0].pnl}`);
  // and the reverse path still stops out
  const down = up.map((b, k) => ({ ...b, high: k === 10 ? 106 : 101, low: k === 2 ? 94 : 99.5 }));
  assert.ok(runBacktest({ ...base, subBars: down }).trades[0].pnl < 0);
});

test('a signal bar with no 1m candles falls back to its own OHLC', () => {
  const r = runBacktest({ ...base, subBars: [{ time: 5 * M15, open: 100, high: 100, low: 100, close: 100, volume: 1 }] });
  assert.ok(r.trades[0].pnl < 0);
});
