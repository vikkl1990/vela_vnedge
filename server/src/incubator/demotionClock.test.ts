import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { IncubatorStore } from './store.ts';
import { demote, recordScreen, evaluate } from './cycle.ts';

const T0 = Date.UTC(2026, 9, 1), DAY = 86400_000;

test('decision 184: a demotion restarts the shadow clock, so a returning pair is not retired as stale before it trades', () => {
  const db = new Db(':memory:');
  const store = new IncubatorStore(db);
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = {};
  const screen = { pass: true, at: T0, trades: 40, profitFactor: 1.6, netPnl: 100, netAtStress: 50, windowsUp: 6, winRatePct: 50, avgR: 0.2, bars: 4000 } as any;
  recordScreen(store, { scannerId: 's', symbol: 'ZECUSD', tf: '15m' }, screen, cfg.incubator, T0);
  evaluate(store, cfg, T0);
  const r = store.find('s', 'ZECUSD', '15m')!;
  assert.equal(r.stage, 'shadow');
  // promoted on day 10, lived 40 days with no shadow trades (the shadow runner does not trade a live cell)
  store.move(r, 'live', 'test', null, 'promoted', T0 + 10 * DAY);
  const back = demote(store, cfg, r.id, 'operator', () => {}, 'operator: back to shadow', T0 + 50 * DAY);
  assert.equal(back.stage, 'shadow');
  assert.equal(back.since, T0, 'the evidence window stays the original admission (decision 132)');
  // the next hunt, a day later: not stale (the old rule read the last shadow trade from before promotion)
  const rep = evaluate(store, cfg, T0 + 51 * DAY);
  assert.ok(!rep.retired.some(n => n.startsWith('s ')), `not retired: ${rep.retired.join(', ')}`);
  assert.equal(store.find('s', 'ZECUSD', '15m')!.stage, 'shadow');
  // the demotion's reason is the operator's note, not an older proposal's
  const d = store.lastDemotion(r.id)!;
  assert.equal(d.at, T0 + 50 * DAY);
  assert.match(d.reason ?? '', /operator: back to shadow/, 'the operator\'s own reason, not an older proposal\'s');
});
