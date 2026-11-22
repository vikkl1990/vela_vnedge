import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { IncubatorStore } from './store.ts';
import { evaluate, screenSignals } from './cycle.ts';

const T = Date.UTC(2026, 0, 5), DAY = 86_400_000;

for (const pool of ['pair', 'cohort'] as const) for (const enabled of [false, true]) {
  test(`${pool} evaluation ${enabled ? 'counts trials once before retirements' : 'does no trial-count work when the guard is disabled'}`, t => {
    const db = new Db(':memory:'); t.after(() => db.db.close());
    const store = new IncubatorStore(db, { evidenceMode: 'historical-research' });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.scanners = {};
    Object.assign(cfg.incubator.gate, { pool, maxDays: 1, multipleTesting: { enabled, alpha: 0.05 } });
    const rows = Array.from({ length: 20 }, (_, i) => store.move({ scannerId: `s${i}`, symbol: 'BTCUSD', tf: '15m' }, i % 4 ? 'shadow' : 'proposed', 'test', null, null, T));
    for (let i = 0; i < 3; i++) store.move({ scannerId: `c${i}`, symbol: 'BTCUSD', tf: '15m' }, 'candidate', 'test', null, null, T);
    store.move({ scannerId: 'retired', symbol: 'BTCUSD', tf: '15m' }, 'retired', 'test', null, null, T);
    store.move({ scannerId: 'tracked', symbol: 'BTCUSD', tf: '15m' }, 'tracked', 'test', null, null, T);
    let countCalls = 0, trialListCalls = 0;
    const counts = store.counts.bind(store), list = store.list.bind(store);
    store.counts = () => { countCalls++; return counts(); };
    store.list = stages => {
      if (stages?.join(',') === 'candidate,shadow,proposed') trialListCalls++;
      return list(stages);
    };
    const before = JSON.stringify(cfg);
    const report = evaluate(store, cfg, T + 2 * DAY);
    assert.equal(report.retired.length, 20);
    assert.equal(countCalls, enabled ? 1 : 0);
    assert.equal(trialListCalls, 0, 'trial counting must not load and decode every cell');
    for (const row of rows) {
      const reasons = store.get(row.id)!.gate.reasons.join(' ');
      if (enabled) assert.match(reasons, /over 23 cells/, 'retiring an earlier cell must not relax the same evaluation');
      else assert.ok(!reasons.includes('multiple testing'));
    }
    assert.equal(JSON.stringify(cfg), before, 'evaluation does not alter evidence or risk settings');
  });
}

test('nightly and conjunction signal screens exclude holdout and exit markers from training density', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.incubator.screen, { minTrades: 10, minWindowsUp: 3, holdoutShare: 0.3, minHoldoutTrades: 5 });
  const bars = Array.from({ length: 1000 }, (_, i) => ({ time: T + i * 900_000 }));
  const trades = Array.from({ length: 40 }, (_, k) => ({ entryAt: bars[k * 24 + 5].time, pnl: k % 3 === 2 ? -10 : 15, rMultiple: k % 3 === 2 ? -1 : 1.5 }));
  const stressed = trades.map(t => ({ ...t, pnl: t.pnl - 1 }));
  const entries = Array.from({ length: 100 }, (_, i) => ({ kind: 'entry' as const, barTime: bars[i * 10].time }));
  const exits = bars.map(b => ({ kind: 'exit' as const, barTime: b.time }));
  const verdict = screenSignals(trades, stressed, bars, cfg.incubator, [...entries, ...exits], T);
  assert.equal(verdict.entryDensity, 0.1, '70 training entries / 700 training bars, not 100 / 700');
  assert.equal(verdict.pass, true);
  const withoutHoldoutSignals = screenSignals(trades, stressed, bars, cfg.incubator, entries.filter(e => e.barTime < bars[700].time), T);
  assert.deepEqual(verdict, withoutHoldoutSignals, 'holdout signals do not participate in selection');
  const dense = screenSignals(trades, stressed, bars, cfg.incubator, [...entries, { kind: 'entry', barTime: bars[1].time }], T);
  assert.equal(dense.pass, false, 'the existing 10% cap remains enforced');
  assert.ok(dense.entryDensity! > 0.1);
});
