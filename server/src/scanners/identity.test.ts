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

test('passive-entry/protection variants and scoped ATR floors are not suppressed as source aliases',()=>{
 const c=structuredClone(DEFAULT_CONFIG),base={enabled:true,symbols:null,timeframes:null,exitMode:'both' as const};
 c.scanners.a={...base};c.scanners.b={...base};const lib=[{id:'a',patched:'same source'},{id:'b',patched:'same source'}];
 assert.equal(duplicateGroups(lib,c).length,1);
 c.scanners.b.entryProtection='atr';assert.equal(duplicateGroups(lib,c).length,0);
 delete c.scanners.b.entryProtection;c.scanners.b.entryLimit={tfs:['15m'],atr:.1,minutes:5};assert.equal(duplicateGroups(lib,c).length,0);
 c.scanners.a.entryLimit=structuredClone(c.scanners.b.entryLimit);assert.equal(duplicateGroups(lib,c).length,1);
 c.risk.regime.minAtrPctByScanner={b:0};assert.equal(duplicateGroups(lib,c).length,0);
 c.risk.regime.minAtrPctByScanner.a=0;assert.equal(duplicateGroups(lib,c).length,1);
 c.risk.regime.exempt=['b'];assert.equal(duplicateGroups(lib,c).length,0);
});

test('reader revisions separate aliases and evidence only for the opted-in scanner',async()=>{
 const {strategyIdentity}=await import('./identity.ts');const {resolveTradePolicy}=await import('../paper/tradePolicy.ts');
 const c=structuredClone(DEFAULT_CONFIG),base={enabled:false,symbols:null,timeframes:null,exitMode:'both' as const};c.scanners.a={...base};c.scanners.b={...base};
 const a=strategyIdentity('source',c,'a'),b=strategyIdentity('source',c,'b'),cell={scannerId:'a',symbol:'ETHUSD',tf:'15m'};
 const policy=resolveTradePolicy(c,cell,'source').strategyId,other=resolveTradePolicy(c,{...cell,scannerId:'b'},'source').strategyId;
 c.scanners.a.reader=1;assert.equal(strategyIdentity('source',c,'a'),a);
 c.scanners.a.reader=2;assert.notEqual(strategyIdentity('source',c,'a'),a);assert.equal(strategyIdentity('source',c,'b'),b);
 assert.notEqual(resolveTradePolicy(c,cell,'source').strategyId,policy);assert.equal(resolveTradePolicy(c,{...cell,scannerId:'b'},'source').strategyId,other);
});
