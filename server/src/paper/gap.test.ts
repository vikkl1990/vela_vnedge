import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { Db } from '../db.ts';
import { PaperEngine } from './engine.ts';
import { applyBar, applyLiveBar, openPosition, type PriceBar } from './logic.ts';
import { runBacktest } from './backtest.ts';

const cfg = { ...DEFAULT_CONFIG.paper, slippageBps: 2, feeRatePct: 0.05, makerFeeRatePct: 0.02, feeTaxPct: 18,
  liquidation: false, trailAfterR: 0, floorAtR: 0, staleBars: 0, depthUsdPerBp: 0,
  scalperOffer: { ...DEFAULT_CONFIG.paper.scalperOffer!, enabled: false } };
function position(side: 'long' | 'short') {
  return openPosition({ id: 1, scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', side,
    qty: 10, contractValue: 1, entryPrice: 100, at: 60_010, sl: side === 'long' ? 95 : 105,
    tp: [side === 'long' ? 110 : 90], riskAmount: 50, levelsSource: 'script', signalId: null, cfg, bt: false });
}
const gap = (side: 'long' | 'short'): PriceBar => side === 'long'
  ? { time: 120_000, open: 94, high: 94.5, low: 93, close: 94 }
  : { time: 120_000, open: 106, high: 107, low: 105.5, close: 106 };

for (const side of ['long', 'short'] as const) {
  test(`held ${side} stop fills at the adverse opening gap plus costs`, () => {
    const p = position(side), bar = gap(side);
    const [f] = applyBar(p, bar, cfg);
    const expected = bar.open! * (side === 'long' ? 0.9998 : 1.0002);
    assert.equal(f.price, expected);
    assert.equal(f.reason, 'sl');
    assert.ok(Math.abs(f.fee - expected * 10 * 0.0005 * 1.18) < 1e-9);
    assert.equal(p.qtyOpen, 0);
  });

  test(`known ${side} opening stop precedes a later target even in target-first research`, () => {
    const p = position(side);
    const bar = { ...gap(side), ...(side === 'long' ? { high: 112, close: 111 } : { low: 88, close: 89 }) };
    const fills = applyBar(p, bar, { ...cfg, barOrder: 'target-first' });
    assert.deepEqual(fills.map(f => f.reason), ['sl']);
    assert.equal(fills[0].price, bar.open! * (side === 'long' ? 0.9998 : 1.0002));
  });

  test(`live ${side} gap exit survives restart and duplicate delivery in both books`, t => {
    for (const book of [0, 2]) {
      const db = new Db(':memory:'); t.after(() => db.db.close());
      const c = structuredClone(DEFAULT_CONFIG);
      Object.assign(c.paper, cfg, { latencyMs: 0, minRiskFeeRatio: 0, useSpread: false });
      const engine = new PaperEngine(db, () => c, { book });
      const result = engine.onEntry({ kind: 'entry', side, price: 100, sl: side === 'long' ? 95 : 105,
        tp: [side === 'long' ? 110 : 90], label: 'entry', message: '', source: 'alert', barTime: 0, barIndex: 0 },
      { scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', market: { tickSize: 0.1, contractValue: 1 },
        refPrice: 100, at: 60_010, signalId: null, exitMode: 'both' });
      assert.equal(result.action, 'opened');
      engine.onBar('X', { time: 60_000, open: 100, high: 101, low: 99, close: 100 }, 60_020);
      const resumed = new PaperEngine(db, () => c, { book });
      resumed.onBar('X', gap(side), 120_020);
      const after = new PaperEngine(db, () => c, { book });
      after.onBar('X', gap(side), 120_030);
      assert.equal(after.openPositions().length, 0);
      const [closed] = after.trades();
      assert.equal(closed.exitReason, 'sl');
      assert.equal(closed.exitPrice, gap(side).open! * (side === 'long' ? 0.9998 : 1.0002));
      assert.equal(closed.fills.filter(f => f.reason === 'sl').length, 1);
      assert.equal(db.get<{ price_source: string }>('SELECT price_source FROM orders WHERE position_id=? AND reason=?', closed.id, 'sl')?.price_source, 'candle-model');
    }
  });
}

test('live raised stop never reuses the minute open, including a restored baseline', () => {
  const p = position('long'); p.tp = [105, 110]; p.tpHit = [false, false]; p.legs = [5, 5];
  const first = { time: 120_000, open: 99, high: 106, low: 99, close: 106 };
  assert.equal(applyLiveBar(p, first, cfg, 120_010)[0].reason, 'tp1');
  assert.equal(p.sl, p.entryPrice);
  const restored = JSON.parse(JSON.stringify(p));
  assert.deepEqual(applyLiveBar(restored, first, cfg, 120_020), []);
  assert.equal(applyLiveBar(restored, { ...first, close: 100 }, cfg, 120_030)[0].price, p.entryPrice * 0.9998);
});

test('an entry-minute open from before the entry cannot price its subsequent stop', () => {
  const p = position('long');
  const [f] = applyLiveBar(p, { time: 60_000, open: 90, high: 101, low: 89, close: 94 }, cfg, 60_030);
  assert.equal(f.price, 95 * 0.9998);
});

test('missing or invalid opens preserve intrabar stop pricing; favourable opens do not improve it', () => {
  for (const open of [undefined, NaN, Infinity, 0, -1, 100]) {
    const [f] = applyBar(position('long'), { time: 120_000, open, high: 101, low: 94, close: 96 }, cfg);
    assert.equal(f.price, 95 * 0.9998);
  }
});

test('ordinary backtests carry minute and coarse opens through to held-position stops', () => {
  const M = 900_000;
  const bars = Array.from({ length: 23 }, (_, i) => ({ time: i * M, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }));
  bars[22] = { ...bars[22], ...gap('long'), time: 22 * M, open: 94 };
  const events = [{ kind: 'entry' as const, side: 'long' as const, price: 100, sl: 95, tp: [110],
    barTime: 20 * M, barIndex: 20, source: 'alert' as const, label: 'entry', message: '' }];
  const input = { scannerId: 's', scannerName: 's', symbol: 'X', tf: '15m', bars, events,
    cfg: { ...cfg, minRiskFeeRatio: 0 }, exitMode: 'levels' as const, contractValue: 1, tickSize: 0.1 };
  for (const subBars of [undefined, [bars[21], bars[22]]]) {
    const r = runBacktest({ ...input, subBars });
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].exitPrice, 94 * 0.9998);
  }
});
