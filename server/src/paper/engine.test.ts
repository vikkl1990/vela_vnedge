import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from './engine.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, latencyMs: 0 });
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

test('isolated margin cannot be reused and is released pro-rata after TP, across restart', t => {
  const { engine, db, cfg } = setup(t);
  Object.assign(cfg.paper, { sizingMode: 'quality', minLeverage: 5, maxLeverage: 10, maxStopLossPct: 0 }); // cap off: this test is about margin reuse, not stop sizing
  const open = (e: PaperEngine, id: string) => e.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 110, 115], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: id, scannerName: id, symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' });
  const p = open(engine, 's').position!;
  assert.equal(p.marginLeverage, 5);
  assert.equal(p.leverage, 5);
  assert.equal(open(engine, 's2').action, 'rejected');
  engine.setMark('BTCUSD', 104);
  assert.equal(open(engine, 's2').action, 'rejected', 'unrealized gains cannot fund isolated margin');
  const resumed = new PaperEngine(db, () => cfg);
  assert.equal(resumed.openPositions()[0].marginLeverage, 5);
  assert.equal(open(resumed, 's2').action, 'rejected');
  resumed.onScriptExit('s', 'BTCUSD', '1m', 'tp1', 105, 60_020, 'both');
  assert.equal(open(resumed, 's2').action, 'opened');
  const reserved = resumed.openPositions().reduce((sum, p) => sum + p.qtyOpen * p.entryPrice * p.contractValue / p.marginLeverage!, 0);
  assert.ok(reserved <= resumed.initialEquity + resumed.realizedPnl());
});

test('stale signals are rejected (audit P1: entries minutes/hours after bar close)', async () => {
  const { PaperEngine } = await import('./engine.ts');
  const barTime = Date.UTC(2026, 8, 20, 18, 0, 0);       // 15m bar closing at 18:15
  const close = barTime + 15 * 60_000;
  assert.equal(PaperEngine.signalAgeSec({ barTime }, '15m', close + 20_000), 20);
  assert.equal(PaperEngine.signalAgeSec({ barTime }, '15m', close + 11_335_696 / 1000 * 1000), 11335.696);
  assert.equal(PaperEngine.signalAgeSec({ barTime }, '15m', close - 5_000), -5);
  assert.equal(PaperEngine.signalAgeSec({ barTime: 0 }, '15m', close), 0); // unknown bar → no age gate
});

// ---- execution/latency audit fixes ----

function tapeSetup(t: { after: (fn: () => void) => void }, over: Record<string, unknown> = {}) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'tape', latencyMs: 0, maxStopLossPct: 0, maxSignalAgeSec: 0, useSpread: false, ...over });
  const engine = new PaperEngine(db, () => cfg);
  const queue = (at = 1_000) => engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 110, 115], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both' });
  return { db, cfg, engine, queue };
}

test('audit 1: a risk halt after queueing cancels the pending entry instead of filling it', t => {
  const { engine, queue } = tapeSetup(t);
  let halted = false;
  engine.risk = { gate: () => (halted ? { reject: 'manual halt', leverageMult: 1 } : { leverageMult: 1 }), exposureCheck: () => null };
  assert.equal(queue().action, 'pending');
  halted = true;
  engine.onTrade('BTCUSD', 100, 1, 2_000, 2_000);
  assert.equal(engine.openPositions().length, 0, 'a halt between queue and fill must stop the entry');
  assert.equal(engine.pendingEntries().length, 0);
});

test('audit 1: the exposure cap is re-applied at fill time', t => {
  const { engine, queue } = tapeSetup(t);
  let capped = false;
  engine.risk = { gate: () => ({ leverageMult: 1 }), exposureCheck: () => (capped ? 'correlated exposure' : null) };
  assert.equal(queue().action, 'pending');
  capped = true;
  engine.onTrade('BTCUSD', 100, 1, 2_000, 2_000);
  assert.equal(engine.openPositions().length, 0);
});

