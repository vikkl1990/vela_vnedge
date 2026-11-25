import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { SIMULATION_VERSION } from '../paper/version.ts';
import { cachedEvidence, evidenceCurrent } from './evidenceKey.ts';
import { ValidationService } from './service.ts';

test('cachedEvidence records identity and window; evidenceCurrent requires an exact identity match', () => {
  const e = cachedEvidence({ strategyId: 'A', sourceHash: 'h' }, [{ time: 10 }, { time: 20 }, { time: 30 }]);
  assert.deepEqual(e, { strategyId: 'A', sourceHash: 'h', windowStart: 10, windowEnd: 30, bars: 3 });
  assert.equal(evidenceCurrent({ evidence: e }, 'A'), true);
  assert.equal(evidenceCurrent({ evidence: e }, 'B'), false);
  assert.equal(evidenceCurrent({ evidence: e }, null), false);
  assert.equal(evidenceCurrent({}, 'A'), false, 'legacy rows without a stamp are never current');
  assert.equal(evidenceCurrent({ evidence: cachedEvidence(null, []) }, 'A'), false);
});

test('walk-forward lookup feeds auto-tune only for the current strategy version; summaries still show stale rows', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  db.db.exec(`CREATE TABLE IF NOT EXISTS walk_forward (
    scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, bars INTEGER NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY (scanner_id, symbol, tf));`);
  const stats = { trades: 30, wins: 20, losses: 10, winRatePct: 66, pnl: 100, fees: 1, grossProfit: 150, grossLoss: 50, profitFactor: 3, maxDrawdownPct: 1, avgR: 0.3, weeks: 4, positiveWeeks: 3, negativeWeeks: 1 };
  const row = (symbol: string, strategyId: string | null) => ({ version: SIMULATION_VERSION, at: 1, scannerId: 's', scannerName: 'S', symbol, tf: '15m', bars: 2, from: 0, to: 1,
    opts: { trainDays: 10, testDays: 3, stepDays: 1, minTrades: 3, minProfitFactor: 1 }, windows: [], selectedWindows: 1, inSample: stats, outOfSample: stats, outOfSampleAll: stats, trades: [], weekly: [],
    ...(strategyId ? { evidence: cachedEvidence({ strategyId, sourceHash: null }, [{ time: 0 }, { time: 1 }]) } : {}) });
  for (const [symbol, id] of [['BTCUSD', 'current'], ['ETHUSD', 'older'], ['SOLUSD', null]] as const)
    db.run('INSERT INTO walk_forward(scanner_id, symbol, tf, at, bars, from_ms, to_ms, result) VALUES (?,?,?,?,?,?,?,?)', 's', symbol, '15m', 1, 2, 0, 1, JSON.stringify(row(symbol, id)));
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.validation.walkForward.autoRun = false;
  const scanners = {
    setWalkForwardSource() {}, strategyIdentity: () => ({ strategyId: 'current', sourceHash: null }),
    isActive: () => false, symbolsFor: () => [], timeframesFor: () => [],
  };
  const v = new ValidationService({ db, cfgRef: () => cfg, registry: { get: () => undefined } as any, pool: {} as any, cache: {} as any, scanners: scanners as any });
  t.after(() => (v as any).stop?.());
  assert.ok(v.lookup('s', 'BTCUSD', '15m'));
  assert.equal(v.lookup('s', 'ETHUSD', '15m'), null, 'older strategy version');
  assert.equal(v.lookup('s', 'SOLUSD', '15m'), null, 'legacy unstamped row');
  const byS = Object.fromEntries(v.summaries().map(s => [s.symbol, s.current]));
  assert.deepEqual(byS, { BTCUSD: true, ETHUSD: false, SOLUSD: false });
});
