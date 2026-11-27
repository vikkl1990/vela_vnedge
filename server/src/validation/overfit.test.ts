import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMoments, deflatedSharpe, expectedMaxSharpe, momentStats, momentsOf, normCdf, normInv, pboCscv, probabilisticSharpe } from './overfit.ts';

/** Deterministic pseudo-random numbers, so the tests never flake. */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32; }; }
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

test('moments pool across markets exactly as one series would', () => {
  const a = [1, -1, 2.5, -1, 0.3], b = [-1, -1, 3, 0.2];
  const pooled = momentStats(addMoments(momentsOf(a), momentsOf(b))), whole = momentStats(momentsOf([...a, ...b]));
  for (const k of ['mean', 'sd', 'sr', 'skew', 'kurt'] as const) assert.ok(Math.abs(pooled[k] - whole[k]) < 1e-9, k);
  const s = momentStats(momentsOf([1, 2, 3, 4]));
  assert.ok(Math.abs(s.mean - 2.5) < 1e-12 && Math.abs(s.sd - Math.sqrt(5 / 3)) < 1e-12);
});

test('the normal helpers invert each other', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-6);
  for (const p of [0.01, 0.3, 0.9, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
});

test('more trials raise the bar a lucky Sharpe has to clear', () => {
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
  const ten = expectedMaxSharpe(10, 0.01), thousand = expectedMaxSharpe(1000, 0.01);
  assert.ok(ten > 0 && thousand > ten);
  // a modest edge is convincing alone and not after a thousand tries
  const m = momentsOf(Array.from({ length: 400 }, (_, i) => (i % 10 < 4 ? 1.5 : -0.8)));   // +0.12R a trade
  assert.ok(probabilisticSharpe(momentStats(m).sr, 400, 0, 3, 0) > 0.95);
  assert.ok(deflatedSharpe(m, 1000, 0.04).dsr < 0.5);
});

test('PBO is low when one candidate has a real edge and high when all are noise', () => {
  const r = rng(7), S = 10, J = 30;
  const matrix = () => Array.from({ length: S }, () => Array.from({ length: J }, () => gauss(r)));
  // one noise draw can land anywhere (its splits share blocks); over many draws PBO centres on a coin flip
  const draws = Array.from({ length: 20 }, matrix);
  const meanNoise = draws.reduce((a, m) => a + pboCscv(m).pbo, 0) / draws.length;
  assert.equal(pboCscv(draws[0]).splits, 252);
  assert.ok(meanNoise > 0.35 && meanNoise < 0.65, `noise PBO averages ${meanNoise}`);
  const skilled = draws[0].map(row => row.map((v, j) => (j === 0 ? v + 3 : v)));
  const pSkill = pboCscv(skilled);
  assert.ok(pSkill.pbo < 0.05, `skilled PBO ${pSkill.pbo}`);
  assert.ok(Number.isNaN(pboCscv([[1, 2], [3, 4], [5, 6]]).pbo), 'an odd number of blocks is refused');
});
