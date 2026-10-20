import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { familyFor, originOf } from './families.ts';
import { LibraryService } from './library.ts';

test('decision 153: familyFor uses the row, then the LuxAlgo catalogue, then the name', () => {
  assert.equal(familyFor({ name: 'Anything', family: 'wyckoff' }), 'wyckoff');
  assert.equal(familyFor({ name: 'Valid BOS Pullback', url: 'https://www.luxalgo.com/library/indicator/valid-bos-pullback/' }), 'market-structure');
  assert.equal(familyFor({ name: 'Smart Money Engine' }), 'smc-ict');
  assert.equal(familyFor({ name: 'SmartTrend Pro' }), 'trend');
  assert.equal(familyFor({ name: 'Lorentzian Classification' }), 'machine-learning');
  assert.equal(familyFor({ name: 'Precision Sniper' }), 'other');
  assert.equal(originOf('https://www.luxalgo.com/library/indicator/x/'), 'luxalgo');
  assert.equal(originOf('https://in.tradingview.com/script/abc/'), 'tradingview');
});

function fakeApp(db: Db) {
  const scripts = [
    { id: 'a', name: 'Alpha Trend', author: 'X', family: 'trend', origin: 'tradingview', status: 'ok', reason: null, scriptType: 'indicator', overlay: true, updated: '2026-10-01T00:00:00Z', url: 'u', license: null, pineVersion: '6', lines: 10, patches: [] },
    { id: 'b', name: 'Beta', author: 'Y', family: 'other', origin: 'other', status: 'incompatible', reason: 'boom', scriptType: 'strategy', overlay: false, updated: null, url: 'u', license: null, pineVersion: '5', lines: 5, patches: [] },
    { id: 'c', name: 'Gone', author: 'Z', family: 'other', origin: 'other', status: 'unavailable', reason: null, scriptType: null, overlay: true, updated: null, url: 'u', license: null, pineVersion: null, lines: null, patches: [] },
  ];
  return {
    db,
    registry: { all: () => scripts, get: (id: string) => scripts.find(s => s.id === id) },
    scanners: { health: { row: (id: string) => (id === 'a' ? null : null) }, scannerConfig: (id: string) => ({ enabled: id === 'a', hidden: false }) },
  } as any;
}

test('decision 153: the library lists runnable and failing scripts with their stages and shadow record, and keeps favorites per user', () => {
  const db = new Db(':memory:');
  const now = Date.parse('2026-10-20T12:00:00Z');
  db.run("INSERT INTO incubator_pairs(scanner_id, symbol, tf, stage, since, updated) VALUES ('a','BTCUSD','15m','shadow',0,0),('a','ETHUSD','15m','shadow',0,0),('a','SOLUSD','1h','live',0,0)");
  for (const [r, at] of [[1, now - 3 * 86_400_000], [-1, now - 2 * 86_400_000], [0.5, now - 86_400_000]] as const) {
    db.run("INSERT INTO positions (status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, realized_pnl, fees, risk_amount, exit_at, exit_reason, bt) VALUES ('closed','a','Alpha Trend','BTCUSD','15m','long',1,0,1,100,?,?,0,100,?,'trail',2)", at - 1000, r * 100, at);
  }
  const lib = new LibraryService(fakeApp(db));
  const l = lib.list(now);
  assert.deepEqual(l.scripts.map(s => s.id), ['a', 'b'], 'a script without source is not listed');
  const a = l.scripts[0];
  assert.deepEqual(a.stages, { shadow: 2, live: 1 });
  assert.equal(a.status, 'runs');
  assert.equal(a.updated, '2026-10-01');
  assert.equal(a.shadow!.n, 3);
  assert.equal(a.shadow!.r, 0.5);
  assert.deepEqual(a.shadow!.spark, [0, 1, 0, 0.5]);
  assert.equal(l.scripts[1].status, 'fails');
  assert.equal(l.families.find(f => f.key === 'trend')!.count, 1);
  const d = lib.detail('a', now)!;
  assert.equal(d.pairs.length, 3);
  assert.equal(d.recent.length, 3);
  assert.equal(lib.detail('c', now), null);
  assert.deepEqual(lib.setFavorite(7, 'a', true), ['a']);
  assert.deepEqual(lib.favorites(8), [], 'favorites are per user');
  assert.deepEqual(lib.setFavorite(7, 'a', false), []);
  assert.throws(() => lib.setFavorite(7, 'nope', true));
  db.db.close();
});
