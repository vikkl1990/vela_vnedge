import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { ValidationService } from './service.ts';
import { walkForward } from './walkForward.ts';
import { researchProvenance, walkForwardOptions } from './provenance.ts';

test('restarted walk-forward lookup excludes changed source/reader/costs but keeps dated results for inspection', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.validation.walkForward.autoRun = false;
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  let source = 'source';
  const market = { contractValue: 1, tickSize: 0.01 };
  const deps: any = {
    db,
    cfgRef: () => cfg,
    registry: { get: () => ({ id: 's', name: 'S', patched: source }) },
    scanners: {
      setWalkForwardSource: () => {},
      cachedMarketInfo: () => market,
      isActive: () => true,
      symbolsFor: () => ['BTCUSD'],
      timeframesFor: () => ['15m'],
    },
  };
  new ValidationService(deps).stop();
  const bars = Array.from({ length: 300 }, (_, i) => ({
    time: 1700000000000 + i * 900000,
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1,
  }));
  const r = walkForward({
    scannerId: 's',
    scannerName: 'S',
    symbol: 'BTCUSD',
    tf: '15m',
    bars,
    events: [],
    cfg: cfg.paper,
    exitMode: 'both',
    ...market,
    opts: { trainDays: 1, testDays: 1, stepDays: 1, minTrades: 5, minProfitFactor: 1 },
  });
  r.provenance = researchProvenance(
    cfg,
    source,
    's',
    'BTCUSD',
    '15m',
    market,
    bars,
    false,
    walkForwardOptions(cfg),
  );
  db.run(
    'INSERT INTO walk_forward VALUES(?,?,?,?,?,?,?,?)',
    's',
    'BTCUSD',
    '15m',
    r.at,
    r.bars,
    r.from,
    r.to,
    JSON.stringify(r),
  );
  const service = new ValidationService(deps);
  t.after(() => service.stop());
  assert.ok(service.lookup('s', 'BTCUSD', '15m'));
  cfg.scanners.s.reader = 2;
  assert.equal(service.lookup('s', 'BTCUSD', '15m'), null);
  assert.ok(service.get('s', 'BTCUSD', '15m'), 'historical result is preserved');
  assert.equal(service.summaries()[0].researchStatus, 'historical');
  assert.equal(service.summaries()[0].oosPass, false);
  delete cfg.scanners.s.reader;
  source = 'updated';
  assert.equal(service.lookup('s', 'BTCUSD', '15m'), null);
  source = 'source';
  market.tickSize = 0.1;
  assert.equal(service.lookup('s', 'BTCUSD', '15m'), null);
});
