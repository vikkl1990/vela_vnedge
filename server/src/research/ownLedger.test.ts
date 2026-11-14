import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseOwnLedger, gradeOwnLedger, OWN_LEDGER_COST_BPS, tStat, type OwnBar, type OwnCell, type OwnTrade } from './ownLedger.ts';

/** A flat market: every bar opens, closes at 100 with a 1-point range, so drift is zero and nothing is priced off-bar. */
const flat = (n: number): OwnBar[] => Array.from({ length: n }, (_, i) => [i * 3_600_000, 100, 100.5, 99.5, 100]);
const cell = (bars: OwnBar[], trades: OwnTrade[], extra: Partial<OwnCell> = {}): OwnCell => ({ symbol: 'BTCUSD', tf: '1h', bars, trades, ...extra });

test('cost is two taker fees with tax plus two slippages', () => {
  assert.ok(Math.abs(OWN_LEDGER_COST_BPS - 15.8) < 1e-9);
});

test('a long that gains 2% nets gross minus costs, a short that gains the same nets the same', () => {
  const bars = flat(10); bars[5] = [bars[5][0], 100, 102.5, 99.5, 102]; bars[6] = [bars[6][0], 102, 102.5, 101.5, 102];
  const s = summariseOwnLedger([cell(bars, [
    { size: 1, entryPrice: 100, exitPrice: 102, entryIdx: 2, exitIdx: 5 },
    { size: -1, entryPrice: 102, exitPrice: 100, entryIdx: 6, exitIdx: 8 },
  ])]);
  assert.equal(s.trades, 2);
  assert.ok(s.closedNet > 0);
  assert.ok(Math.abs(s.long - (200 - OWN_LEDGER_COST_BPS)) < 1e-6);
  assert.ok(Math.abs(s.short - ((102 - 100) / 102 * 1e4 - OWN_LEDGER_COST_BPS)) < 1e-6);
});

test('an open loser is marked to market and turns a closed-trade winner negative', () => {
  const bars = flat(20); for (let i = 10; i < 20; i++) bars[i] = [bars[i][0], 90, 91, 89, 90];
  const trades: OwnTrade[] = [
    { size: 1, entryPrice: 100, exitPrice: 101, entryIdx: 1, exitIdx: 3 },          // closed winner (+100 bps gross)
    { size: 1, entryPrice: 100, exitPrice: null, entryIdx: 5, exitIdx: null },      // never closed, now 10% under water
  ];
  const s = summariseOwnLedger([cell(bars, trades)]);
  assert.ok(s.closedNet > 0);
  assert.equal(s.open, 1);
  assert.ok(s.net < 0, 'the open loser must count');
  assert.ok(s.openLoss < -900);
});

test('a one-bar delay is applied to both ends, and process_orders_on_close needs two bars of lag', () => {
  // price steps from 100 to 101 at bar 5; the script holds from bar 3 to bar 4
  const bars = flat(12); for (let i = 5; i < 12; i++) bars[i] = [bars[i][0], 101, 101.5, 100.5, 101];
  const t: OwnTrade = { size: 1, entryPrice: 100, exitPrice: 100, entryIdx: 3, exitIdx: 4 };
  // lag 1: enters at bar 4's open (100) and leaves at bar 5's open (101): +100 bps gross
  const s = summariseOwnLedger([cell(bars, [t])]);
  assert.ok(Math.abs(s.delayedNet - (100 - OWN_LEDGER_COST_BPS)) < 1e-6);
  // lag 2 (orders on close): enters at bar 5's open (101) and leaves at bar 6's open (101): costs only
  const pooc = summariseOwnLedger([cell(bars, [t], { fillsOnClose: true })]);
  assert.ok(Math.abs(pooc.delayedNet + OWN_LEDGER_COST_BPS) < 1e-6);
});

test('an entry priced outside its own bar is counted as a bad fill', () => {
  const s = summariseOwnLedger([cell(flat(10), [{ size: 1, entryPrice: 120, exitPrice: 121, entryIdx: 2, exitIdx: 4 }])]);
  assert.equal(s.badFills, 1);
  assert.ok(gradeOwnLedger(s, 1).failed.includes('fills'));
});

test('adverse move counts how far a held trade went against the entry', () => {
  const bars = flat(10); bars[4] = [bars[4][0], 100, 100.5, 96, 99];          // 4% under entry at the low
  const s = summariseOwnLedger([cell(bars, [{ size: 1, entryPrice: 100, exitPrice: 100, entryIdx: 2, exitIdx: 6 }])]);
  assert.ok(Math.abs(s.adverseMax - 400) < 1e-6);
  assert.equal(s.over3Pct, 1);
});

test('market drift is removed: riding a rising market with no skill is not beyond-drift', () => {
  // a steady 1% a bar climb, a long that holds the whole window
  const bars: OwnBar[] = Array.from({ length: 11 }, (_, i) => { const p = 100 * 1.01 ** i; return [i * 3_600_000, p, p * 1.001, p * 0.999, p * 1.01]; });
  const s = summariseOwnLedger([cell(bars, [{ size: 1, entryPrice: bars[0][1], exitPrice: bars[10][4], entryIdx: 0, exitIdx: 10 }])]);
  assert.ok(s.net > 0);
  assert.ok(Math.abs(s.beyondDrift) < 5, `beyond drift ${s.beyondDrift}`);
});

test('grading names the gate that failed', () => {
  const good = { trades: 200, open: 0, closedNet: 50, net: 50, delayedNet: 40, beyondDrift: 30, firstHalf: 20, secondHalf: 60, long: 40, short: 60, longTrades: 100, shortTrades: 100,
    t: 3, cells: 4, cellsUp: 4, adverseMedian: 50, adverse95: 300, adverseMax: 500, over3Pct: 0.1, badFills: 0, openLoss: 0 };
  assert.deepEqual(gradeOwnLedger(good), { pass: true, failed: [] });
  assert.deepEqual(gradeOwnLedger({ ...good, delayedNet: -1 }).failed, ['delay']);
  assert.deepEqual(gradeOwnLedger({ ...good, net: -1, delayedNet: -2 }).failed, ['open-trades', 'delay']);
  assert.deepEqual(gradeOwnLedger({ ...good, secondHalf: -5 }).failed, ['halves']);
  assert.deepEqual(gradeOwnLedger({ ...good, short: -3 }).failed, ['sides']);
  assert.deepEqual(gradeOwnLedger({ ...good, shortTrades: 0 }).failed, ['sides']);
  assert.deepEqual(gradeOwnLedger({ ...good, trades: 10 }).failed, ['sample']);
  assert.ok(gradeOwnLedger({ ...good, t: Number.NaN }).failed.includes('significance'));
});

test('t statistic needs three trades and a spread', () => {
  assert.ok(Number.isNaN(tStat([1, 2])));
  assert.ok(Number.isNaN(tStat([5, 5, 5])));
  assert.ok(tStat([1, 2, 3, 4]) > 2);
});
