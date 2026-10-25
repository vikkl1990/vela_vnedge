import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';
import { admissionCostPct, crossingSlippageBps } from './costs.ts';
import { applyFunding, checkRiskVsFees, closingFeeWaived, feeFor, fillExit, openPosition, sizeContracts } from './logic.ts';
import { runBacktest } from './backtest.ts';
import { Db } from '../db.ts';
import { PaperEngine } from './engine.ts';
import { atrNeededPct } from '../incubator/cycle.ts';
const cfg = () => ({ ...structuredClone(DEFAULT_CONFIG.paper), liquidation: false, slippageBps: 2, quotedSlippageBps: 0, feeRatePct: 0.05, makerFeeRatePct: 0.02, feeTaxPct: 18, minRiskFeeRatio: 6, depthUsdPerBp: 0 });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const position = (c = cfg(), extra = {}) => openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 100, contractValue: 1, entryPrice: 100, at: 1_000_000, sl: 90, tp: [110], riskAmount: 1000, levelsSource: 'script', signalId: null, cfg: c, bt: false, ...extra });

test('cost budget uses entry liquidity and reserves full taker stop-out, never a prospective waiver', () => {
  const c = cfg(); c.scalperOffer!.enabled = true;
  near(admissionCostPct(c), 0.118);
  near(admissionCostPct(c, 0, { maker: true }), 0.0826);
  near(admissionCostPct(c, 0.02, { maker: true }), 0.0926);
  assert.notEqual(checkRiskVsFees(100, 99.5, c, 'BTCUSD'), null);
  assert.equal(checkRiskVsFees(100, 99.5, c, 'BTCUSD', 0, { maker: true }), null);
  assert.notEqual(checkRiskVsFees(100, 99.6, c, 'BTCUSD', 0, { maker: true }), null);
});

test('a maker limit passes both initial admission and the fill recheck on its own cost budget', () => {
  const db = new Db(':memory:'); const c = structuredClone(DEFAULT_CONFIG);
  Object.assign(c.paper, cfg(), { latencyMs: 0, skipScriptStops: false, useSpread: false, requireQuote: false, fillSource: 'candles', maxSignalAgeSec: 0, sizingMode: 'risk', minSizeShare: 0, limitEntry: { enabled: true, tfs: ['1h'], atr: 0, bars: 2, books: ['account'] } });
  const e = new PaperEngine(db, () => c); const at = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
  const d = e.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 99.5, tp: [110], label: '', message: '', source: 'alert', barTime: at - 3600000, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1h', market: { contractValue: 1, tickSize: 0.01 }, refPrice: 100, at, signalId: null, exitMode: 'both', atr: 1 });
  assert.equal(d.action, 'pending', d.reason);
  e.onBar('BTCUSD', { time: at + 60000, high: 100.1, low: 99.9, close: 100 }, at + 120000);
  assert.equal(e.openPositions().length, 1);
  const p = e.openPositions()[0]; near(p.entryPrice, 100); near(p.fees, feeFor(100, p.qty, 1, c.paper, true));
});

test('sizing does not add taker entry fees or fallback slippage to a maker entry', () => {
  const c = { ...cfg(), sizingMode: 'risk' as const, minSizeShare: 0 };
  const s = sizeContracts(100, 99, { equity: 10000, contractValue: 1, tickSize: 0.01, cfg: c, entryExecution: { maker: true } });
  const stopFill = 99 * (1 - 2 / 10000);
  near(s.riskAmount / s.qty, 100 - stopFill + feeFor(100, 1, 1, c, true) + feeFor(stopFill, 1, 1, c));
});

