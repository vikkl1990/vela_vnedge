import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from './engine.ts';
import { bookPaperConfig } from './policy.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, {
    sizingMode: 'margin', marginPerTrade: 150, maxLeverage: 50,
    feeRatePct: 0.05, makerFeeRatePct: 0.02, feeTaxPct: 18,
    minRiskFeeRatio: 6, maxStopLossPct: 3, riskPerTradePct: 1,
    slippageBps: 0, latencyMs: 0, liquidation: false,
    fillSource: 'candles', useSpread: false, requireQuote: false,
    maxSignalAgeSec: 0, limitEntry: undefined,
  });
  const ref = () => ({ ...cfg, paper: bookPaperConfig(cfg, 'shadow') });
  const engine = new PaperEngine(db, ref, { book: 2 });
  const event = { kind: 'entry' as const, side: 'long' as const, price: 100,
    sl: 99, tp: [102, 104, 106], label: 'entry', message: '',
    source: 'alert' as const, barTime: 0, barIndex: 0 };
  const ctx = (symbol: string, maxLeverage = 50) => ({
    scannerId: 's', scannerName: 's', symbol, tf: '15m',
    market: { tickSize: 0.01, contractValue: 1, maxLeverage },
    refPrice: 100, atr: 1, at: Date.now(), signalId: null, exitMode: 'both' as const,
  });
  const crowd = () => {
    for (let i = 0; i < 26; i++) {
      const d = engine.onEntry(event, ctx(`OTHER${i}USD`));
      assert.equal(d.action, 'opened', d.reason);
    }
    assert.ok(engine.openPositions().reduce((sum, p) => sum + p.qtyOpen * p.entryPrice * p.contractValue, 0) > ref().paper.initialEquity * 20,
      'unrelated 50x markets collectively exceed a new 20x market ceiling');
  };
  return { db, cfg, ref, engine, event, ctx, crowd };
}

test('ordinary shadow cells keep their independent size when other markets exhaust the aggregate ceiling, including after restart', t => {
  const { db, ref, engine, event, ctx, crowd } = setup(t);
  const expected = engine.onEntry(event, ctx('BASEUSD', 20)).position!;
  crowd();
  for (const e of [engine, new PaperEngine(db, ref, { book: 2 })]) {
    const cell = ctx(e === engine ? 'NEXTUSD' : 'RESTARTUSD', 20);
    const d = e.onEntry(event, cell);
    assert.equal(d.action, 'opened', d.reason);
    assert.equal(d.position!.qty, expected.qty);
    assert.equal(d.position!.riskAmount, expected.riskAmount);
    assert.equal(e.onEntry(event, cell).action, 'ignored', 'cell independence must not duplicate a held trade');
  }
});

test('shadow cells do not reserve margin from the next cell reference purse', t => {
  const { engine, event, ctx, ref } = setup(t);
  const quantities: number[] = [];
  for (let i = 0; i < 4; i++) {
    const d = engine.onEntry(event, ctx(`LOWLEV${i}USD`, 2));
    assert.equal(d.action, 'opened', d.reason);
    quantities.push(d.position!.qty);
  }
  assert.ok(quantities.every(q => q === quantities[0]), 'no shrinking because another experiment used margin');
  const syntheticMargin = engine.openPositions().reduce((sum, p) => sum + p.qtyOpen * p.entryPrice / p.marginLeverage!, 0);
  assert.ok(syntheticMargin > ref().paper.initialEquity);
});

for (const maker of [false, true]) {
  test(`shadow ${maker ? 'resting maker' : 'deferred market'} fills cannot be starved by unrelated positions`, t => {
    const { db, cfg, ref, engine, event, ctx, crowd } = setup(t);
    const cell = ctx('TARGETUSD', 20);
    cfg.paper.fillSource = 'tape';
    if (maker) cfg.paper.limitEntry = { enabled: true, tfs: ['15m'], atr: 0, bars: 2, books: ['shadow'] };
    const d = engine.onEntry(event, cell);
    assert.equal(d.action, 'pending', d.reason);
    cfg.paper.fillSource = 'candles';
    cfg.paper.limitEntry = undefined;
    crowd();
    cfg.paper.fillSource = 'tape';
    // Resting makers must survive deployment; short latency orders are deliberately not recovered.
    const e = maker ? new PaperEngine(db, ref, { book: 2 }) : engine;
    e.onTrade(cell.symbol, maker ? 99.99 : 100, 1, cell.at + 10_000, cell.at + 10_000);
    const filled = e.openPositions().find(p => p.symbol === cell.symbol);
    assert.ok(filled, 'the fill must use its own purse, not the other cells\' exposure');
    assert.equal(filled.entryPrice, 100);
    assert.ok(filled.riskAmount <= ref().paper.initialEquity * 0.01);
    assert.equal(e.pendingEntries().length, 0);
  });
}

test('independent shadow sizing retains fee, lot and quote checks', t => {
  const { cfg, engine, event, ctx, crowd } = setup(t);
  crowd();
  assert.match(engine.onEntry({ ...event, sl: 99.99 }, ctx('TIGHTUSD')).reason!, /stop too tight for fees/);
  const large = ctx('LARGEUSD');
  large.market.contractValue = 1_000_000;
  assert.match(engine.onEntry(event, large).reason!, /max stop-loss cap/);
  cfg.paper.useSpread = true; cfg.paper.requireQuote = true;
  engine.quotes = { executable: () => null };
  assert.match(engine.onEntry(event, ctx('NOQUOTEUSD')).reason!, /unpriceable/);
});
