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

test('entry model: a pullback limit fills back from the signal close as a maker, skips when the pullback never comes, and a spent signal bar is refused', () => {
  const b = (i: number, o: number, h: number, l: number, c: number) => ({ time: i * M15, open: o, high: h, low: l, close: c, volume: 1 });
  // 20 quiet bars give ATR ≈ 1; bar 20 is the signal bar closing at 100; bar 21 dips to 99.6 then the move resumes to 106
  const quiet = Array.from({ length: 20 }, (_, i) => b(i, 100, 100.5, 99.5, 100));
  const bars = [...quiet, b(20, 100, 100.5, 99.5, 100), b(21, 100, 100.2, 99.6, 100.1), b(22, 100.1, 106, 100, 105), b(23, 105, 105, 105, 105)];
  const ev = [{ kind: 'entry', side: 'long', price: 100, barTime: 20 * M15, barIndex: 20, source: 'alert', label: 'buy', message: '' }] as any;
  const paper = { ...cfg, feeRatePct: 0.05, makerFeeRatePct: 0.02, feeTaxPct: 0, fallbackAtrSl: 1.5, fallbackRR: [2, 2, 2] as [number, number, number], tpSplit: [1, 0, 0] as [number, number, number] };
  // a 0.5 tick would round the 99.7 limit to 99.5, below the dip: the limit rests on the tick grid, as a real order would
  const input = { ...base, bars, events: ev, cfg: paper, exitMode: 'levels' as const, tickSize: 0.1 };
  const plain = runBacktest(input);
  const pulled = runBacktest({ ...input, entry: { pullbackAtr: 0.3, pullbackBars: 3 } });
  assert.equal(plain.entries, 1); assert.equal(pulled.entries, 1);
  const a = plain.trades[0], p = pulled.trades[0];
  assert.ok(p.entryPrice < a.entryPrice, `pullback fills lower: ${p.entryPrice} < ${a.entryPrice}`);
  assert.ok(Math.abs(p.entryPrice - 99.7) < 0.06, `0.3 ATR back from 100: ${p.entryPrice}`);
  assert.ok(p.entryAt >= 21 * M15 && p.entryAt < 22 * M15, 'filled on the bar that touched the limit');
  assert.ok(p.fees < a.fees, 'a resting limit pays the maker fee');
  // no pullback within the window: the signal is skipped, not chased
  const noDip = [...quiet, b(20, 100, 100.5, 99.5, 100), b(21, 100, 101, 100, 101), b(22, 101, 102, 101, 102), b(23, 102, 103, 102, 103), b(24, 103, 104, 103, 104), b(25, 104, 105, 104, 105)];
  const skipped = runBacktest({ ...input, bars: noDip, entry: { pullbackAtr: 0.3, pullbackBars: 3 } });
  assert.equal(skipped.entries, 0); assert.equal(skipped.rejected['no pullback'], 1);
  // a signal bar that already ran two ATRs is refused by the no-chase filter
  const spent = [...quiet, b(20, 100, 102.2, 100, 102.2), b(21, 102.2, 102.5, 101, 101), b(22, 101, 101, 101, 101)];
  const evSpent = [{ ...ev[0], price: 102.2 }];
  const chased = runBacktest({ ...input, bars: spent, events: evSpent, entry: { maxSignalBarAtr: 1.5 } });
  assert.equal(chased.entries, 0); assert.equal(chased.rejected['chased'], 1);
  assert.equal(runBacktest({ ...input, bars: spent, events: evSpent }).entries, 1, 'without the filter the same signal is taken');
});

test('the context gate refuses an entry it blocks, and an unknown reading is allowed or blocked as asked', () => {
  const b = (i: number, o: number, h: number, l: number, c: number) => ({ time: i * M15, open: o, high: h, low: l, close: c, volume: 1 });
  const bars = [...Array.from({ length: 20 }, (_, i) => b(i, 100, 100.5, 99.5, 100)), b(20, 100, 100.5, 99.5, 100), b(21, 100, 106, 100, 105), b(22, 105, 105, 105, 105)];
  const ev = [{ kind: 'entry', side: 'long', price: 100, barTime: 20 * M15, barIndex: 20, source: 'alert', label: 'buy', message: '' }] as any;
  const input = { ...base, bars, events: ev, exitMode: 'levels' as const, tickSize: 0.1 };
  assert.equal(runBacktest({ ...input, contextGate: () => 'allow' }).entries, 1);
  const blocked = runBacktest({ ...input, contextGate: () => 'block' });
  assert.equal(blocked.entries, 0); assert.equal(blocked.rejected['context'], 1);
  assert.equal(runBacktest({ ...input, contextGate: () => 'unknown' }).entries, 1, 'unknown allows by default');
  const unk = runBacktest({ ...input, contextGate: () => 'unknown', unknownIs: 'block' });
  assert.equal(unk.entries, 0); assert.equal(unk.rejected['no context'], 1);
});
