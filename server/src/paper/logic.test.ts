import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { applyBar, applyScriptExit, computeStats, openPosition, resolveLevels, sizeContracts, splitLegs, leverageForScore, liquidationPrice, roundTick } from './logic.ts';

const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false };

test('resolveLevels uses script levels, else ATR fallback', () => {
  const r = resolveLevels({ side: 'long', price: 100, sl: 95, tp: [110, 120, 130] }, cfg, 0.5);
  assert.deepEqual(r, { sl: 95, tp: [110, 120, 130], source: 'script' });
  const f = resolveLevels({ side: 'short', price: 100, atr: 2 }, cfg, 0.5) as any;
  assert.equal(f.source, 'atr-fallback'); assert.equal(f.sl, 103); assert.deepEqual(f.tp, [97, 94, 91]);
  const bad = resolveLevels({ side: 'long', price: 100, sl: 105 }, cfg, 0.5) as any;
  assert.ok('error' in bad);
  const mixed = resolveLevels({ side: 'long', price: 100, sl: 98 }, cfg, 0.5) as any;
  assert.equal(mixed.source, 'mixed'); assert.deepEqual(mixed.tp, [102, 104, 106]);
});

test('sizing respects risk and leverage', () => {
  const s = sizeContracts(100, 95, { equity: 100_000, contractValue: 0.001, tickSize: 0.5, cfg });
  assert.equal(s.qty, 200_000); // 1000 risk / (5 * 0.001) = 200000 → but leverage caps: 100000*10/(100*0.001)=10,000,000 so ok
  const capped = sizeContracts(100, 99.999, { equity: 1000, contractValue: 0.001, tickSize: 0.5, cfg: { ...cfg, maxLeverage: 1 } });
  assert.equal(capped.qty, 10_000);
  assert.deepEqual(splitLegs(10, [0.4, 0.3, 0.3], 3), [4, 3, 3]);
  assert.deepEqual(splitLegs(1, [0.4, 0.3, 0.3], 3), [0, 0, 1]);
  assert.deepEqual(splitLegs(7, [0.4, 0.3, 0.3], 1), [7]);
});

function pos(side: 'long' | 'short' = 'long') {
  return openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side, qty: 10, contractValue: 0.001, entryPrice: 100, at: 0, sl: side === 'long' ? 95 : 105, tp: side === 'long' ? [105, 110, 115] : [95, 90, 85], riskAmount: 0.05, levelsSource: 'script', signalId: null, cfg, bt: true });
}

test('SL before TP on ambiguous bar; TP legs and break-even', () => {
  const p = pos();
  const f = applyBar(p, { time: 1, high: 106, low: 94, close: 100 }, cfg);
  assert.equal(f.length, 1); assert.equal(f[0].reason, 'sl'); assert.equal(p.status, 'closed');
  const q = pos();
  const f1 = applyBar(q, { time: 1, high: 105, low: 99, close: 104 }, cfg);
  assert.equal(f1[0].reason, 'tp1'); assert.equal(f1[0].qty, 4); assert.equal(q.qtyOpen, 6); assert.equal(q.sl, 100); assert.equal(q.breakEven, true);
  const f2 = applyBar(q, { time: 2, high: 104, low: 100, close: 101 }, cfg);
  assert.equal(f2[0].reason, 'be'); assert.equal(q.status, 'closed');
  assert.ok(Math.abs(q.realizedPnl - 4 * 5 * 0.001) < 1e-9);
  const r = pos('short');
  const f3 = applyBar(r, { time: 1, high: 101, low: 84, close: 85 }, cfg);
  assert.deepEqual(f3.map(x => x.reason), ['tp1', 'tp2', 'tp3']); assert.equal(r.status, 'closed'); assert.equal(r.qtyOpen, 0);
});

test('script exits honour exit mode', () => {
  const p = pos();
  assert.equal(applyScriptExit(p, 'sl', 96, 5, cfg, 'levels', 96).length, 0);
  const f = applyScriptExit(p, 'tp2', 111, 5, cfg, 'both', 111);
  assert.deepEqual(f.map(x => x.reason), ['tp1', 'tp2']); assert.equal(p.qtyOpen, 3);
  const g = applyScriptExit(p, 'flip', 112, 6, cfg, 'script', 112);
  assert.equal(g[0].reason, 'script_flip'); assert.equal(p.status, 'closed');
});

test('stats', () => {
  const a = pos(); applyBar(a, { time: 1, high: 120, low: 99, close: 115 }, cfg);
  const b = pos(); applyBar(b, { time: 1, high: 101, low: 90, close: 95 }, cfg);
  const s = computeStats([a, b], 1000);
  assert.equal(s.trades, 2); assert.equal(s.wins, 1); assert.equal(s.losses, 1);
  assert.ok(s.profitFactor! > 1);
});