test('measured crossing replaces fallback slippage; explicit quote stress remains additional', () => {
  near(crossingSlippageBps(cfg(), 0.02), 1);
  near(crossingSlippageBps({ ...cfg(), quotedSlippageBps: 3 }, 0.02), 4);
  const c = { ...cfg(), minRiskFeeRatio: 0, trailAfterR: 0, floorAtR: 0, allowReversal: false };
  const H = 3600000, base = 1700000000000;
  const bars = Array.from({ length: 35 }, (_, i) => ({ time: base + i * H, open: 100, high: 100.02, low: 99.98, close: 100, volume: 1 }));
  const events = [{ kind: 'entry' as const, side: 'long' as const, sl: 90, tp: [110], price: 100, barTime: bars[30].time, barIndex: 30, label: '', message: '', source: 'alert' as const }, { kind: 'exit' as const, side: 'long' as const, exitType: 'close' as const, tp: [], barTime: bars[31].time, barIndex: 31, label: '', message: '', source: 'alert' as const }];
  const bt = runBacktest({ scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1h', bars, events, cfg: c, exitMode: 'both', contractValue: 1, tickSize: 0.01, spreadPct: 0.02 });
  assert.equal(bt.trades.length, 1); const t = bt.trades[0];
  const p = position(c, { entryPrice: 100.01, quoted: true, qty: t.qty, at: bars[30].time });
  fillExit(p, 99.99, p.qtyOpen, 'script_exit', bars[31].time, c, 'quoted');
  near(t.entryPrice, p.entryPrice); near(t.exitPrice!, p.exitPrice!); near(t.pnl, p.realizedPnl - p.fees);
  assert.equal(bt.costCoverage.funding, 'not-modelled');
  const input = { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1h', bars, events, cfg: c, exitMode: 'both' as const, contractValue: 1, tickSize: 0.01, spreadPct: 0.02 };
  const settlement = { at: bars[31].time, ratePct: 0.01, markPrice: 100 };
  const funded = runBacktest({ ...input, funding: [settlement, settlement] });
  assert.equal(funded.costCoverage.funding, 'provided');
  near(funded.trades[0].pnl, t.pnl - t.qty * 100 * 0.01 / 100);
  assert.equal(funded.trades[0].fills.filter(f => f.reason === 'funding').length, 1);
  const disabled = runBacktest({ ...input, cfg: { ...c, fundingCharges: false }, funding: [settlement] });
  near(disabled.trades[0].pnl, t.pnl);
  assert.throws(() => runBacktest({ ...input, funding: [{ ...settlement, markPrice: NaN }] }), /invalid historical funding/);

});

test('promotions respect enrollment time, partial-close timing and liquidation exclusion', () => {
  const c = cfg(); c.scalperOffer = { ...c.scalperOffer!, enabled: true, joinedAt: 2_000_000 };
  const before = position(c); assert.equal(closingFeeWaived(before, 2_100_000, 'close', c), false);
  const after = position(c, { at: 2_000_000 });
  assert.equal(closingFeeWaived(after, 2_000_000 + 20 * 60000, 'close', c), true);
  assert.equal(closingFeeWaived(after, 2_000_000 + 40 * 60000, 'close', c), false);
  assert.equal(closingFeeWaived(after, 2_100_000, 'liquidation', c), false);
});

test('a persisted funding settlement cannot be charged again after reload', () => {
  const p = position(); assert.ok(applyFunding(p, 0.01, 100, 2_000_000));
  const again = JSON.parse(JSON.stringify(p)); const pnl = again.realizedPnl;
  assert.equal(applyFunding(again, 0.01, 100, 2_000_000), null); near(again.realizedPnl, pnl);
  assert.ok(applyFunding(again, 0.01, 100, 3_000_000));
});

test('invalid quote costs and enrollment dates are rejected', () => {
  const c = structuredClone(DEFAULT_CONFIG); c.paper.quotedSlippageBps = -1;
  assert.ok(validateConfig(c).some(s => s.includes('quotedSlippageBps')));
  c.paper.quotedSlippageBps = 0; c.paper.scalperOffer!.joinedAt = NaN;
  assert.ok(validateConfig(c).some(s => s.includes('joinedAt')));
});

test('incubator ATR prefilter uses the same maker budget without counting the book fee twice', () => {
  const c = cfg();
  near(atrNeededPct(0.138, '15m', c)!, 0.138 * 6 / 1.5);
  near(atrNeededPct(0.138, '15m', c, { maker: true })!, (0.0826 + 0.01) * 6 / 1.5);
});
