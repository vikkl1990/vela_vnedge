import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { applyBar, applyScriptExit, computeStats, openPosition, resolveLevels, sizeContracts, splitLegs, leverageForScore, liquidationPrice, roundTick, checkRiskVsFees } from './logic.ts';

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
  const q = { ...cfg, sizingMode: 'quality' as const, minLeverage: 5, maxLeverage: 50, liquidation: true, maintenanceMarginPct: 0.5, maxStopLossPct: 0 }; // stop cap tested separately
  assert.equal(leverageForScore(undefined, q), 5); assert.equal(leverageForScore(50, q), 27.5); assert.equal(leverageForScore(100, q), 50);
  const s = sizeContracts(100, 98, { equity: 1000, contractValue: 0.001, tickSize: 0.5, cfg: q }, 0, 100);
  assert.equal(s.qty, 500_000); // 1000 × 50x = 50,000 notional / (100 × 0.001 per contract) — uncapped
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

test('fee-aware entry filter rejects stops tighter than N× round-trip fees', () => {
  const c = { ...DEFAULT_CONFIG.paper, feeRatePct: 0.05, minRiskFeeRatio: 4 };
  assert.ok(checkRiskVsFees(100, 99.8, c)); // 0.2% stop vs 0.1% round trip → 2× < 4×
  assert.equal(checkRiskVsFees(100, 99.5, c), null); // 0.5% stop = 5×
  assert.equal(checkRiskVsFees(100, 99.8, { ...c, minRiskFeeRatio: 0 }), null);
});

test('max stop-loss cap bounds the loss in quality sizing (audit #94/#95 regression)', () => {
  const q = { ...cfg, sizingMode: 'quality' as const, minLeverage: 5, maxLeverage: 50, maxStopLossPct: 2, liquidation: false };
  // AKEUSD #95: 5x quality leverage, ATR-fallback stop ~11 % away, $892 account.
  // One contract alone loses ~$69 (7.7 % of the account), so the trade must be refused outright.
  const entry = 0.0606, sl = entry * 0.886;
  const akeusd = sizeContracts(entry, sl, { equity: 892, contractValue: 10_000, tickSize: 0.000001, cfg: q }, 0, 0);
  assert.equal(akeusd.qty, 0);
  assert.match(String(akeusd.reason), /max stop-loss cap/);
  // uncapped, the same trade really did risk over half the account (it lost $480 of $892)
  const uncapped = sizeContracts(entry, sl, { equity: 892, contractValue: 10_000, tickSize: 0.000001, cfg: { ...q, maxStopLossPct: 0 } }, 0, 0);
  assert.ok(Math.abs(entry - sl) * 10_000 * uncapped.qty > 892 * 0.4, 'uncapped sizing really was that dangerous');
  // a normal 2 % stop is sized DOWN to the cap rather than refused
  const sized = sizeContracts(100, 98, { equity: 1000, contractValue: 0.001, tickSize: 0.5, cfg: q }, 0, 100);
  assert.equal(sized.qty, 10_000);                       // 1000 × 2 % / (2 × 0.001) — not the 500,000 the leverage alone would buy
  assert.ok(Math.abs(100 - 98) * 0.001 * sized.qty <= 1000 * 0.02 + 1e-9);
  // risk mode is capped too
  const riskMode = sizeContracts(100, 90, { equity: 1000, contractValue: 0.001, tickSize: 0.5, cfg: { ...q, sizingMode: 'risk', riskPerTradePct: 10 } }, 0);
  assert.ok(Math.abs(100 - 90) * 0.001 * riskMode.qty <= 1000 * 0.02 + 1e-9, 'riskPerTradePct above the cap is clamped');
});

test('trailing stop follows the peak, never loosens, and cannot be hit by the bar that raised it', () => {
  const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false,
    breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 1, tpSplit: [0, 0, 1] as [number, number, number] };
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [130], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: true });
  assert.equal(pos.sl, 95, 'risk is 5, so 1R = 5');

  // a bar that reaches +2R must not also be stopped out by the stop that same bar raises
  const fills = applyBar(pos, { time: 1, high: 110, low: 99, close: 109 }, cfg);
  assert.equal(fills.length, 0);
  assert.equal(pos.sl, 105, 'stop trails 1R behind the +2R peak');
  assert.equal(pos.breakEven, true, 'a stop above entry counts as protected');

  // a weaker bar cannot pull the stop back down
  applyBar(pos, { time: 2, high: 106, low: 105.5, close: 106 }, cfg);
  assert.equal(pos.sl, 105, 'the trail never moves against the position');

  // and the stop does fire on a later bar
  const out = applyBar(pos, { time: 3, high: 106, low: 104, close: 104 }, cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 105);
  assert.equal(pos.status, 'closed');
});

