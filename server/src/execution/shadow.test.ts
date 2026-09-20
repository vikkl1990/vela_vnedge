import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine, orderOf } from '../paper/engine.ts';
import { exchangeTimeMs, freshQuote } from './shadow.ts';
import { TestnetExecutor } from './testnet.ts';

const now = 1_800_000_000_100;
function setup(t: { after: (fn: () => void) => void }) {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.execution.mode = 'shadow'; Object.assign(cfg.paper, { liquidation: false, minRiskFeeRatio: 0 });
  const engine = new PaperEngine(db, () => cfg);
  const quote = (bid = 99, ask = 101, timeMs = now) => engine.onQuote({ symbol: 'BTCUSD', bid, ask, markPrice: (bid + ask) / 2, timeMs }, timeMs);
  const open = (side: 'long' | 'short' = 'long', at = now, barTime = now - 60_100) => engine.onEntry({ kind: 'entry', side, price: 80, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [110, 115, 120] : [90, 85, 80], label: 'entry', message: '', source: 'alert', barIndex: 1, barTime }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1m', market: { contractValue: 1, tickSize: .5 }, refPrice: 80, at, signalId: null, exitMode: 'both' });
  return { cfg, db, engine, quote, open };
}

test('shadow buys ask and sells bid, never the historical signal price or synthetic slippage', t => {
  const { engine, quote, open } = setup(t); quote();
  const p = open().position!;
  assert.equal(p.entryPrice, 101);
  assert.equal(p.executionMode, 'shadow');
  assert.equal(orderOf(p, p.fills[0]).executionMode, 'shadow');
  assert.equal(p.fees, p.qty * 101 * DEFAULT_CONFIG.paper.feeRatePct / 100);
  quote(94, 96, now + 1);
  assert.equal(p.exitPrice, 94);
  assert.equal(p.exitReason, 'sl');
  assert.equal(engine.openPositions().length, 0);
});

test('shadow shorts enter bid and stop at ask', t => {
  const { quote, open } = setup(t); quote(); const p = open('short').position!;
  assert.equal(p.entryPrice, 99);
  quote(104, 106, now + 1);
  assert.equal(p.exitPrice, 106);
});

test('shadow requires fresh quotes and recently closed signals', t => {
  const { quote, open, engine } = setup(t);
  assert.match(open().reason!, /fresh/);
  quote();
  assert.match(open('long', now + 11_000).reason!, /fresh/);
  assert.match(open('long', now, now - 120_000).reason!, /stale/);
  engine.clearQuotes();
  assert.match(open().reason!, /fresh/);
});

test('shadow ignores candle ranges and rejected or out-of-order quotes', t => {
  const { quote, open, engine } = setup(t); quote(); const p = open().position!;
  engine.onBar('BTCUSD', { time: now, high: 200, low: 1, close: 1 }, now + 1);
  quote(94, 96, now - 1);
  quote(95, 94, now + 1);
  assert.equal(p.status, 'open');
  engine.onQuote({ symbol: 'BTCUSD', bid: 94, ask: 96, markPrice: 95, timeMs: now + 1 }, now + 20_000);
  assert.equal(p.status, 'open');
});

test('shadow target exits use observed bid and taker fees on every leg', t => {
  const { quote, open, cfg } = setup(t); quote(); const p = open().position!;
  quote(116, 118, now + 1);
  assert.deepEqual(p.fills.slice(1).map(f => f.price), [116, 116]);
  assert.equal(p.sl, 101);
  for (const f of p.fills.slice(1)) assert.equal(f.fee, f.qty * 116 * cfg.paper.feeRatePct / 100);
});

test('shadow liquidation uses mark trigger and observed exit quote rather than theoretical fill', t => {
  const { cfg, quote, open, engine } = setup(t); cfg.paper.liquidation = true;
  quote(); const p = open().position!;
  engine.onQuote({ symbol: 'BTCUSD', bid: 80, ask: 82, markPrice: 85, timeMs: now + 1 }, now + 1);
  assert.equal(p.exitReason, 'liquidation');
  assert.equal(p.exitPrice, 80);
});

test('shadow persistence retains execution mode and does not reuse quotes after restart', t => {
  const { db, cfg, quote, open } = setup(t); quote(); open();
  const resumed = new PaperEngine(db, () => cfg);
  assert.equal(resumed.openPositions()[0].executionMode, 'shadow');
  assert.equal(resumed.closeManual(resumed.openPositions()[0].id), undefined);
  cfg.execution.mode = 'paper';
  assert.throws(() => new PaperEngine(db, () => cfg), /original execution mode/);
});

test('exchange timestamps accept documented units and reject missing values', () => {
  for (const v of [1_800_000_000, 1_800_000_000_000, 1_800_000_000_000_000]) assert.equal(exchangeTimeMs(v), 1_800_000_000_000);
  assert.ok(Number.isNaN(exchangeTimeMs(undefined)));
  assert.equal(freshQuote({ symbol: 's', bid: 2, ask: 1, markPrice: 1, timeMs: now }, now), false);
});

test('shadow-labelled fills never reach an exchange client even with a mirror attached', async () => {
  const bus = new EventEmitter();
  const executor = new TestnetExecutor(bus as any, {} as any);
  let submitted = 0;
  (executor as any).rest = { products: async () => new Map([['BTCUSD', { id: 1 }]]), wallet: async () => [], placeOrder: async () => { submitted++; } };
  await executor.start();
  bus.emit('order', { executionMode: 'shadow', symbol: 'BTCUSD', side: 'buy', qty: 1, reason: 'entry', positionId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted, 0);
});

test('shadow script exits use the current quote for all legs, and manual closes wait for fresh data', t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const { quote, open, engine } = setup(t); quote(); const p = open().position!;
  engine.onScriptExit('s', 'BTCUSD', '1m', 'tp2', 999, now, 'both');
  assert.deepEqual(p.fills.slice(1).map(f => f.price), [99, 99]);
  engine.clearQuotes();
  assert.equal(engine.closeManual(p.id), undefined);
  quote(102, 103, now + 1);
  assert.equal(engine.closeManual(p.id)?.exitPrice, 102);
});

test('removing a scanner keeps shadow exposure managed by its stop and targets', t => {
  const { quote, open, cfg } = setup(t); quote(); const p = open().position!;
  cfg.scanners.s = { enabled: false, hidden: true, symbols: null, timeframes: null, exitMode: 'both' };
  quote(102, 103, now + 1);
  assert.equal(p.status, 'open');
  quote(94, 95, now + 2);
  assert.equal(p.exitReason, 'sl');
});
