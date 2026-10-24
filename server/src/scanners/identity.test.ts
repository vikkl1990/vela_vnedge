import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { Db } from '../db.ts';
import { aliasMap, duplicateGroups } from './identity.ts';
import { overlapClusters } from '../incubator/overlap.ts';

test('decision 194: byte-identical scripts read the same way are one strategy; an enabled copy is the canonical one', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.scanners['super-rsi-strategy-tv-strategies'] = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' } as any;
  const lib = [
    { id: 'super-rsi-strategy', patched: 'A' }, { id: 'super-rsi-strategy-tv-strategies', patched: 'A' },
    { id: 'fast-scalper', patched: 'B' }, { id: 'fast-scalper-tv', patched: 'B' }, { id: 'fast-scalper-tv-x1', patched: 'B' },
    { id: 'lonely', patched: 'C' }, { id: 'broken', patched: 'C', status: 'unavailable' },
  ];
  const g = duplicateGroups(lib, cfg);
  assert.deepEqual(g.map(x => [x.canonical, x.aliases]), [['fast-scalper', ['fast-scalper-tv', 'fast-scalper-tv-x1']], ['super-rsi-strategy-tv-strategies', ['super-rsi-strategy']]]);
  // the same source read differently (inverted) is a different strategy
  cfg.scanners['fast-scalper-tv'] = { enabled: false, symbols: null, timeframes: null, exitMode: 'both', invert: true } as any;
  const m = aliasMap(duplicateGroups(lib, cfg));
  assert.equal(m.has('fast-scalper-tv'), false);
  assert.equal(m.get('fast-scalper-tv-x1'), 'fast-scalper');
});

test('decision 194: shadow pairs whose entries coincide are clustered; ones that only touch now and then are not', () => {
  const db = new Db(':memory:');
  const T = 1_800_000_000_000, H = 3600_000;
  const add = (sid: string, at: number, side = 'long', symbol = 'SOLUSD') => db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, bt) VALUES ('closed',?,?,?,?,?,1,0,1,100,?,2)", sid, sid, symbol, '1h', side, at);
  for (let k = 0; k < 10; k++) { add('donchian-a', T + k * H); add('donchian-b', T + k * H + 3000); }
  for (let k = 0; k < 10; k++) add('other', T + k * H + (k < 2 ? 1000 : 1800_000));   // 2 of 10 coincide: below the share
  add('donchian-b', T + 50 * H, 'short');
  const c = overlapClusters(db, { since: 0 });
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].members, ['donchian-a|SOLUSD|1h', 'donchian-b|SOLUSD|1h']);
  assert.equal(c[0].links[0].shared, 10);
});
