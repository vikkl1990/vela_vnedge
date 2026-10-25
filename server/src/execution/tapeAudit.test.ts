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

test('decision 187: a market entry waits for prints, and a fill with none in 2 min is recorded as such', () => {
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
  assert.equal(db.all('SELECT * FROM tape_audit').length, 1, 'the print-less fill still waits at 31 s');
  (audit as any).tick(t0 + 121_000);
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
  audit.onTrade(trade('DUSD', 5.01, 1, t0 + 5_000));
  (audit as any).tick(t0 + 119_500);
  (audit as any).tick(t0 + 120_000);
  (audit as any).tick(t0 + 121_000);
  const rows = db.all<any>('SELECT * FROM tape_audit');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].slip_bps > 19 && rows[0].slip_bps < 21);
});

test('decision 187: a first print more than 10 s after the fill is kept but left out of the slippage averages', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 2 }]);
  const t0 = 1_800_000_000_000;
  eng.emit('order', { at: t0, positionId: 1, symbol: 'EUSD', side: 'buy', qty: 1, price: 10, reason: 'entry' });
  eng.emit('order', { at: t0, positionId: 2, symbol: 'FUSD', side: 'buy', qty: 1, price: 10, reason: 'entry' });
  audit.onTrade(trade('EUSD', 10.01, 1, t0 + 1_000));    // in the window: 10 bps
  audit.onTrade(trade('FUSD', 10.5, 1, t0 + 60_000));    // a minute later: drift
  (audit as any).tick(t0 + 61_000);
  const rows = db.all<any>('SELECT * FROM tape_audit ORDER BY position_id');
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1].extra).lateSec, 60);
  const f = audit.summary(0).fills[0];
  assert.deepEqual([f.n, f.late, f.noPrints], [2, 1, 0]);
  assert.ok(Math.abs(f.meanBps! - 10) < 1e-6);
});

test('decision 190: a limit placed and filled between two ticks is still recorded as a resting limit, with its exact placement', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  const pe = { id: 11, symbol: 'GUSD', tf: '1h', side: 'long', at: t0, market: { tickSize: 0.01 }, limit: { price: 20, expiresAt: t0 + 7_200_000 } };
  eng.emit('pending', { type: 'placed', entry: pe });
  audit.onTrade(trade('GUSD', 19.99, 2, t0 + 500));
  eng.emit('order', { at: t0 + 600, positionId: 11, symbol: 'GUSD', side: 'buy', qty: 1, price: 20, reason: 'entry' });
  const rows = db.all<any>('SELECT * FROM tape_audit');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'resting limit');
  const x = JSON.parse(rows[0].extra);
  assert.deepEqual([x.outcome, x.placedAt, x.expiresAt, x.throughAt], ['filled', t0, t0 + 7_200_000, t0 + 500]);
  const lc = db.get<any>('SELECT * FROM limit_lifecycle WHERE position_id=11');
  assert.deepEqual([lc.outcome, lc.placed_at, lc.through_at, lc.ended_at], ['filled', t0, t0 + 500, t0 + 600]);
});

test('decision 190: an unfinished limit resumes after a restart and is closed by its cancel event, marked as recovered', () => {
  const db = new Db(':memory:');
  const t0 = 1_800_000_000_000;
  const first = fakeEngine();
  new TapeAudit(db, [{ engine: first, book: 2 }]);
  first.emit('pending', { type: 'placed', entry: { id: 12, symbol: 'HUSD', tf: '4h', side: 'short', at: t0, market: { tickSize: 0.1 }, limit: { price: 50, expiresAt: t0 + 28_800_000 } } });
  const second = fakeEngine();
  second.pending = [{ id: 12, symbol: 'HUSD', tf: '4h', side: 'short', at: t0, market: { tickSize: 0.1 }, limit: { price: 50, expiresAt: t0 + 28_800_000 } }];
  new TapeAudit(db, [{ engine: second, book: 2 }]);
  second.emit('pending', { type: 'cancelled', id: 12, reason: 'no fill: price did not come back' });
  const x = JSON.parse(db.get<any>('SELECT extra FROM tape_audit').extra);
  assert.deepEqual([x.outcome, x.recovered, x.placedAt], ['cancelled', true, t0]);
  assert.equal(db.get<any>('SELECT restarts FROM limit_lifecycle WHERE position_id=12').restarts, 1);
});

