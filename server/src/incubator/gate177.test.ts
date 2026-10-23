import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateVerdict, mirrorRefusal, pairStats, tStat, thinMarketRefusal, type TradeR } from './gate.ts';
import { DEFAULT_CONFIG } from '../config.ts';

const H = 3600_000;
const mk = (rs: number[], since = 0): TradeR[] => rs.map((r, i) => ({ entryAt: since + i * 6 * H, exitAt: since + i * 6 * H + H, r, side: 'long' }));

test('decision 177: the t-statistic is mean R over its standard error', () => {
  assert.equal(tStat([]), 0);
  assert.equal(tStat([0.5]), 0, 'one trade has no standard error');
  const even = tStat([1, -1, 1, -1]);
  assert.equal(even, 0);
  const strong = tStat([...Array(8).fill(-1), ...Array(32).fill(0.6)]);
  assert.ok(strong > 2, `a 2:1 record at 40 trades stands above noise: t ${strong.toFixed(2)}`);
  assert.equal(tStat([0.4, 0.4, 0.4]), Infinity, 'no dispersion and a positive mean');
});

test('decision 177: a mean at the gate floor with a wide spread is brewing, the same mean with a tight spread proposes', () => {
  const g = { ...DEFAULT_CONFIG.incubator.gate, minT: 2, minTrades: 30, minDays: 1, minWeeks: 0, minPositiveWeeksPct: 0 };
  const now = 40 * 24 * H;
  // 30 trades averaging +0.1R: ten at −1, twenty at +0.65 → PF ≈ 1.3, mean +0.1, but t ≈ 0.6
  const noisy = pairStats(mk([...Array(10).fill(-1), ...Array(20).fill(0.65)]), 0, now);
  assert.ok(noisy.avgR >= 0.1 && (noisy.pfR ?? 0) >= 1.2, `passes the old gate: ${noisy.avgR.toFixed(2)}R PF ${noisy.pfR?.toFixed(2)}`);
  const v = gateVerdict(noisy, g);
  assert.equal(v.decision, 'brewing');
  assert.ok(v.reasons.some(r => r.startsWith('t ')), v.reasons.join('; '));
  // 60 trades at the same mean with less dispersion clears it
  const steady = pairStats(mk([...Array(10).fill(-0.5), ...Array(50).fill(0.22)]), 0, now);
  assert.equal(gateVerdict(steady, g).decision, 'propose', `t ${steady.tStat.toFixed(2)}`);
  // minT 0 turns the check off
  assert.equal(gateVerdict(noisy, { ...g, minT: 0 }).decision, 'propose');
});

test('decision 177: the mirror copies an entry only once the pair has a record of its own', () => {
  const m = { enabled: true, minTrades: 5, minNetR: 0, minTurnoverUsd: 2_000_000 };
  assert.match(mirrorRefusal(m, mk([0.5, 0.5]), 9e6)!, /2\/5 shadow closes/);
  assert.match(mirrorRefusal(m, mk([-1, -1, 0.5, 0.5, 0.5]), 9e6)!, /-0\.5R over 5 shadow closes/);
  assert.equal(mirrorRefusal(m, mk([-1, 0.5, 0.5, 0.5, 0.5]), 9e6), null, 'five closes, net +1R, deep market');
  assert.match(mirrorRefusal(m, mk([-1, 0.5, 0.5, 0.5, 0.5]), 300_000)!, /thin market: \$0\.30M/);
  assert.equal(mirrorRefusal(m, mk([-1, 0.5, 0.5, 0.5, 0.5]), null), null, 'an unjudged market is not refused for being thin');
  assert.equal(mirrorRefusal({ enabled: true }, [], 1), null, 'no floor configured: the old behaviour');
  assert.equal(mirrorRefusal(undefined, [], null), null);
});

test('decision 177: the thin-market refusal', () => {
  assert.equal(thinMarketRefusal(0, 10), null);
  assert.equal(thinMarketRefusal(undefined, 10), null);
  assert.equal(thinMarketRefusal(5e6, null), null);
  assert.equal(thinMarketRefusal(5e6, 6e6), null);
  assert.match(thinMarketRefusal(5e6, 1.35e6)!, /\$1\.35M 24h turnover < \$5\.0M/);
});