test('audit 2: requireQuote refuses an entry that has no fresh top of book', t => {
  const { engine, cfg } = tapeSetup(t, { fillSource: 'candles', useSpread: true, requireQuote: true, quoteMaxAgeMs: 10_000 });
  engine.quotes = { executable: () => null };
  const r = engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 1_000, signalId: null, exitMode: 'both' });
  assert.equal(r.action, 'rejected');
  assert.match(r.reason ?? '', /unpriceable/);
  assert.equal(engine.priceSource.rejectedNoQuote, 1);
  cfg.paper.requireQuote = false;
  const r2 = engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's2', scannerName: 's2', symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 1_000, signalId: null, exitMode: 'both' });
  assert.equal(r2.action, 'opened', 'with the flag off the slippage model still prices the fill');
  assert.equal(engine.priceSource.slippage, 1);
});

test('audit 3: a historical candle never fills a pending entry and never moves the mark', t => {
  const { engine, queue } = tapeSetup(t);
  assert.equal(queue(600_000).action, 'pending');
  engine.setMark('BTCUSD', 100);
  engine.onBar('BTCUSD', { time: 60_000, high: 90, low: 80, close: 85 }, 600_100, { historical: true });
  assert.equal(engine.openPositions().length, 0, 'an old candle cannot open a position');
  assert.equal(engine.pendingEntries().length, 1, 'and it does not consume the pending entry either');
  assert.equal(engine.mark('BTCUSD'), 100, 'the live mark is not rewound to an old close');
});

test('audit 3: a historical candle exits an open position stamped at the bar, not at receipt', t => {
  const { engine, cfg } = tapeSetup(t, { fillSource: 'candles' });
  const p = engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 110, 115], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_000, signalId: null, exitMode: 'both' }).position!;
  const barTime = 120_000;
  engine.onBar('BTCUSD', { time: barTime, high: 101, low: 94, close: 99 }, 900_000, { historical: true });
  assert.equal(p.exitReason, 'sl');
  assert.equal(p.exitAt, barTime + 60_000, 'the exit carries the bar close, not the moment we received it');
  assert.ok(cfg.paper.fillSource === 'candles');
});

test('audit 5: a print past the expiry deadline cancels instead of filling', t => {
  const { engine, queue } = tapeSetup(t);
  assert.equal(queue(1_000).action, 'pending');
  engine.onTrade('BTCUSD', 100, 1, 2_000, 1_000 + 61_000);
  assert.equal(engine.openPositions().length, 0, 'expiry is enforced in the fill path, not only by housekeeping');
  assert.equal(engine.pendingEntries().length, 0);
});

test('audit 2b: a quoted entry pays the spread once, not the spread plus assumed slippage', t => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'candles', latencyMs: 0, maxStopLossPct: 0, maxSignalAgeSec: 0, slippageBps: 100, depthUsdPerBp: 0, useSpread: true, quoteMaxAgeMs: 10_000, requireQuote: false });
  const engine = new PaperEngine(db, () => cfg);
  const enter = (id: string) => engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [105, 110, 115], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: id, scannerName: id, symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at: 1_000, signalId: null, exitMode: 'both' }).position!;
  engine.quotes = { executable: (_s, side) => (side === 'buy' ? 100.5 : 99.5) };
  assert.equal(enter('quoted').entryPrice, 100.5, 'the ask is the fill, with no extra 100 bps on top');
  engine.quotes = { executable: () => null };
  assert.equal(enter('unquoted').entryPrice, 101, 'without a quote the slippage model still stands in for the spread');
});

test('the trailing peak survives a restart, so the trail keeps advancing', t => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0, makerFeeRatePct: 0, liquidation: false, fillSource: 'candles', latencyMs: 0,
    maxStopLossPct: 0, maxSignalAgeSec: 0, useSpread: false, breakEvenAfterTp1: false, tpSplit: [0, 0, 1],
    trailAfterR: 1, trailDistanceR: 0, trailGiveBackPct: 25 });
  const engine = new PaperEngine(db, () => cfg);
  const p = engine.onEntry({ kind: 'entry', side: 'long', price: 100, sl: 95, tp: [200], label: 'e', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '1m', market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at: 60_000, signalId: null, exitMode: 'both' }).position!;
  engine.onBar('BTCUSD', { time: 120_000, high: 120, low: 99, close: 118 }, 180_000);   // peak 4R → stop 3R = 115
  assert.equal(p.peakR, 4);
  assert.equal(p.sl, 115);

  const resumed = new PaperEngine(db, () => cfg);
  const r = resumed.openPositions()[0];
  assert.equal(r.peakR, 4, 'the peak is restored, not reset to zero');
  resumed.onBar('BTCUSD', { time: 180_000, high: 124, low: 116, close: 123 }, 240_000); // peak 4.8R → stop 3.6R = 118
  assert.ok(Math.abs(r.sl! - 118) < 1e-9, `trail advanced to ${r.sl}, expected 118`);
});

