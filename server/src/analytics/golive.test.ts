import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goLive, simulateSurvival } from './golive.ts';

test('survival: a losing series breaches the halts often, a winning one rarely; deterministic under a seed', () => {
  const losing = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 0.3 : -1));
  const winning = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -1 : 0.8));
  const o = { tradesPerDay: 20, riskPct: 1, dailyLossPct: 15, maxLossPct: 30, days: 30, paths: 500, seed: 7 };
  const a = simulateSurvival(losing, o), b = simulateSurvival(winning, o);
  assert.ok(a.breachPct > 80, `losing series should breach: ${a.breachPct}`);
  assert.ok(b.breachPct < 5, `winning series should survive: ${b.breachPct}`);
  assert.deepEqual(simulateSurvival(losing, o), a, 'same seed, same numbers');
});

test('goLive: every check carries its number and the rule; all must pass', () => {
  const rs = Array.from({ length: 250 }, (_, i) => (i % 3 === 0 ? -1 : 0.8));
  const v = goLive({ rs, tradesPerDay: 10, riskPct: 1, dailyLossPct: 15, maxLossPct: 30, drawdownAlertPct: 10, lb90: 0.05, haltsInWindow: 0, alertsConfigured: true, paths: 500 });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter(c => !c.ok)));
  const w = goLive({ rs: rs.slice(0, 50), tradesPerDay: 10, riskPct: 1, dailyLossPct: 15, maxLossPct: 30, drawdownAlertPct: 10, lb90: -0.1, haltsInWindow: 1, alertsConfigured: false, paths: 500 });
  assert.equal(w.ok, false); assert.deepEqual(w.checks.filter(c => !c.ok).map(c => c.key).sort(), ['alerts', 'expectancy', 'halts', 'trades']);
  const r3 = goLive({ rs, tradesPerDay: 10, riskPct: 3, dailyLossPct: 15, maxLossPct: 30, drawdownAlertPct: 10, lb90: 0.05, haltsInWindow: 0, alertsConfigured: true, paths: 500 });
  assert.ok(r3.checks.find(c => c.key === 'risk')!.ok === false, '3% per trade fails the risk check');
});