test('quality sizing scales leverage with score and models liquidation', () => {
  const q = { ...cfg, sizingMode: 'quality' as const, minLeverage: 5, maxLeverage: 50, liquidation: true, maintenanceMarginPct: 0.5 };
  assert.equal(leverageForScore(undefined, q), 5); assert.equal(leverageForScore(50, q), 27.5); assert.equal(leverageForScore(100, q), 50);
  const s = sizeContracts(100, 98, { equity: 1000, contractValue: 0.001, tickSize: 0.5, cfg: q }, 0, 100);
  assert.equal(s.qty, 500_000); // 1000 × 50x = 50,000 notional / (100 × 0.001 per contract)
  assert.ok(Math.abs(s.leverage - 50) < 1e-9);
  const liq = liquidationPrice('long', 100, 50, q)!;
  assert.ok(Math.abs(liq - 98.5) < 1e-9); // 1/50 = 2% minus 0.5% maintenance
  const p = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 500, contractValue: 0.001, entryPrice: 100, at: 0, sl: 97, tp: [105], riskAmount: 1.5, levelsSource: 'script', signalId: null, cfg: q, bt: true, leverage: 50 });
  const f = applyBar(p, { time: 1, high: 100, low: 98, close: 99 }, q);
  assert.equal(f[0].reason, 'liquidation'); assert.equal(p.status, 'closed');
});


test('roundTick preserves fractional tick precision including scientific notation', () => {
  for (const [price, tick, expected] of [[100.25, 0.25, 100.25], [100.37, 0.25, 100.25], [100.38, 0.25, 100.5], [10.125, 0.125, 10.125], [2.5, 2.5, 2.5], [0.000000025, 2.5e-8, 2.5e-8], [100.5, 0.5, 100.5]]) {
    assert.equal(roundTick(price, tick), expected);
  }
});

test('isolated leverage is independent of account exposure and reserves margin plus entry fees', () => {
  const c = { ...cfg, liquidation: true, maxLeverage: 10, feeRatePct: 0.1, slippageBps: 10 };
  const s = sizeContracts(100, 95, { equity: 1000, availableMargin: 1000, contractValue: 1, tickSize: 0.01, cfg: c });
  assert.equal(s.marginLeverage, 10);
  assert.ok(s.leverage < 1);
  assert.ok(s.riskAmount <= 10);
  const p = openPosition({ ...pos(), contractValue: 1, entryPrice: 100, at: 0, qty: s.qty, sl: 95, tp: [110], riskAmount: s.riskAmount, cfg: c, leverage: s.leverage, marginLeverage: s.marginLeverage });
  assert.ok(p.liqPrice! > 90 && p.liqPrice! < 91);
  const fill = applyBar(p, { time: 1, high: 100, low: 94, close: 95 }, c)[0];
  assert.equal(fill.reason, 'sl');
  assert.ok(Math.abs(p.realizedPnl - p.fees + s.riskAmount) < 1e-9);
  const exhausted = sizeContracts(100, 95, { equity: 1000, availableMargin: 0, contractValue: 1, tickSize: 0.01, cfg: c });
  assert.equal(exhausted.qty, 0);
  const q = sizeContracts(100, 95, { equity: 1000, availableMargin: 100, contractValue: 1, tickSize: 0.01, cfg: { ...c, sizingMode: 'quality' } });
  assert.ok(q.qty * 100.1 * (1 / q.marginLeverage + 0.001) <= 100);
});

test('long and short stop risk budgets include both fees and slippage', () => {
  for (const side of ['long', 'short'] as const) {
    const c = { ...cfg, feeRatePct: 0.1, slippageBps: 20 };
    const sl = side === 'long' ? 95 : 105;
    const size = sizeContracts(100, sl, { equity: 10000, contractValue: 1, tickSize: 0.01, cfg: c });
    const p = openPosition({ ...pos(side), contractValue: 1, entryPrice: 100, qty: size.qty, at: 0, sl, tp: [], cfg: c, riskAmount: size.riskAmount });
    applyScriptExit(p, 'sl', sl, 1, c, 'both', sl);
    assert.ok(Math.abs(p.realizedPnl - p.fees + size.riskAmount) < 1e-8);
    assert.ok(size.riskAmount <= 100);
  }
});