test('the engine owns one equity peak: drawdown now, the worst drawdown, and a reset starts both again', t => {
  const { db, cfg } = setup(t);
  cfg.paper.initialEquity = 1000;
  // a path 1000 → 1100 → 990 recorded before this process started is rebuilt on construction
  db.run('DELETE FROM kv WHERE k IN (?, ?)', 'paper.peakEquity', 'paper.maxDrawdownPct');
  db.run('INSERT INTO equity(at, scanner_id, equity, realized, unrealized) VALUES (1,NULL,1000,0,0),(2,NULL,1100,100,0),(3,NULL,990,-10,0)');
  const resumed = new PaperEngine(db, () => cfg);
  assert.equal(resumed.peakEquity(), 1100);
  assert.ok(Math.abs(resumed.maxDrawdownPct() - 10) < 1e-9, `worst ${resumed.maxDrawdownPct()}`);
  const s = resumed.stats();
  assert.equal(s.peakEquity, 1100);
  assert.ok(Math.abs(s.equity - (s.initialEquity + s.closedPnl + s.openPnl)) < 1e-9, 'equity = initial + closed + open');
  resumed.reset();
  assert.equal(resumed.peakEquity(), cfg.paper.initialEquity);
  assert.equal(resumed.maxDrawdownPct(), 0);
});

test('decision 77: a reversal keeps the position unless the replacement passes admission', t => {
  const { engine, open, cfg } = setup(t);
  Object.assign(cfg.paper, { allowReversal: true, reversalMinR: 0 });
  engine.onBar('BTCUSD', { time: 60_000, high: 110, low: 90, close: 100 }, 60_000);
  const p = open('long');
  assert.equal(p.status, 'open');
  // an opposite signal whose stop is on the wrong side cannot be admitted: the long stays, the signal says why
  const bad = engine.onEntry({ kind: 'entry', side: 'short', price: 100, sl: 95, tp: [], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_020, signalId: null, exitMode: 'both' });
  assert.equal(bad.action, 'rejected');
  assert.match(bad.reason ?? '', /^reversal refused, position kept: /);
  assert.equal(p.status, 'open', 'the existing position was not closed for a replacement that could not be placed');
  assert.equal(engine.openPositions().length, 1);
  // an admissible opposite signal closes it and opens the other way in one decision
  const good = engine.onEntry({ kind: 'entry', side: 'short', price: 100, sl: 105, tp: [95, 90, 85], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 }, { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 100, at: 60_030, signalId: null, exitMode: 'both' });
  assert.equal(good.action, 'reversed');
  assert.equal(p.status, 'closed'); assert.equal(p.exitReason, 'reversal');
  assert.equal(good.closed?.id, p.id);
  assert.equal(engine.openPositions()[0]?.side, 'short');
});

function otherEntry(engine: PaperEngine, at = 60_020) {
  return engine.onEntry({ kind: 'entry', side: 'long', price: 10, sl: 9, tp: [11, 12, 13], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 'other', scannerName: 'other', symbol: 'ETHUSD', tf: '15m', market: { tickSize: 0.01, contractValue: 1 }, refPrice: 10, at, signalId: null, exitMode: 'both' });
}

test('fill provenance: a rejected entry cannot contaminate another symbol stop', t => {
  const { engine, db, open } = setup(t);
  const p = open();
  engine.risk = { gate: () => ({ reject: 'test halt', leverageMult: 1 }), exposureCheck: () => null };
  assert.equal(otherEntry(engine).action, 'rejected');
  engine.onBar('BTCUSD', { time: 120_000, high: 100, low: 94, close: 94 }, 120_010);
  const exit = db.get<any>('SELECT * FROM orders WHERE position_id=? AND reason=?', p.id, 'sl');
  assert.ok(exit);
  assert.equal(exit.ref_price, null);
  assert.equal(exit.price_source, null);
  const entry = db.get<any>('SELECT * FROM orders WHERE position_id=? AND reason=?', p.id, 'entry');
  assert.equal(entry.ref_price, 100);
  assert.equal(entry.price_source, 'slippage');
});

