import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from './engine.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false });
  const engine = new PaperEngine(db, () => cfg);
  const open = (side: 'long' | 'short' = 'long') => engine.onEntry({ kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  return { db, cfg, engine, open };
}

test('entry-minute stops react to new movement without using pre-entry extremes', t => {
  const { engine, open } = setup(t);
  engine.onBar('BTCUSD', { time: 60_000, high: 110, low: 90, close: 100 }, 60_000);
  const p = open();
  engine.onBar('BTCUSD', { time: 60_000, high: 110, low: 90, close: 101 }, 60_020);
  assert.equal(p.status, 'open');
  engine.onBar('BTCUSD', { time: 60_000, high: 110, low: 90, close: 94 }, 60_030);
  assert.equal(p.exitReason, 'sl');
  assert.equal(p.exitAt, 60_030);
  assert.equal(p.exitPrice, 95);
});

test('short entry-minute stop works even without an earlier candle snapshot', t => {
  const { engine, open } = setup(t);
  const p = open('short');
  engine.onBar('BTCUSD', { time: 60_000, high: 106, low: 90, close: 106 }, 60_020);
  assert.equal(p.exitReason, 'sl');
  assert.equal(p.exitPrice, 105);
});

test('duplicate candle cannot hit newly raised BE stop, including after restart', t => {
  const { engine, open, db, cfg } = setup(t);
  engine.onBar('BTCUSD', { time: 60_000, high: 100, low: 99, close: 100 }, 60_000);
  const p = open();
  const candle = { time: 60_000, high: 106, low: 99, close: 106 };
  engine.onBar('BTCUSD', candle, 60_020);
  assert.equal(p.fills.at(-1)?.reason, 'tp1');
  assert.equal(p.breakEven, true);
  engine.onBar('BTCUSD', candle, 60_021);
  assert.equal(p.status, 'open');
  const resumed = new PaperEngine(db, () => cfg);
  resumed.onBar('BTCUSD', candle, 60_022);
  assert.equal(resumed.openPositions().length, 1);
  resumed.onBar('BTCUSD', { ...candle, close: 100 }, 60_030);
  assert.equal(resumed.openPositions().length, 0);
  assert.equal(resumed.trades()[0].exitReason, 'be');
});

test('a new minute checks full extremes and stale candles do not alter a position', t => {
  const { engine, open } = setup(t);
  const p = open();
  engine.onBar('BTCUSD', { time: 60_000, high: 101, low: 99, close: 101 }, 60_020);
  engine.onBar('BTCUSD', { time: 0, high: 120, low: 80, close: 90 }, 60_021);
  assert.equal(p.status, 'open');
  assert.equal(engine.mark('BTCUSD'), 101);
  engine.onBar('BTCUSD', { time: 120_000, high: 101, low: 94, close: 99 }, 120_010);
  assert.equal(p.exitReason, 'sl');
});