test('trailing does nothing before the arming threshold, and is off by default', () => {
  const base = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, breakEvenAfterTp1: false };
  const make = (cfg: typeof base) => openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [130], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: true });
  const armed = { ...base, trailAfterR: 2, trailDistanceR: 1 };
  const p = make(armed);
  applyBar(p, { time: 1, high: 107, low: 99, close: 107 }, armed);   // +1.4R: below the 2R threshold
  assert.equal(p.sl, 95, 'the stop stays put until the trade has shown 2R');
  assert.equal(DEFAULT_CONFIG.paper.trailAfterR, 0, 'trailing ships disabled');
  const q = make(base);
  applyBar(q, { time: 1, high: 120, low: 99, close: 120 }, base);
  assert.equal(q.sl, 95, 'with trailing off the stop never moves');
});

test('a short trails downward', () => {
  const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false,
    breakEvenAfterTp1: false, trailAfterR: 1, trailDistanceR: 1, tpSplit: [0, 0, 1] as [number, number, number] };
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'short', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 105, tp: [70], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: true });
  applyBar(pos, { time: 1, high: 101, low: 90, close: 91 }, cfg);
  assert.equal(pos.sl, 95, 'stop trails 1R above the -2R low');
});

test('a profit floor banks a small gain without capping the runner', () => {
  const c = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false,
    breakEvenAfterTp1: false, floorAtR: 0.5, floorKeepR: 0.25, tpSplit: [0, 0, 1] as [number, number, number] };
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [200], riskAmount: 50, levelsSource: 'script', signalId: null, cfg: c, bt: true });
  applyBar(pos, { time: 60_000, high: 102, low: 99.5, close: 102 }, c);      // +0.4R: below the floor
  assert.equal(pos.sl, 95, 'the floor is not armed yet');
  applyBar(pos, { time: 120_000, high: 103, low: 101, close: 103 }, c);      // +0.6R: arms
  assert.equal(pos.sl, 101.25, 'stop moves to +0.25R and banks it');
  applyBar(pos, { time: 180_000, high: 130, low: 102, close: 130 }, c);      // +6R
  assert.equal(pos.sl, 101.25, 'the floor does not keep tightening, so the runner is not capped');
});

test('proportional give-back is tight when small and loose when running', () => {
  const c = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false,
    breakEvenAfterTp1: false, trailAfterR: 0.5, trailDistanceR: 0, trailGiveBackPct: 40, tpSplit: [0, 0, 1] as [number, number, number] };
  const pos = openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [200], riskAmount: 50, levelsSource: 'script', signalId: null, cfg: c, bt: true });
  applyBar(pos, { time: 60_000, high: 103, low: 99, close: 103 }, c);        // peak 0.6R → keep 60% = 0.36R
  assert.ok(Math.abs(pos.sl! - 101.8) < 1e-9, `kept 0.36R, got ${pos.sl}`);
  applyBar(pos, { time: 120_000, high: 125, low: 102, close: 125 }, c);      // peak 5R → keep 3R
  assert.ok(Math.abs(pos.sl! - 115) < 1e-9, `kept 3R, got ${pos.sl}`);
});

test('the time stop closes a trade that never got going, and spares one that did', () => {
  const c = { ...DEFAULT_CONFIG.paper, slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false,
    breakEvenAfterTp1: false, staleBars: 4, staleMinR: 1, tpSplit: [0, 0, 1] as [number, number, number] };
  const make = () => openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 10,
    contractValue: 1, entryPrice: 100, at: 0, sl: 95, tp: [200], riskAmount: 50, levelsSource: 'script', signalId: null, cfg: c, bt: true });
  const dull = make();
  applyBar(dull, { time: 3 * 900_000, high: 101, low: 99.5, close: 100.5 }, c);
  assert.equal(dull.status, 'open', 'not yet old enough');
  const out = applyBar(dull, { time: 4 * 900_000, high: 101, low: 99.5, close: 100.5 }, c);
  assert.equal(out.at(-1)?.reason, 'stale');
  assert.equal(dull.status, 'closed');

  const runner = make();
  applyBar(runner, { time: 900_000, high: 106, low: 99.5, close: 106 }, c);  // peak 1.2R
  applyBar(runner, { time: 5 * 900_000, high: 106, low: 103, close: 104 }, c);
  assert.equal(runner.status, 'open', 'a trade that reached the threshold is left alone');
  assert.equal(DEFAULT_CONFIG.paper.staleBars, 0, 'the time stop ships disabled');
});
