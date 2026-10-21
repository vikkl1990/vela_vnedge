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

test('decision 167: under margin sizing the expectancy and the simulation read each trade\'s % of equity', () => {
  const rs = Array.from({ length: 250 }, (_, i) => (i % 3 === 0 ? -1 : 0.8));
  const base = { rs, tradesPerDay: 10, riskPct: 1, dailyLossPct: 15, maxLossPct: 30, drawdownAlertPct: 10, lb90: -0.05, haltsInWindow: 0, alertsConfigured: true, paths: 500 };
  // equal-weight R says no edge; the money (small losers, larger winners on the strong cells) says yes
  const pcts = rs.map((r, i) => (r < 0 ? -0.4 : i % 5 === 0 ? 1.2 : 0.3));
  const v = goLive({ ...base, equityPcts: pcts, lbPct90: 0.08 });
  const exp = v.checks.find(c => c.key === 'expectancy')!;
  assert.equal(exp.ok, true); assert.match(exp.label, /% of equity/); assert.equal(exp.value, '+0.080%');
  // the drawdown follows the returns given, not riskPct × R: ten times the returns, far deeper drawdown
  const big = goLive({ ...base, equityPcts: pcts.map(p => p * 10), lbPct90: 0.8 });
  assert.ok(big.sim!.dd95Pct > v.sim!.dd95Pct * 3, `${big.sim!.dd95Pct} vs ${v.sim!.dd95Pct}`);
  // without them the R reading stands
  assert.equal(goLive(base).checks.find(c => c.key === 'expectancy')!.ok, false);
});
