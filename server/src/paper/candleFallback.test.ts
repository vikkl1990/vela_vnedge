import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from './engine.ts';

test('a post-entry minute wick stops and trails when the tape is silent; the entry minute does not', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, {
    slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0,
    fillSource: 'candles', trailAfterR: 0.5, trailGiveBackPct: 20, breakEvenAfterTp1: false,
    maxSignalAgeSec: 0, requireQuote: false, useSpread: false, maxStopLossPct: 0, minRiskFeeRatio: 0,
  });
  const engine = new PaperEngine(db, () => cfg);
  engine.causalExits = true;
  const opened = engine.onEntry(
    { kind: 'entry', side: 'long', price: 100, sl: 95, tp: [130, 140, 150], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.5, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'levels' },
  );
  const p = opened.position!;
  assert.equal(p.status, 'open');
  // Same minute as the fill: the low may predate the entry, so only the close counts.
  engine.onBar('BTCUSD', { time: 60_000, open: 100, high: 112, low: 94, close: 101 }, 90_000);
  assert.equal(p.status, 'open');
  assert.equal(p.sl, 95);
  // Next minute is entirely after the fill. The low trades through 95 and the open gaps to 90.
  engine.onBar('BTCUSD', { time: 120_000, open: 90, high: 101, low: 88, close: 100 }, 180_000);
  assert.equal(p.status, 'open', 'the stop is requested, not filled, until depth settles');
  const intent = engine.pendingExits()[0];
  assert.equal(intent?.reason, 'sl');
  assert.equal(intent?.reference, 90, 'a gap through the stop fills at the open, not at the stop');
  const both = new PaperEngine(db, () => cfg);
  both.causalExits = true;
  const second = both.onEntry(
    { kind: 'entry', side: 'long', price: 100, sl: 95, tp: [110, 120, 130], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf: '15m', market: { tickSize: 0.5, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'levels' },
  ).position!;
  both.onBar('ETHUSD', { time: 120_000, open: 100, high: 140, low: 90, close: 110 }, 180_000);
  assert.equal(both.pendingExits().find(i => i.symbol === 'ETHUSD')?.reason, 'sl', 'a bar that trades the stop and a target takes the stop');
  assert.equal(second.status, 'open');
  db.db.close();
});

test('a post-entry spike that closes back ratchets the trail from the high', () => {
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, {
    slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0,
    fillSource: 'candles', trailAfterR: 0.5, trailGiveBackPct: 0, trailDistanceR: 1, breakEvenAfterTp1: false,
    maxSignalAgeSec: 0, requireQuote: false, useSpread: false, maxStopLossPct: 0, minRiskFeeRatio: 0,
  });
  const engine = new PaperEngine(db, () => cfg);
  engine.causalExits = true;
  const opened = engine.onEntry(
    { kind: 'entry', side: 'long', price: 100, sl: 95, tp: [200, 210, 220], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.5, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'levels' },
  );
  const p = opened.position!;
  engine.onBar('BTCUSD', { time: 120_000, open: 100, high: 112, low: 100, close: 101 }, 180_000);
  assert.ok((p.peakR ?? 0) > 2, `peak follows the high, saw ${p.peakR}`);
  const desired = engine.exitExecution.state(p.id)?.desired_stop ?? p.sl;
  assert.ok(desired != null && desired > 95, `trail tightens, saw ${desired}`);
  db.db.close();
});
