import { test } from 'node:test';
import assert from 'node:assert/strict';
import { band, learnBook, type LearnTrade } from './learning.ts';

const mk = (o: Partial<LearnTrade>): LearnTrade => ({ scannerId: 's', scannerName: 'S', symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt: 0, exitAt: 600_000, pnl: 0, fees: 1, rMultiple: 0, exitReason: 'trail', peakR: 0, ...o });

test('band: null under five trades, symmetric around the mean, tighter with more trades', () => {
  assert.deepEqual(band([1, 1, 1, 1]), { lb: null, ub: null });
  const b = band([1, -1, 1, -1, 1, -1, 1, -1]); assert.ok(b.lb! < 0 && b.ub! > 0);
  const wide = band([2, -1, 2, -1, 2, -1]), narrow = band(Array(24).fill([2, -1]).flat()); assert.ok(narrow.ub! - narrow.lb! < wide.ub! - wide.lb!);
});

test('learnBook: breakeven win rate, cost share, stop anatomy, give-back and the R curve', () => {
  const ts: LearnTrade[] = [
    ...Array.from({ length: 6 }, (_, i) => mk({ entryAt: i * 3_600_000, exitAt: i * 3_600_000 + 1_800_000, pnl: 9, fees: 1, rMultiple: 0.3, peakR: 0.8, exitReason: 'trail' })),
    ...Array.from({ length: 4 }, (_, i) => mk({ entryAt: 10 * 3_600_000 + i * 3_600_000, exitAt: 10 * 3_600_000 + i * 3_600_000 + (i < 3 ? 300_000 : 3_600_000), pnl: -29, fees: 1, rMultiple: -1, peakR: i < 3 ? 0.05 : 0.5, exitReason: 'sl' })),
  ];
  const L = learnBook(ts);
  assert.equal(L.trades, 10); assert.equal(L.winRatePct, 60);
  assert.ok(Math.abs(L.breakevenWinPct! - 76.92) < 0.1, 'avg win 0.3R, avg loss −1R → needs 76.9% winners');
  assert.ok(Math.abs(L.costShare! - 10 / 60) < 1e-9, 'fees over gross winnings');
  assert.deepEqual({ n: L.stops.n, neverMoved: L.stops.neverMoved, firstBar: L.stops.firstBar }, { n: 4, neverMoved: 3, firstBar: 3 });
  const trail = L.exits.find(e => e.reason === 'trail')!; assert.ok(Math.abs(trail.giveBackR! - 0.5) < 1e-9, 'trail exits gave back 0.5R of a 0.8R peak');
  assert.equal(L.curve.at(-1)!.cumR.toFixed(2), (6 * 0.3 - 4).toFixed(2)); assert.ok(L.curve.at(-1)!.ddR < 0);
  assert.equal(L.byScanner[0].verdict, 'undecided', 'ten trades at −0.22R: the band still crosses zero');
  const many = learnBook(Array.from({ length: 40 }, (_, i) => mk({ entryAt: i * 3_600_000, exitAt: i * 3_600_000 + 60_000, pnl: -29, fees: 1, rMultiple: i % 4 === 0 ? 0.3 : -1, exitReason: i % 4 === 0 ? 'trail' : 'sl' })));
  assert.equal(many.byScanner[0].verdict, 'failing');
  assert.equal(L.holds.find(h => h.label === '15–60m')!.n, 6);
});
