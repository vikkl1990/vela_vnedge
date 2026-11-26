import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { researchProvenance, currentResearch } from './provenance.ts';

test('research identity binds source, reader, inputs, execution costs, runtime policy and exact data window', () => {
  const cfg = structuredClone(DEFAULT_CONFIG),
    market = {
      tickSize: 0.01,
      contractValue: 1,
      productFees: {
        source: 'delta-product' as const,
        symbol: 'BTCUSD',
        feeRatePct: 0.05,
        makerFeeRatePct: 0.02,
      },
    };
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both', reader: 2 };
  const bars = [{ time: 1000, open: 100, close: 101, high: 102, low: 99, volume: 4 }];
  const p = researchProvenance(cfg, 'source', 's', 'BTCUSD', '15m', market, bars);
  assert.equal(currentResearch(p, cfg, 'source', 's', 'BTCUSD', '15m', market), true);
  assert.equal(currentResearch(undefined, cfg, 'source', 's', 'BTCUSD', '15m', market), false);
  assert.equal(currentResearch(p, cfg, 'changed', 's', 'BTCUSD', '15m', market), false);
  assert.equal(
    currentResearch(p, cfg, 'source', 's', 'BTCUSD', '15m', undefined),
    false,
    'market must have been independently loaded',
  );
  for (const change of [
    () => {
      cfg.scanners.s.reader = 3;
    },
    () => {
      cfg.scanners.s.inputs = { length: 42 };
    },
    () => {
      cfg.paper.feeTaxPct = 19;
    },
    () => {
      cfg.paper.latencyMs++;
    },
  ]) {
    const before = structuredClone(cfg);
    change();
    assert.equal(currentResearch(p, cfg, 'source', 's', 'BTCUSD', '15m', market), false);
    Object.assign(cfg, before);
  }
  assert.equal(currentResearch(p, cfg, 'source', 's', 'BTCUSD', '15m', { ...market, tickSize: 0.1 }), false);
  cfg.scanners.s.pairs = [{ symbol: 'ETHUSD', tf: '1h' }];
  cfg.scanners.s.hidden = true;
  assert.equal(
    currentResearch(p, cfg, 'source', 's', 'BTCUSD', '15m', market),
    true,
    'allocation/presentation cannot relabel interpretation',
  );
  const other = researchProvenance(cfg, 'source', 's', 'BTCUSD', '15m', market, [{ ...bars[0], volume: 5 }]);
  assert.equal(other.identity, p.identity);
  assert.notEqual(other.key, p.key, 'even equal window dates cannot hide changed input bars');
});
