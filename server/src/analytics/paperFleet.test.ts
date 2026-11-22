import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { Journal, journalFilter } from './journal.ts';
import { cellKey, ownCellKeys, paperFleet, entryOrigin } from './paperFleet.ts';

const T = Date.UTC(2026, 10, 22), DAY = 86_400_000;
const cfg: any = {
  timeframes: ['15m'],
  scanners: {
    alpha: { enabled: true, hidden: false, pairs: [{ symbol: 'BTCUSD', tf: '15m' }, { symbol: 'ETHUSD', tf: '1h' }] },
    beta: { enabled: true, hidden: false, pairs: [] },              // switched on, nothing allocated
    gamma: { enabled: true, hidden: true, pairs: [{ symbol: 'SOLUSD', tf: '15m' }] },  // hidden: not on the list
    delta: { enabled: false, hidden: false, pairs: [{ symbol: 'XRPUSD', tf: '15m' }] }, // off: not on the list
    legacy: { enabled: true, hidden: false, symbols: ['LINKUSD'], timeframes: ['1h'] }, // legacy symbols expand over its timeframes
  },
  incubator: { mirror: { enabled: true, minTrades: 5, minNetR: 0, pilot: { sizeScale: 1 / 3 } } },
};

test('the own list is every allocated cell of an enabled, visible scanner', () => {
  const own = ownCellKeys(cfg);
  assert.deepEqual([...own].sort(), [cellKey('alpha', 'BTCUSD', '15m'), cellKey('alpha', 'ETHUSD', '1h'), cellKey('legacy', 'LINKUSD', '1h')].sort());
});

test('the fleet summary splits entries, counts scanners on each side and names idle scanners', () => {
  const entries = [
    { scannerId: 'alpha', symbol: 'BTCUSD', tf: '15m' }, { scannerId: 'alpha', symbol: 'BTCUSD', tf: '15m' }, { scannerId: 'legacy', symbol: 'LINKUSD', tf: '1h' },
    { scannerId: 'zeta', symbol: 'AKEUSD', tf: '15m' }, { scannerId: 'zeta', symbol: 'AINUSD', tf: '15m' }, { scannerId: 'eta', symbol: 'AKEUSD', tf: '4h' }, { scannerId: 'delta', symbol: 'XRPUSD', tf: '15m' },
  ];
  const f = paperFleet(cfg, entries.map((e,i) => ({...e,fleetSource:i<3?'own' as const:'copy' as const})), T, 14);
  assert.deepEqual(f.own, { scanners: 2, pairs: 3 });
  assert.deepEqual(f.idle, ['beta']);                      // gamma is hidden and delta is off, so neither is "idle"
  assert.deepEqual(f.window.entries, { own: 3, copy: 4, unknown:0, total: 7 });
  assert.equal(f.window.ownScanners, 2);
  assert.equal(f.window.copyScanners, 3);                  // zeta, eta, delta
  assert.deepEqual(f.copy, { enabled: true, sizeScale: 1 / 3, minTrades: 5, minNetR: 0 });
  assert.equal(f.ownCells.length, 3);
});

test('a missing mirror section reads as copying off, not as an error', () => {
  const f = paperFleet({ ...cfg, incubator: {} }, [], T, 14);
  assert.deepEqual(f.copy, { enabled: false, sizeScale: null, minTrades: null, minNetR: null });
  assert.deepEqual(f.window.entries, { own: 0, copy: 0, unknown:0, total: 0 });
});

function insert(db: Db, over: Record<string, unknown> = {}, source: 'own'|'copy'|null='own') {
  const r: Record<string, unknown> = { status: 'closed', scanner_id: 'alpha', scanner_name: 'Alpha', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 2, qty_open: 0, contract_value: .1, entry_price: 100, entry_at: T - DAY, exit_at: T, exit_reason: 'trail', realized_pnl: 10, fees: 2, risk_amount: 5, bt: 0, ...over };
  const id = Number(db.run(`INSERT INTO positions(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(() => '?').join(',')})`, ...Object.values(r) as any[]).lastInsertRowid);
  if(source)db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage,snapshot) VALUES(?,?,?,?,?,?,'opened',?)",r.entry_at,r.bt,id,r.scanner_id,r.symbol,r.tf,JSON.stringify({version:3,entryOrigin:{version:1,source,sizeScale:source==='copy'?1/3:1}}));
  return id;
}

