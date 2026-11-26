import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';
import { trendGateApplies } from './logic.ts';
import { runBacktest } from './backtest.ts';

test('the trend gate can cover chosen timeframes only', () => {
  const g = { enabled: true, emaLen: 200, tf: '', mode: 'follow' as const };
  assert.equal(trendGateApplies(g, '5m'), true, 'no list: every timeframe');
  assert.equal(trendGateApplies({ ...g, tfs: [] }, '5m'), true, 'an empty list is no list');
  assert.equal(trendGateApplies({ ...g, tfs: ['1h', '4h'] }, '1h'), true);
  assert.equal(trendGateApplies({ ...g, tfs: ['1h', '4h'] }, '5m'), false);
  assert.equal(trendGateApplies({ ...g, enabled: false, tfs: ['5m'] }, '5m'), false, 'off is off');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.paper.trendGate = { ...g, tfs: ['1h', '7m'] };
  assert.ok(validateConfig(cfg).includes('paper.trendGate.tfs must list known timeframes'));
  cfg.paper.trendGate = { ...g, tfs: ['1h', '4h'] };
  assert.equal(validateConfig(cfg).some(e => e.includes('trendGate')), false);
});

test('a backtest gates a short in an uptrend only on a covered timeframe', () => {
  const bars = Array.from({ length: 400 }, (_, i) => ({ time: i * 300_000, open: 100 + i * 0.1, high: 100.5 + i * 0.1, low: 99.5 + i * 0.1, close: 100 + i * 0.1, volume: 1 }));
  const t = bars[300].time, px = bars[300].close;
  const events = [{ kind: 'entry' as const, side: 'short' as const, price: px, sl: px + 5, tp: [px - 5, px - 10, px - 15], label: 'x', message: '', source: 'alert' as const, barTime: t, barIndex: 300 }];
  const run = (tfs: string[] | undefined) => {
    const cfg = structuredClone(DEFAULT_CONFIG.paper);
    Object.assign(cfg, { minRiskFeeRatio: 0, maxStopLossPct: 0, liquidation: false, trendGate: { enabled: true, emaLen: 200, tf: '', mode: 'follow', ...(tfs ? { tfs } : {}) } });
    return runBacktest({ scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf: '5m', bars, events: structuredClone(events), cfg, exitMode: 'levels', contractValue: 1, tickSize: 0.01 } as any);
  };
  assert.equal(run(undefined).trades.length, 0, 'the gate on every timeframe refuses the short');
  assert.equal(run(['5m']).trades.length, 0, 'a list naming 5m refuses it too');
  assert.equal(run(['1h', '4h']).trades.length, 1, 'a list without 5m lets the 5m short through');
});
