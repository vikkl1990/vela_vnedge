/** Phase 2 execution realism: tape fills, latency, resting limits, mark-price liquidation, funding, depth slippage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type PaperConfig } from '../config.ts';
import { PaperEngine } from './engine.ts';
import { applyTrade, applyFunding, openPosition, slip, slippageBpsFor } from './logic.ts';
import { MarkStore, nextFundingAfter } from '../data/marks.ts';
import { parseTrade, toMs } from '../delta/ws.ts';

function setup(t: { after: (fn: () => void) => void }, paper: Partial<PaperConfig> = {}) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'tape', latencyMs: 1500 }, paper);
  const engine = new PaperEngine(db, () => cfg);
  const signal = (side: 'long' | 'short' = 'long', at = 60_010, scannerId = 's') => engine.onEntry(
    { kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId, scannerName: scannerId, symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both' });
  return { db, cfg, engine, signal };
}

test('tape mode: entry is pending until the first print after signal time + latency', t => {
  const { engine, signal } = setup(t);
  const d = signal('long', 60_000);
  assert.equal(d.action, 'pending');
  assert.equal(engine.openPositions().length, 0);
  assert.equal(engine.pendingEntries().length, 1);
  engine.onTrade('BTCUSD', 100.5, 1, 61_000, 61_000);   // inside the latency window → no fill
  assert.equal(engine.openPositions().length, 0);
  engine.onTrade('BTCUSD', 101, 1, 61_600, 61_600);     // first print after +1500 ms → fill at that print
  const p = engine.openPositions()[0];
  assert.ok(p);
  assert.equal(p.entryPrice, 101);
  assert.equal(p.entryAt, 61_600);
  assert.equal(p.sl, 95);
  assert.deepEqual(p.tp, [105, 110, 115]);
  assert.equal(engine.pendingEntries().length, 0);
  assert.equal(signal('long', 61_700).action, 'ignored', 'already in position');
});

test('tape mode: a print past the stop cancels the pending entry instead of opening it', t => {
  const { engine, signal } = setup(t);
  signal('long', 60_000);
  engine.onTrade('BTCUSD', 94, 1, 61_600, 61_600);
  assert.equal(engine.openPositions().length, 0);
  assert.equal(engine.pendingEntries().length, 0);
});

test('tape mode: stop triggers on the last trade and fills at the print (gap through the stop)', t => {
  const { engine, signal } = setup(t);
  signal('long', 60_000);
  engine.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  const p = engine.openPositions()[0];
  engine.onTrade('BTCUSD', 95.5, 1, 62_000, 62_000);
  assert.equal(p.status, 'open');
  engine.onTrade('BTCUSD', 94.5, 1, 62_100, 62_100);
  assert.equal(p.status, 'closed');
  assert.equal(p.exitReason, 'sl');
  assert.equal(p.exitPrice, 94.5, 'a stop-market fills at the print that triggered it, not at the stop level');
});

test('resting TP limits: through requires a print beyond the level, touch fills at the level', t => {
  const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false };
  const mk = (limitFill: 'touch' | 'through') => openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10, contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [105, 110, 115], riskAmount: 50, levelsSource: 'script', signalId: null, cfg: { ...cfg, limitFill }, bt: false, leverage: 1 });
  const through = mk('through');
  assert.equal(applyTrade(through, { time: 1, price: 105 }, { ...cfg, limitFill: 'through' }).length, 0, 'a print at the level does not fill a resting limit (queue ahead of us)');
  const f = applyTrade(through, { time: 2, price: 105.25 }, { ...cfg, limitFill: 'through' });
  assert.equal(f.length, 1); assert.equal(f[0].reason, 'tp1'); assert.equal(f[0].price, 105, 'limit fills at its own price');
  assert.equal(through.breakEven, true);
  const touch = mk('touch');
  const g = applyTrade(touch, { time: 1, price: 105 }, { ...cfg, limitFill: 'touch' });
  assert.equal(g.length, 1); assert.equal(g[0].reason, 'tp1');
  // short side symmetry
  const shortPos = openPosition({ id: 2, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'short', qty: 10, contractValue: 1, entryPrice: 100, at: 0, sl: 105, tp: [95, 90, 85], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: false, leverage: 1 });
  assert.equal(applyTrade(shortPos, { time: 1, price: 95 }, { ...cfg, limitFill: 'through' }).length, 0);
  assert.equal(applyTrade(shortPos, { time: 2, price: 94.75 }, { ...cfg, limitFill: 'through' })[0]?.reason, 'tp1');
});

test('liquidation triggers on the mark price, not on the last trade', t => {
  const { engine, signal, cfg } = setup(t, { liquidation: true, maintenanceMarginPct: 0.5, maxLeverage: 50, minLeverage: 50, sizingMode: 'quality' });
  signal('long', 60_000);
  engine.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  const p = engine.openPositions()[0];
  assert.ok(p.liqPrice !== null && p.liqPrice > 95, `liq ${p.liqPrice} sits above the 95 stop at 50x`);
  // print above the stop and liquidation, but mark below liquidation → liquidated on mark
  engine.onMarkPrice('BTCUSD', p.liqPrice! - 0.1, 62_000);
  assert.equal(p.status, 'closed');
  assert.equal(p.exitReason, 'liquidation');
  assert.equal(engine.markPrice('BTCUSD'), p.liqPrice! - 0.1);
  void cfg;
});

test('a print below the stop with the mark still safe is a stop, not a liquidation', t => {
  const { engine, signal } = setup(t, { liquidation: true, maintenanceMarginPct: 0.5, maxLeverage: 10, minLeverage: 5, sizingMode: 'quality' });
  signal('long', 60_000);
  engine.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  const p = engine.openPositions()[0];
  engine.onMarkPrice('BTCUSD', 99.5, 61_900);
  engine.onTrade('BTCUSD', 94.9, 1, 62_000, 62_000);
  assert.equal(p.exitReason, 'sl');
});

test('funding: rate × notional at mark, longs pay a positive rate and shorts receive it, recorded as a funding fill', t => {
  const { engine, signal } = setup(t);
  signal('long', 60_000, 'a');
  signal('short', 60_000, 'b');
  engine.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  const [l, s] = engine.openPositions();
  assert.equal(l.side, 'long'); assert.equal(s.side, 'short');
  engine.onMarkPrice('BTCUSD', 100, 61_700);
  const n = engine.chargeFunding('BTCUSD', 0.01, 8 * 3600 * 1000);
  assert.equal(n, 2);
  const lf = l.fills.find(f => f.reason === 'funding')!;
  assert.ok(lf); assert.equal(lf.qty, 0);
  assert.ok(Math.abs(lf.pnl - (-(0.01 / 100) * l.qtyOpen * 100)) < 1e-9, `long pays ${lf.pnl}`);
  const sf = s.fills.find(f => f.reason === 'funding')!;
  assert.ok(sf.pnl > 0, 'short receives');
  assert.ok(Math.abs(l.realizedPnl - lf.pnl) < 1e-9);
  const orders = engine.orders(10);
  assert.ok(orders.some(o => o.reason === 'funding' && o.side === 'pay'));
  // disabled → no charge
  const { engine: e2, signal: s2 } = setup(t, { fundingCharges: false });
  s2('long', 60_000); e2.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  assert.equal(e2.chargeFunding('BTCUSD', 0.01, 8 * 3600 * 1000), 0);
});

test('applyFunding ignores closed positions, zero rates and pre-entry timestamps', () => {
  const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0 };
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10, contractValue: 1, entryPrice: 100, at: 1000, sl: 95, tp: [105], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: false, leverage: 1 });
  assert.equal(applyFunding(pos, 0, 100, 2000), null);
  assert.equal(applyFunding(pos, 0.01, 100, 500), null);
  assert.ok(applyFunding(pos, -0.02, 100, 2000)!.pnl > 0, 'negative rate pays longs');
  pos.status = 'closed';
  assert.equal(applyFunding(pos, 0.01, 100, 3000), null);
});

test('MarkStore schedules one funding charge per realization slot and skips missed slots', () => {
  const m = new MarkStore();
  const H8 = 8 * 3600 * 1000;
  m.setFunding('BTCUSD', { ratePct: 0.01, intervalSec: 28800, nextAt: 10 * H8, at: 9 * H8 + 1000 });
  assert.deepEqual(m.dueFunding(10 * H8 - 1), []);
  assert.deepEqual(m.dueFunding(10 * H8), [{ symbol: 'BTCUSD', ratePct: 0.01, at: 10 * H8 }]);
  assert.deepEqual(m.dueFunding(10 * H8 + 5000), [], 'charged once');
  // a stale re-publication of the same slot must not re-charge
  m.setFunding('BTCUSD', { ratePct: 0.02, intervalSec: 28800, nextAt: 10 * H8, at: 10 * H8 + 1 });
  assert.deepEqual(m.dueFunding(10 * H8 + 6000), []);
  // feed silent for two slots → only the most recent slot is charged, at the latest rate
  assert.deepEqual(m.dueFunding(13 * H8 + 1), [{ symbol: 'BTCUSD', ratePct: 0.02, at: 13 * H8 }]);
  assert.equal(nextFundingAfter(10 * H8 + 1), 11 * H8);
  assert.equal(nextFundingAfter(10 * H8), 11 * H8);
});

test('tape mode falls back to 1m candles once the tape is silent for tapeFallbackMs', t => {
  const { engine, signal } = setup(t, { tapeFallbackMs: 5000 });
  signal('long', 60_000);
  engine.onTrade('BTCUSD', 100, 1, 61_600, 61_600);
  const p = engine.openPositions()[0];
  // tape fresh: the candle low through the stop is ignored (prints decide)
  engine.onBar('BTCUSD', { time: 60_000, high: 101, low: 90, close: 100 }, 63_000);
  assert.equal(p.status, 'open');
  // tape silent > 5 s: candles take over, only new movement counts
  engine.onBar('BTCUSD', { time: 60_000, high: 101, low: 90, close: 100 }, 70_000);
  assert.equal(p.status, 'open', 'unchanged candle → nothing new happened');
  engine.onBar('BTCUSD', { time: 120_000, high: 101, low: 94, close: 99 }, 120_010);
  assert.equal(p.exitReason, 'sl');
  assert.equal(p.exitPrice, 95, 'candle fallback fills at the stop level like the legacy path');
});

test('tape mode: pending entry fills on the candle close when the tape is silent, and expires after 60 s', t => {
  const { engine, signal } = setup(t);
  signal('long', 60_000);
  engine.onBar('BTCUSD', { time: 60_000, high: 101, low: 99, close: 100.5 }, 61_000);
  assert.equal(engine.openPositions().length, 0, 'still inside the latency window');
  engine.onBar('BTCUSD', { time: 60_000, high: 101, low: 99, close: 100.5 }, 62_000);
  assert.equal(engine.openPositions()[0]?.entryPrice, 100.5);
  const { engine: e2, signal: s2 } = setup(t);
  s2('long', 60_000);
  e2.housekeeping(61_500 + 60_000 + 1);
  assert.equal(e2.pendingEntries().length, 0);
  assert.equal(e2.openPositions().length, 0);
});

test('candles mode reproduces the legacy immediate fill regardless of latency and tape settings', t => {
  const { engine, signal } = setup(t, { fillSource: 'candles', latencyMs: 5000 });
  const d = signal('long', 60_000);
  assert.equal(d.action, 'opened');
  assert.equal(d.position!.entryPrice, 100);
  engine.onTrade('BTCUSD', 90, 1, 60_100, 60_100);
  assert.equal(d.position!.status, 'open', 'prints do not fill in candles mode');
  engine.onBar('BTCUSD', { time: 120_000, high: 101, low: 94, close: 99 }, 120_010);
  assert.equal(d.position!.exitReason, 'sl');
});

test('slippage scales with notional against the depth assumption', () => {
  const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 2, depthUsdPerBp: 50_000 };
  assert.equal(slippageBpsFor(cfg, 0), 2);
  assert.equal(slippageBpsFor(cfg, 100_000), 4);
  assert.ok(Math.abs(slip(100, 'buy', cfg, 100_000) - 100.04) < 1e-9);
  assert.ok(Math.abs(slip(100, 'sell', cfg, 100_000) - 99.96) < 1e-9);
  assert.equal(slippageBpsFor({ ...cfg, depthUsdPerBp: 0 }, 1e9), 2, 'depth 0 = legacy fixed slippage');
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 1000, contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [105], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: false, leverage: 1 });
  assert.ok(Math.abs(pos.entryPrice - 100.04) < 1e-9, 'entry of 100k notional pays 2 + 2 bps');
});

test('all_trades message parsing normalises µs timestamps and string prices', () => {
  const t = parseTrade('BTCUSD', { buyer_role: 'taker', price: '81288.5', seller_role: 'maker', size: 25, timestamp: 1789923188341657 })!;
  assert.equal(t.price, 81288.5); assert.equal(t.qty, 25); assert.equal(t.timeMs, 1789923188341); assert.equal(t.aggressor, 'buy');
  assert.equal(parseTrade('BTCUSD', { price: 'x' }), null);
  assert.equal(toMs(1789948800000000, 0), 1789948800000);
  assert.equal(toMs(1789948800000, 0), 1789948800000);
  assert.equal(toMs(1789948800, 0), 1789948800000);
});