test('the journal tags each paper trade and filters by it before paging and totals', (t) => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  insert(db); insert(db);                                                          // own
  insert(db, { scanner_id: 'zeta', symbol: 'AKEUSD' }, 'copy');                           // copy
  insert(db, { scanner_id: 'plan:sample' });                                      // research plan: no source
  insert(db, { bt: 2, scanner_id: 'zeta', symbol: 'AKEUSD' });                    // shadow: no source
  const j = new Journal(db);
  const q = (o: Record<string, string> = {}) => journalFilter(new URLSearchParams(o));
  const all = j.page(q());
  assert.deepEqual(all.rows.map((r) => r.fleetSource).filter(Boolean).sort(), ['copy', 'own', 'own']);
  assert.equal(all.rows.filter((r) => r.fleetSource === null).length, 1);          // the research-plan row carries no source
  assert.equal(j.page(q({ list: 'own' })).total, 2);
  assert.equal(j.page(q({ list: 'copy' })).total, 1);
  assert.equal(j.page(q({ list: 'own' })).summary.closed, 2);                        // the summary follows the filter
  const plans = j.page(q({ scope: 'plans' }));
  assert.equal(plans.rows[0].fleetSource, null);
  assert.equal(j.page(q({ book: 'shadow' })).rows[0].fleetSource, null);
  assert.throws(() => q({ list: 'mine' }), /Choose all, own, copy or unknown/);
  assert.throws(() => q({ book: 'shadow', list: 'own' }), /paper account only/);
});

test('a journal built without an allocation leaves the source unknown instead of guessing', (t) => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  insert(db,{},null);
  const r = new Journal(db).page(journalFilter(new URLSearchParams())).rows[0];
  assert.equal(r.fleetSource, 'unknown');
});


test('promotions, removals and new pilot sizing cannot rewrite recorded entry origin', t => {
  const db=new Db(':memory:');t.after(()=>db.db.close());
  const copy=insert(db,{},'copy'), own=insert(db,{scanner_id:'zeta'},'own'), unknown=insert(db,{},null);
  const j=new Journal(db), filter=journalFilter(new URLSearchParams({limit:'1',list:'copy'}));
  const prior=structuredClone(cfg);
  prior.scanners.alpha.pairs=[];prior.scanners.zeta={enabled:true,pairs:[{symbol:'BTCUSD',tf:'15m'}]};prior.incubator.mirror.pilot.sizeScale=.5;
  assert.equal(j.page(filter).total,1);assert.equal(j.page(filter).rows[0].id,copy);
  assert.equal(j.detail('paper',copy).row.entrySizeScale,1/3);
  assert.equal(j.detail('paper',own).row.fleetSource,'own');
  assert.equal(j.detail('paper',unknown).row.fleetSource,'unknown');
  const entries=j.page(journalFilter(new URLSearchParams())).rows.map(r=>({...r,fleetSource:r.fleetSource!}));
  const fleet=paperFleet(prior,entries,T,14);
  assert.deepEqual(fleet.window.entries,{own:1,copy:1,unknown:1,total:3});
  assert.equal(fleet.copy.sizeScale,.5,'current requested size is reported separately');
});

test('legacy positive copy evidence survives, but absent or malformed evidence cannot invent an origin or scale', () => {
  assert.deepEqual(entryOrigin({features:{copy_pilot:1}},JSON.stringify({version:3,sizeScale:.25})),{fleetSource:'copy',entrySizeScale:.25});
  assert.deepEqual(entryOrigin({features:{copy_pilot:1}},null),{fleetSource:'copy',entrySizeScale:null});
  assert.deepEqual(entryOrigin({features:{trend50:1}},null),{fleetSource:'unknown',entrySizeScale:null});
  assert.deepEqual(entryOrigin('{bad','{bad'),{fleetSource:'unknown',entrySizeScale:null});
  assert.equal(entryOrigin({pendingEntry:{features:{copy_pilot:1}}},null).fleetSource,'copy');
  assert.equal(entryOrigin({}, {entryOrigin:{version:1,source:'copy',sizeScale:Infinity}}).entrySizeScale,null);
});
