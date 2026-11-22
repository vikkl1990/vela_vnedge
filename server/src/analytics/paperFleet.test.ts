import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { Journal, journalFilter } from './journal.ts';
import { cellKey, ownCellKeys, paperFleet, sourceOf } from './paperFleet.ts';

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
  assert.equal(sourceOf(own, 'alpha', 'BTCUSD', '15m'), 'own');
  assert.equal(sourceOf(own, 'alpha', 'BTCUSD', '1h'), 'copy');   // same scanner, same market, a timeframe it is not allocated on
  assert.equal(sourceOf(own, 'gamma', 'SOLUSD', '15m'), 'copy');
  assert.equal(sourceOf(own, 'delta', 'XRPUSD', '15m'), 'copy');
});

test('the fleet summary splits entries, counts scanners on each side and names idle scanners', () => {
  const entries = [
    { scannerId: 'alpha', symbol: 'BTCUSD', tf: '15m' }, { scannerId: 'alpha', symbol: 'BTCUSD', tf: '15m' }, { scannerId: 'legacy', symbol: 'LINKUSD', tf: '1h' },
    { scannerId: 'zeta', symbol: 'AKEUSD', tf: '15m' }, { scannerId: 'zeta', symbol: 'AINUSD', tf: '15m' }, { scannerId: 'eta', symbol: 'AKEUSD', tf: '4h' }, { scannerId: 'delta', symbol: 'XRPUSD', tf: '15m' },
  ];
  const f = paperFleet(cfg, entries, T, 14);
  assert.deepEqual(f.own, { scanners: 2, pairs: 3 });
  assert.deepEqual(f.idle, ['beta']);                      // gamma is hidden and delta is off, so neither is "idle"
  assert.deepEqual(f.window.entries, { own: 3, copy: 4, total: 7 });
  assert.equal(f.window.ownScanners, 2);
  assert.equal(f.window.copyScanners, 3);                  // zeta, eta, delta
  assert.deepEqual(f.copy, { enabled: true, sizeScale: 1 / 3, minTrades: 5, minNetR: 0 });
  assert.equal(f.ownCells.length, 3);
});

test('a missing mirror section reads as copying off, not as an error', () => {
  const f = paperFleet({ ...cfg, incubator: {} }, [], T, 14);
  assert.deepEqual(f.copy, { enabled: false, sizeScale: null, minTrades: null, minNetR: null });
  assert.deepEqual(f.window.entries, { own: 0, copy: 0, total: 0 });
});

function insert(db: Db, over: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { status: 'closed', scanner_id: 'alpha', scanner_name: 'Alpha', symbol: 'BTCUSD', tf: '15m', side: 'long', qty: 2, qty_open: 0, contract_value: .1, entry_price: 100, entry_at: T - DAY, exit_at: T, exit_reason: 'trail', realized_pnl: 10, fees: 2, risk_amount: 5, bt: 0, ...over };
  return Number(db.run(`INSERT INTO positions(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(() => '?').join(',')})`, ...Object.values(r) as any[]).lastInsertRowid);
}

test('the journal tags each paper trade and filters by it before paging and totals', (t) => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  insert(db); insert(db);                                                          // own
  insert(db, { scanner_id: 'zeta', symbol: 'AKEUSD' });                           // copy
  insert(db, { scanner_id: 'plan:sample' });                                      // research plan: no source
  insert(db, { bt: 2, scanner_id: 'zeta', symbol: 'AKEUSD' });                    // shadow: no source
  const j = new Journal(db, () => ownCellKeys(cfg));
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
  assert.throws(() => q({ list: 'mine' }), /Choose all, own or copy/);
  assert.throws(() => q({ book: 'shadow', list: 'own' }), /paper account only/);
});

test('a journal built without an allocation leaves the source unknown instead of guessing', (t) => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  insert(db);
  const r = new Journal(db).page(journalFilter(new URLSearchParams())).rows[0];
  assert.equal(r.fleetSource, null);
});
