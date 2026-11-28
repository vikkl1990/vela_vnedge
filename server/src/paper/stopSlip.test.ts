import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';
import { runBacktest } from './backtest.ts';
import { stopRunaway } from './logic.ts';

test('stopRunaway charges ATR past the level against the trade, and nothing when off', () => {
  assert.equal(stopRunaway('long', 99, { stopSlipAtr: 0.1 }, 2), 98.8);
  assert.equal(stopRunaway('short', 101, { stopSlipAtr: 0.1 }, 2), 101.2);
  assert.equal(stopRunaway('long', 99, { stopSlipAtr: 0 }, 2), 99);
  assert.equal(stopRunaway('long', 99, {}, 2), 99);
  assert.equal(stopRunaway('long', 99, { stopSlipAtr: 0.1 }, undefined), 99, 'no ATR, no charge');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.paper.stopSlipAtr = 2;
  assert.ok(validateConfig(cfg).includes('paper.stopSlipAtr must be 0..1'));
});

test('a backtest stop-out loses more with stopSlipAtr than without', () => {
  // flat bars, then a long whose stop is hit on the next bars
  const bars = Array.from({ length: 300 }, (_, i) => ({ time: i * 300_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }));
  for (let i = 251; i < 300; i++) Object.assign(bars[i], { open: 96, high: 96.5, low: 95, close: 95.5 });
  const events = [{ kind: 'entry' as const, side: 'long' as const, price: 100, sl: 98, tp: [104, 106, 108], label: 'x', message: '', source: 'alert' as const, barTime: bars[249].time, barIndex: 249 }];
  const run = (k: number) => {
    const cfg = structuredClone(DEFAULT_CONFIG.paper);
    Object.assign(cfg, { minRiskFeeRatio: 0, maxStopLossPct: 0, liquidation: false, stopSlipAtr: k, trendGate: { enabled: false, emaLen: 200, tf: '', mode: 'follow' } });
    return runBacktest({ scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf: '5m', bars, events: structuredClone(events), cfg, exitMode: 'levels', contractValue: 1, tickSize: 0.01 } as any).trades[0];
  };
  const plain = run(0), slipped = run(0.5);
  assert.ok(plain && slipped);
  assert.ok(slipped.exitPrice! < plain.exitPrice!, `${slipped.exitPrice} < ${plain.exitPrice}`);
  assert.ok(slipped.rMultiple! < plain.rMultiple!);
});
