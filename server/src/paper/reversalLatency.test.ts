import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';

function setup() {
  const db = new Db(':memory:');
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 1500, minRiskFeeRatio: 0, allowReversal: true, reversalMinR: -99, limitEntry: { enabled: false, tfs: [], atr: 0, bars: 2, books: [] } });
  const engine = new PaperEngine(db, () => cfg);
  const base = Math.floor(Date.now() / 60_000) * 60_000;
  const ctx = (at: number) => ({ scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.5, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both' as const, atr: 1 });
  const sig = (side: 'long' | 'short', at: number, sl: number) => engine.onEntry({ kind: 'entry', side, price: 100, sl, tp: [], label: side, message: '', source: 'alert', barTime: at - 900_000, barIndex: 0 }, ctx(at) as any);
  return { engine, base, sig };
}

test('decision 186: a reversal in latency mode closes the held position only when the new entry fills', () => {
  const { engine, base, sig } = setup();
  sig('long', base, 95);
  engine.onBar('BTCUSD', { time: base, high: 100.5, low: 99.5, close: 100 }, base + 2000);
  const long = engine.openPositions()[0];
  assert.equal(long?.side, 'long');
  const d = sig('short', base + 60_000, 105);
  assert.equal(d.action, 'pending');
  assert.equal(engine.openPositions()[0]?.side, 'long', 'the long is still held while the short waits for its fill');
  engine.onBar('BTCUSD', { time: base + 60_000, high: 100.2, low: 99.8, close: 100 }, base + 62_000);
  const open = engine.openPositions();
  assert.equal(open.length, 1); assert.equal(open[0].side, 'short', 'filled: the long closed, the short opened');
});

test('decision 186: a reversal whose new entry is cancelled at the fill keeps the held position', () => {
  const { engine, base, sig } = setup();
  sig('long', base, 95);
  engine.onBar('BTCUSD', { time: base, high: 100.5, low: 99.5, close: 100 }, base + 2000);
  sig('short', base + 60_000, 101);
  // before the fill, price runs through the short's stop: the short is cancelled
  engine.onBar('BTCUSD', { time: base + 60_000, high: 102, low: 101.5, close: 101.8 }, base + 62_000);
  const open = engine.openPositions();
  assert.equal(open.length, 1); assert.equal(open[0].side, 'long', 'the book is not left flat');
});
