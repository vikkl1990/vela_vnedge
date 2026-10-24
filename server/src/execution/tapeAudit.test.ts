import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { TapeAudit } from './tapeAudit.ts';

/** A stand-in for a paper engine: the audit reads `order` events, `position(id)` and `pendingEntries()`. */
function fakeEngine() {
  const e: any = new EventEmitter();
  e.positions = new Map<number, any>();
  e.pending = [] as any[];
  e.position = (id: number) => e.positions.get(id);
  e.pendingEntries = () => e.pending;
  return e;
}
const trade = (symbol: string, price: number, qty: number, timeMs: number) => ({ symbol, price, qty, timeMs, aggressor: 'buy' as const });

test('decision 187: a long stop is priced at the prints after the first trade through it, slip in bps and R', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  eng.positions.set(7, { entryPrice: 100, slOriginal: 98, tf: '1h' });
  audit.onTrade(trade('XUSD', 98.2, 5, t0 - 2000));
  audit.onTrade(trade('XUSD', 97.9, 10, t0 - 1000));    // first print through 98
  audit.onTrade(trade('XUSD', 97.8, 10, t0));
  eng.emit('order', { at: t0, positionId: 7, symbol: 'XUSD', side: 'sell', qty: 1, price: 98, reason: 'sl' });
  audit.onTrade(trade('XUSD', 97.7, 20, t0 + 1500));
  audit.onTrade(trade('XUSD', 99, 50, t0 + 10_000));     // outside the 3 s window
  (audit as any).tick(t0 + 5000);
  const [row] = db.all<any>('SELECT * FROM tape_audit');
  assert.equal(row.kind, 'stop (sl)');
  const vwap = (97.9 * 10 + 97.8 * 10 + 97.7 * 20) / 40;
  assert.ok(Math.abs(row.tape_price - vwap) < 1e-9);
  assert.equal(row.worst_print, 97.7);
  assert.ok(Math.abs(row.slip_bps - ((98 - vwap) / 98) * 1e4) < 1e-6);
  assert.ok(Math.abs(row.slip_r - (98 - vwap) / 2) < 1e-9);
  const s = audit.summary(0);
  assert.equal(s.fills[0].kind, 'stop (sl)');
  assert.equal(s.fills[0].n, 1);
});

test('decision 187: a market entry waits for prints, and a fill with none in 30 s is recorded as such', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 2 }]);
  const t0 = 1_800_000_000_000;
  eng.positions.set(1, { entryPrice: 50, slOriginal: 51, tf: '4h' });
  eng.emit('order', { at: t0, positionId: 1, symbol: 'AUSD', side: 'sell', qty: 1, price: 50, reason: 'entry' });
  eng.emit('order', { at: t0, positionId: 2, symbol: 'BUSD', side: 'buy', qty: 1, price: 10, reason: 'entry' });
  (audit as any).tick(t0 + 5000);
  assert.equal(db.all('SELECT * FROM tape_audit').length, 0, 'nothing yet: no prints');
  audit.onTrade(trade('AUSD', 49.9, 3, t0 + 6000));   // a short entry: selling at 49.9 is worse than paper's 50
  (audit as any).tick(t0 + 7000);
  (audit as any).tick(t0 + 31_000);
  const rows = db.all<any>('SELECT * FROM tape_audit ORDER BY position_id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'market entry');
  assert.ok(rows[0].slip_bps > 19 && rows[0].slip_bps < 21);
  assert.ok(Math.abs(rows[0].slip_r - 0.1) < 1e-9);
  assert.equal(rows[1].slip_bps, null);
  assert.equal(audit.summary(0).fills.find(f => f.kind === 'market entry')!.noPrints, 1);
});

test('decision 187: a resting limit records the volume at its price before price goes through, and its paper fill', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  eng.pending = [{ id: 9, symbol: 'CUSD', tf: '1h', side: 'long', at: t0, market: { tickSize: 0.01 }, limit: { price: 20 } }];
  (audit as any).tick(t0 + 100);
  audit.onTrade(trade('CUSD', 20.05, 4, t0 + 1000));
  audit.onTrade(trade('CUSD', 20, 6, t0 + 2000));
  audit.onTrade(trade('CUSD', 20, 9, t0 + 3000));
  audit.onTrade(trade('CUSD', 19.98, 1, t0 + 4000));    // through
  audit.onTrade(trade('CUSD', 20, 100, t0 + 5000));     // after through: not counted
  eng.positions.set(9, { entryPrice: 20, slOriginal: 19, tf: '1h' });
  eng.emit('order', { at: t0 + 60_000, positionId: 9, symbol: 'CUSD', side: 'buy', qty: 1, price: 20, reason: 'entry' });
  const [row] = db.all<any>('SELECT * FROM tape_audit');
  assert.equal(row.kind, 'resting limit');
  const x = JSON.parse(row.extra);
  assert.deepEqual([x.filled, x.touched, x.through, x.volBeforeThrough, x.touchToThroughSec], [true, true, true, 15, 2]);
  // a limit that lapses without a fill
  eng.pending = [{ id: 10, symbol: 'CUSD', tf: '1h', side: 'short', at: t0, market: { tickSize: 0.01 }, limit: { price: 25 } }];
  (audit as any).tick(t0 + 61_000);
  eng.pending = [];
  (audit as any).tick(t0 + 62_000);
  const lim = audit.summary(0).limits[0];
  assert.deepEqual([lim.n, lim.filled, lim.touched, lim.through], [2, 1, 1, 1]);
});

test('decision 187: prints that arrive on the tick the grace runs out are written once', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  eng.emit('order', { at: t0, positionId: 3, symbol: 'DUSD', side: 'buy', qty: 1, price: 5, reason: 'entry' });
  (audit as any).tick(t0 + 10_000);
  audit.onTrade(trade('DUSD', 5.01, 1, t0 + 29_000));
  (audit as any).tick(t0 + 31_000);
  (audit as any).tick(t0 + 32_000);
  const rows = db.all<any>('SELECT * FROM tape_audit');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].slip_bps > 19 && rows[0].slip_bps < 21);
});
