import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';

function setup(book: number, books: Array<'account' | 'shadow'>) {
  const db = new Db(':memory:');
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.paper.structureTrail = { enabled: true, pivot: 14, incrPct: 100, books };
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0, trailAfterR: 0, floorAtR: 0, trailSteps: [] });
  const engine = new PaperEngine(db, () => cfg, { book });
  const pos = engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [120, 130, 140], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' }).position!;
  return { engine, pos };
}

test('decision 178: the shadow book takes the structure stop over its trail, from the last closed bar of the trade\'s timeframe; the account does not until named', () => {
  const shadow = setup(2, ['shadow']);
  shadow.engine.structureFor = () => ({ long: 98.5, short: null });
  shadow.engine.onBar('BTCUSD', { time: 120_000, high: 102, low: 100.5, close: 101.5 }, 180_010);
  assert.equal(shadow.pos.sl, 98.5, 'the stop moved up to the structure level');
  shadow.engine.structureFor = () => ({ long: 97, short: null });
  shadow.engine.onBar('BTCUSD', { time: 180_000, high: 102, low: 101, close: 101.8 }, 240_010);
  assert.equal(shadow.pos.sl, 98.5, 'a lower level never moves it back');
  shadow.engine.structureFor = () => ({ long: null, short: 110 });
  shadow.engine.onBar('BTCUSD', { time: 240_000, high: 102, low: 101, close: 101.9 }, 300_010);
  assert.equal(shadow.pos.sl, 98.5, 'the short side\'s level is not a long\'s');
  shadow.engine.structureFor = () => ({ long: 101, short: null });
  shadow.engine.onBar('BTCUSD', { time: 300_000, high: 102, low: 101.2, close: 101.9 }, 360_010);
  assert.equal(shadow.pos.sl, 101); assert.equal(shadow.pos.breakEven, true, 'past the entry the trade is break-even');
  shadow.engine.onBar('BTCUSD', { time: 360_000, high: 102, low: 100.9, close: 101 }, 420_010);
  assert.equal(shadow.pos.status, 'closed'); assert.equal(shadow.pos.exitReason, 'trail', 'a stop in profit reads as a trail exit');

  const account = setup(0, ['shadow']);
  account.engine.structureFor = () => ({ long: 98.5, short: null });
  account.engine.onBar('BTCUSD', { time: 120_000, high: 102, low: 100.5, close: 101.5 }, 180_010);
  assert.equal(account.pos.sl, 95, 'the account is not in the books list: untouched');
});