test('decision 190: as wired, the print that fills a tape limit is counted as the limit\'s through', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const { DEFAULT_CONFIG } = await import('../config.ts');
  const { PaperEngine } = await import('../paper/engine.ts');
  const { wireRealtime } = await import('./wiring.ts');
  const db = new Db(':memory:');
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, { slippageBps: 0, feeRatePct: 0.05, makerFeeRatePct: 0.02, liquidation: false, latencyMs: 0, minRiskFeeRatio: 0, fillSource: 'tape', limitFill: 'through', limitEntry: { enabled: true, tfs: ['4h'], atr: 0.3, bars: 2, books: ['account', 'shadow'] } });
  const paper = new PaperEngine(db, () => cfg);
  const shadow = new PaperEngine(db, () => cfg, { book: 2 });
  const audit = new TapeAudit(db, [{ engine: paper, book: 0 }, { engine: shadow, book: 2 }]);
  const feed = new EE();
  wireRealtime({ feed, paper, shadow, rest: { products: async () => new Map([['ETHUSD', { symbol: 'ETHUSD', trading_status: 'operational' }]]) }, tapeAudit: audit, marks: { onWsMark() {}, onWsFunding() {}, dueFunding: () => [], executable: () => null, spreadPct: () => null }, risk: { tick() {} } } as any);
  feed.emit('status', { connected: true });
  feed.emit('system_status', { status: 'live', event: 'snapshot', timestamp: Date.now() * 1000 });
  feed.emit('product_updates', { product: { symbol: 'ETHUSD', trading_status: 'operational' }, timestamp: Date.now() * 1000 });
  const at = Date.now() - 1000;
  const d = paper.onEntry({ kind: 'entry', side: 'long', price: 100, tp: [], label: 'entry', message: '', source: 'alert', barTime: at - 4 * 3600_000, barIndex: 0 } as any,
    { scannerId: 's', scannerName: 's', symbol: 'ETHUSD', tf: '4h', market: { tickSize: 0.01, contractValue: 1 }, refPrice: 100, at, signalId: null, exitMode: 'both', atr: 2 } as any);
  assert.equal(d.action, 'pending');
  feed.emit('trade', { symbol: 'ETHUSD', price: 99.3, qty: 1, timeMs: at + 500, aggressor: 'sell' });
  assert.equal(paper.openPositions().length, 1, 'the print filled the limit');
  const x = JSON.parse(db.get<any>("SELECT extra FROM tape_audit WHERE kind='resting limit'").extra);
  assert.deepEqual([x.filled, x.through, x.throughAt], [true, true, at + 500]);
});

test('decision 194: a stop filled on catching up after a restart is kept but marked unwatched and left out of the averages', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  eng.positions.set(5, { entryPrice: 0.0377, slOriginal: 0.0361, tf: '15m' });
  // the process has just started: its first print for the symbol comes after the stop was filled
  eng.emit('order', { at: t0, positionId: 5, symbol: 'AKEUSD', side: 'sell', qty: 1, price: 0.03609, reason: 'sl' });
  audit.onTrade(trade('AKEUSD', 0.03077, 5, t0 + 500));
  (audit as any).tick(t0 + 5000);
  const row = db.get<any>('SELECT * FROM tape_audit');
  assert.equal(JSON.parse(row.extra).unobserved, true);
  const f = audit.summary(0).fills[0];
  assert.deepEqual([f.n, f.unobserved, f.medianBps], [1, 1, null]);
});

test('decision 201: funding is not audited against the tape, and old funding rows leave the summary', () => {
  const db = new Db(':memory:');
  const eng = fakeEngine();
  const audit = new TapeAudit(db, [{ engine: eng, book: 0 }]);
  const t0 = 1_800_000_000_000;
  eng.emit('order', { at: t0, positionId: 1, symbol: 'XUSD', side: 'sell', qty: 1, price: 0, reason: 'funding' });
  audit.onTrade(trade('XUSD', 100, 1, t0 + 500));
  (audit as any).tick(t0 + 200_000);
  assert.equal(db.all('SELECT * FROM tape_audit').length, 0);
  db.run("INSERT INTO tape_audit(at, book, symbol, kind) VALUES (?, 0, 'XUSD', 'market exit (funding)')", t0);
  assert.equal(audit.summary(0).fills.length, 0);
});
