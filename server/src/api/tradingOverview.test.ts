import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { classifyAction, tradingOverview } from './tradingOverview.ts';

const DAY = 86_400_000, NOW = 30 * DAY;

test('entry actions classify by the rule that decided them', () => {
  const cases: Array<[string | null, string]> = [
    ['opened', 'opened'],
    ['rejected:stop too tight for fees (0.77% stop vs 0.14% round-trip cost; need ≥ 16×)', 'cost'],
    ['rejected:against the trend (long while the trend is down)', 'trend'],
    ['rejected:risk burst: a long entry was already taken in the last 120s; one at a time', 'burst'],
    ['rejected:risk re-entry cooldown: EVAAUSD stopped by s 4 min ago', 'cooldown'],
    ['rejected:risk max 2 positions on EVAAUSD', 'caps'],
    ['rejected:risk scanner at its 4-position budget', 'caps'],
    ['rejected:regime: weekend', 'regime'],
    ['rejected:risk daily loss limit', 'risk'],
    ['ignored:already in position', 'ignored'],
    [null, 'other'],
  ];
  for (const [action, stage] of cases) assert.equal(classifyAction(action), stage, String(action));
});

test('overview counts the window only, splits the funnel and sets live beside backtest per scanner', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const sig = (at: number, scanner: string, action: string, kind = 'entry') => db.run(
    "INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,label,message,source,action) VALUES(?,?,?,?,'ETHUSD','5m',?,'x','','alert',?)", at, at, scanner, scanner, kind, action);
  sig(NOW - 1000, 'a', 'opened'); sig(NOW - 2000, 'a', 'rejected:stop too tight for fees (x)'); sig(NOW - 3000, 'a', 'rejected:stop too tight for fees (y)');
  sig(NOW - 4000, 'b', 'rejected:against the trend (z)'); sig(NOW - 5000, 'b', 'opened', 'exit');   // an exit is not part of the entry funnel
  sig(NOW - 8 * DAY, 'a', 'opened');                                                                // outside the 7-day window
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = { a: { enabled: true, symbols: ['ETHUSD'], timeframes: ['5m'], exitMode: 'both' }, b: { enabled: true, symbols: ['ETHUSD'], timeframes: ['5m'], exitMode: 'both' },
    off: { enabled: false, symbols: ['ETHUSD'], timeframes: ['5m'], exitMode: 'both' } } as any;
  cfg.paper.minRiskFeeRatio = 16; cfg.paper.trendGate = { enabled: true, emaLen: 200, tf: '', mode: 'follow' };
  const pos = (scannerId: string, exitAt: number, pnl: number) => ({ scannerId, exitAt, realizedPnl: pnl, fees: 1, riskAmount: 10 }) as any;
  const closed = [pos('a', NOW - DAY, 21), pos('a', NOW - 2 * DAY, -9), pos('b', NOW - 3 * DAY, -9), pos('a', NOW - 10 * DAY, 100)];
  const bt = { stats: { trades: 20, pnl: 40, grossProfit: 120, grossLoss: 80, avgR: 0.2 }, from: NOW - 10 * DAY, to: NOW } as any;
  const o = tradingOverview({ db, cfg, closed, open: [{ scannerId: 'b' } as any], stats: { equity: 1002, initialEquity: 1000 } as any,
    pairsFor: () => [{ symbol: 'ETHUSD', tf: '5m' }], backtest: id => (id === 'a' ? bt : undefined), scannerName: id => id.toUpperCase() }, { since: NOW - 7 * DAY, now: NOW });

  assert.equal(o.window.trades, 3);
  assert.equal(o.window.wins, 1);
  assert.equal(o.window.pnl, 20 - 10 - 10);
  assert.equal(o.funnel.fired, 4);
  assert.deepEqual(Object.fromEntries(o.funnel.stages.map(s => [s.stage, s.n])), { cost: 2, opened: 1, trend: 1 });
  assert.equal(o.funnel.stages[0].stage, 'cost');
  assert.deepEqual(o.scanners.map(s => s.id), ['a', 'b']);                 // the disabled scanner is not listed
  const a = o.scanners[0];
  assert.equal(a.live.trades, 2); assert.equal(a.live.profitFactor, 20 / 10); assert.equal(a.live.avgR, (2 - 1) / 2);
  assert.equal(a.fired, 3); assert.equal(a.opened, 1);
  assert.equal(a.backtest?.profitFactor, 1.5); assert.equal(a.backtest?.perDay, 2);
  assert.equal(o.scanners[1].backtest, null); assert.equal(o.scanners[1].open, 1);
  assert.equal(o.policy.costRatio, 16);
  assert.deepEqual(o.policy.trendGate, { emaLen: 200, mode: 'follow', tf: null });
  assert.deepEqual(o.policy.timeframes, ['5m']);
  assert.equal(o.policy.markets, 1);
});
