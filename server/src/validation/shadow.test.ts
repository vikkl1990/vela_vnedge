import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG } from '../config.ts';
import { Db } from '../db.ts';
import type { SignalRow } from '../db.ts';
import { ShadowLedger } from './shadow.ts';

const T0 = Date.UTC(2026, 8, 1);
const bars15 = Array.from({ length: 60 }, (_, i) => ({ time: T0 + i * 900_000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

function setup(db?: Db) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.paper.minRiskFeeRatio = 0; cfg.validation.shadow.minProb = 0.6;
  const candles = Object.assign(new EventEmitter(), { get: () => bars15 });
  const signals = new EventEmitter();
  let now = T0 + 60 * 900_000;
  const shadow = new ShadowLedger({ cfgRef: () => cfg, candles: candles as any, signals: signals as any, marketInfo: async () => ({ contractValue: 0.001, tickSize: 0.5 }), db, now: () => now }).attach();
  const sig = (id: number, extra: Partial<SignalRow>): SignalRow => ({ id, at: now, barTime: now - 900_000, scannerId: 's', scannerName: 'S', symbol: 'BTCUSD', tf: '15m', kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 110, 115], score: null, label: 'LONG', message: '', summary: '', source: 'alert', levelsSource: 'script', action: 'opened', positionId: null, mlProb: null, ...extra });
  return { cfg, candles, signals, shadow, sig, tick: (ms: number) => { now += ms; return now; } };
}

test('shadow: ungated takes every entry, ml-gated skips low-probability ones, fills come from 1m bars', async t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const s = setup(db);
  await s.shadow.onSignal(s.sig(1, { mlProb: 0.3 }));
  let snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.openPositions, 1);
  assert.equal(snap.variants['ml-gated'].openPositions, 0);
  assert.equal(snap.variants['ml-gated'].gated, 1);
  // 1m bar hits TP1..TP3 → position closes in the ungated ledger
  const at = s.tick(120_000);
  s.candles.emit('bar', { symbol: 'BTCUSD', tf: '1m', bar: { time: at - 60_000, open: 100, high: 116, low: 100, close: 115, volume: 1 } });
  snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.openPositions, 0);
  assert.equal(snap.variants.ungated.stats.trades, 1);
  assert.ok(snap.variants.ungated.stats.pnl > 0);
  assert.equal(snap.variants['ml-gated'].stats.trades, 0);
  assert.equal(snap.comparison.leader, 'ungated');
  // a high-probability signal (via the event bus) goes to both
  s.signals.emit('signal', s.sig(2, { mlProb: 0.9, symbol: 'ETHUSD', price: 50, sl: 48, tp: [52] }));
  await new Promise(r => setTimeout(r, 10));
  snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.openPositions, 1);
  assert.equal(snap.variants['ml-gated'].openPositions, 1);
  // stop hit on ETH closes both; a script exit for a symbol without a position is ignored
  s.tick(120_000);
  s.candles.emit('closed', { symbol: 'ETHUSD', tf: '1m', bar: { time: at + 60_000, open: 50, high: 50, low: 47, close: 47.5, volume: 1 } });
  s.shadow.onSignal(s.sig(3, { kind: 'exit', label: 'SL HIT', symbol: 'SOLUSD' }));
  snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.stats.trades, 2);
  assert.equal(snap.variants['ml-gated'].stats.trades, 1);
  assert.ok(snap.variants['ml-gated'].stats.pnl < 0);
  // persisted and restored
  const again = new ShadowLedger({ cfgRef: () => s.cfg, candles: s.candles as any, signals: s.signals as any, marketInfo: async () => ({ contractValue: 0.001, tickSize: 0.5 }), db });
  assert.equal(again.snapshot().variants.ungated.stats.trades, 2);
  again.reset();
  assert.equal(again.snapshot().variants.ungated.stats.trades, 0);
});

test('shadow: script exits close the matching position; disabled ledger ignores signals', async () => {
  const s = setup();
  await s.shadow.onSignal(s.sig(1, { mlProb: 0.9 }));
  s.tick(60_000);
  await s.shadow.onSignal(s.sig(2, { kind: 'exit', label: '🎯 TP1 HIT', price: 105 }));
  let snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.open[0].tpHit[0], true);
  assert.ok(snap.variants.ungated.open[0].qtyOpen < snap.variants.ungated.open[0].qty);
  await s.shadow.onSignal(s.sig(3, { kind: 'exit', label: '🛑 SL HIT', price: 100 }));
  snap = s.shadow.snapshot();
  assert.equal(snap.variants.ungated.openPositions, 0);
  assert.equal(snap.variants.ungated.stats.trades, 1);
  s.cfg.validation.shadow.enabled = false;
  await s.shadow.onSignal(s.sig(4, { symbol: 'ETHUSD' }));
  assert.equal(s.shadow.snapshot().variants.ungated.openPositions, 0);
});