test('liquidation handles both sides, unreachable prices and invalid initial margin', () => {
  const c = { ...cfg, liquidation: true, maintenanceMarginPct: 0.5 };
  assert.equal(liquidationPrice('long', 100, 0.5, c), null);
  assert.ok(Math.abs(liquidationPrice('short', 100, 50, c)! - 101.5) < 1e-9);
  assert.equal(sizeContracts(100, 95, { equity: 1000, contractValue: 1, tickSize: 0.1, cfg: { ...c, maxLeverage: 200 } }).qty, 0);
  for (const side of ['long', 'short'] as const) {
    const p = openPosition({ ...pos(side), entryPrice: 100, at: 0, sl: side === 'long' ? 90 : 110, cfg: c, leverage: 0.1, marginLeverage: 50 });
    const f = applyScriptExit(p, 'tp1', side === 'long' ? 98 : 102, 1, c, 'both', 100);
    assert.equal(f.length, 1);
    assert.equal(f[0].reason, 'liquidation');
    assert.equal(p.qtyOpen, 0, 'liquidation closes the entire remainder, not a TP allocation');
  }
});

test('liquidation loss including its exit fee is bounded by allocated margin', () => {
  const c = { ...cfg, liquidation: true, feeRatePct: 0.1, slippageBps: 1000 };
  for (const side of ['long', 'short'] as const) {
    const p = openPosition({ ...pos(side), entryPrice: 100, at: 0, sl: side === 'long' ? 1 : 1000, cfg: c, marginLeverage: 50 });
    const margin = p.entryPrice * p.qty * p.contractValue / 50;
    const f = applyBar(p, { time: 1, high: 1000, low: 1, close: 100 }, c)[0];
    assert.equal(f.reason, 'liquidation');
    assert.ok(-f.pnl + f.fee <= margin + 1e-9);
  }
});

test('rounded levels must remain positive and on the correct side of entry', () => {
  for (const request of [
    { side: 'long' as const, price: 100, sl: 99.99, tp: [110] },
    { side: 'short' as const, price: 100, sl: 100.01, tp: [90] },
    { side: 'long' as const, price: 100, sl: 95, tp: [100.01] },
    { side: 'long' as const, price: 1, atr: 10 },
    { side: 'short' as const, price: 1, sl: 2 },
  ]) assert.ok('error' in resolveLevels(request, cfg, 0.5));
});

test('zero-contract script TP legs do not move stop to break-even', () => {
  const p = pos(); p.qty = p.qtyOpen = 1; p.legs = [0, 0, 1];
  assert.equal(applyScriptExit(p, 'tp1', 105, 1, cfg, 'both', 105).length, 0);
  assert.equal(p.breakEven, false);
  assert.equal(p.sl, 95);
});

test('partial target P&L and maker fees reconcile exactly with closed-trade statistics', () => {
  const c = { ...cfg, feeRatePct: 0.1, makerFeeRatePct: 0.02 };
  const p = openPosition({ ...pos(), entryPrice: 100, at: 0, sl: 95, cfg: c });
  applyBar(p, { time: 1, high: 115, low: 100, close: 115 }, c);
  assert.ok(Math.abs(p.realizedPnl - 0.095) < 1e-12);
  assert.ok(Math.abs(p.fees - (0.001 + 0.000219)) < 1e-12);
  const stats = computeStats([p], 1000);
  assert.ok(Math.abs(stats.pnl - 0.093781) < 1e-12);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 0);
});

test('rounded target prices preserve script TP indices and allocations', () => {
  const lv = resolveLevels({ side: 'long', price: 100, sl: 95, tp: [105.1, 105.2, 110] }, cfg, 0.5);
  assert.ok(!('error' in lv));
  assert.deepEqual(lv.tp, [105, 105, 110]);
  const p = openPosition({ ...pos(), entryPrice: 100, at: 0, sl: lv.sl, tp: lv.tp, cfg });
  const fills = applyScriptExit(p, 'tp2', 105, 1, cfg, 'both', 105);
  assert.deepEqual(fills.map(f => f.qty), [4, 3]);
  assert.equal(p.qtyOpen, 3);
  assert.equal(p.tp[2], 110);
});

test('a candle closing past a newly raised BE stop closes the remainder after TP1', () => {
  for (const side of ['long', 'short'] as const) {
    const p = pos(side);
    const bar = side === 'long' ? { high: 106, low: 99, close: 99 } : { high: 101, low: 94, close: 101 };
    const fills = applyBar(p, { time: 1, ...bar }, cfg);
    assert.deepEqual(fills.map(f => f.reason), ['tp1', 'be']);
    assert.deepEqual(fills.map(f => f.qty), [4, 6]);
    assert.equal(p.qtyOpen, 0);
  }
});