test('fill provenance: funding has no execution quote or rejected-entry context', t => {
  const { engine, db, open, cfg } = setup(t);
  cfg.paper.fundingCharges = true;
  const p = open();
  engine.quotes = { executable: () => null, markState: () => ({ bestBid: 99, bestAsk: 101, at: 60_030, quoteAt: 60_030 }) };
  engine.risk = { gate: () => ({ reject: 'test halt', leverageMult: 1 }), exposureCheck: () => null };
  // Let this reach admission after pricing rather than the missing-quote check.
  cfg.paper.requireQuote = false;
  assert.equal(otherEntry(engine).action, 'rejected');
  assert.equal(engine.chargeFunding('BTCUSD', 0.01, 60_040), 1);
  const row = db.get<any>('SELECT * FROM orders WHERE position_id=? AND reason=?', p.id, 'funding');
  for (const key of ['ref_price', 'price_source', 'bid', 'ask', 'quote_at']) assert.equal(row[key], null, key);
});

test('fill provenance: pending tape entry uses its fill-time reference after an unrelated rejection', t => {
  const { engine, db, queue } = tapeSetup(t);
  assert.equal(queue().action, 'pending');
  engine.risk = { gate: () => ({ reject: 'test halt', leverageMult: 1 }), exposureCheck: () => null };
  assert.equal(otherEntry(engine, 1_100).action, 'rejected');
  engine.risk = null;
  engine.onTrade('BTCUSD', 101, 1, 2_000, 2_000);
  const row = db.get<any>("SELECT * FROM orders WHERE symbol='BTCUSD' AND reason='entry'");
  assert.ok(row);
  assert.equal(row.ref_price, 101);
  assert.equal(row.price_source, 'slippage');
});

test('fill provenance: reversal close and replacement entry both retain their provenance', t => {
  const { engine, db, open, cfg } = setup(t);
  Object.assign(cfg.paper, { allowReversal: true, reversalMinR: 0, useSpread: false });
  const p = open();
  engine.setMark('BTCUSD', 102);
  const result = engine.onEntry({ kind: 'entry', side: 'short', price: 101, sl: 106, tp: [96, 91, 86], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
    { scannerId: 's', scannerName: 's', symbol: 'BTCUSD', tf: '15m', market: { tickSize: 0.25, contractValue: 1 }, refPrice: 102, at: 60_030, signalId: null, exitMode: 'both' });
  assert.equal(result.action, 'reversed');
  const exit = db.get<any>("SELECT * FROM orders WHERE position_id=? AND reason='reversal'", p.id);
  const entry = db.get<any>("SELECT * FROM orders WHERE position_id=? AND reason='entry'", result.position!.id);
  assert.equal(exit.ref_price, 101);
  assert.equal(exit.price_source, 'slippage');
  assert.equal(entry.ref_price, 101);
  assert.equal(entry.price_source, 'slippage');
});

test('fill provenance: delayed candle entry records its execution quote reference', t => {
  const { engine, db, cfg } = setup(t);
  Object.assign(cfg.paper, { latencyMs: 100, useSpread: true, requireQuote: true });
  engine.quotes = { executable: () => 10.1, markState: () => ({ bestBid: 10, bestAsk: 10.1, at: 60_200, quoteAt: 60_200 }) };
  assert.equal(otherEntry(engine).action, 'pending');
  engine.onBar('ETHUSD', { time: 60_000, high: 10.2, low: 10, close: 10.05 }, 60_200);
  const row = db.get<any>("SELECT * FROM orders WHERE symbol='ETHUSD' AND reason='entry'");
  assert.ok(row);
  assert.equal(row.ref_price, 10.05);
  assert.equal(row.price_source, 'quote');
  assert.equal(row.ask, 10.1);
});

test('fill provenance: adopted exchange exit retains exchange source without a foreign reference', t => {
  const { engine, db, open } = setup(t);
  const p = open();
  engine.risk = { gate: () => ({ reject: 'test halt', leverageMult: 1 }), exposureCheck: () => null };
  assert.equal(otherEntry(engine).action, 'rejected');
  engine.adoptExitFill(p.id, { price: 96, qty: p.qtyOpen, fee: 0.1, reason: 'sl', at: 60_040 });
  const row = db.get<any>("SELECT * FROM orders WHERE position_id=? AND reason='sl'", p.id);
  assert.equal(row.ref_price, null);
  assert.equal(row.price_source, 'exchange');
});
