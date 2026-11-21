import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import { FeatureEnricher } from './enrich.ts';
import { attachEntryState, EntryStateRecorder, ENTRY_STATE_KEEP_MS, trendInAtr } from './entryState.ts';
import type { GlobalContext } from '../context/collector.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);

/** n bars ending at `endOpen`, closing at base * (1 + step) ** k: a steady climb (step > 0) or fall. */
function bars(n: number, tfMs: number, endOpen: number, base = 100, step = 0.002): Bar[] {
  return Array.from({ length: n }, (_, k) => {
    const c = base * (1 + step) ** k;
    return { time: endOpen - (n - 1 - k) * tfMs, open: c * 0.999, high: c * 1.004, low: c * 0.996, close: c, volume: 1000 + k };
  });
}
function store(map: Record<string, Bar[]>) {
  return {
    get(symbol: string, tf: string, opts: { to?: number; limit?: number }) {
      let b = map[`${symbol}:${tf}`] ?? [];
      if (opts.to !== undefined) b = b.filter((x) => x.time <= opts.to!);
      if (opts.limit !== undefined && b.length > opts.limit) b = b.slice(-opts.limit);
      return b;
    },
  };
}
const ctx = (over: Partial<GlobalContext> = {}, at = T0): GlobalContext => ({
  at, session: 'asia', bias: { BTC: { h4: -1, d1: 0 }, ETH: { h4: -1, d1: -1 } }, fundingSkewPct: 0.004,
  cohort: { wallets: 0, refreshedAt: null }, sources: { delta: 'ok', hyperliquid: 'ok', binance: 'ok' }, ...over,
});
function insertPosition(db: Db, o: { bt: number; symbol?: string; side?: string; entryAt: number; pnl?: number; fees?: number; risk?: number; status?: string }): number {
  const r = db.run(
    "INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,exit_reason,bt,fills) VALUES (?,?,?,?,?,?,1,0,1,100,?,?,?,?,?,?,?,'[]')",
    o.status ?? 'closed', 's', 'Scanner s', o.symbol ?? 'ETHUSD', '15m', o.side ?? 'long', o.entryAt, o.status === 'open' ? null : o.entryAt + H, o.pnl ?? 11, o.fees ?? 1, o.risk ?? 10, o.status === 'open' ? null : 'trail', o.bt);
  return Number(r.lastInsertRowid);
}
function setup(map: Record<string, Bar[]> = {}, context: () => GlobalContext | null = () => ctx()) {
  const db = new Db(':memory:');
  const candles = store(map);
  const recorder = new EntryStateRecorder({ db, enricher: new FeatureEnricher(db, candles), candles, context });
  return { db, recorder };
}
const entryAt = T0 + 400 * 900_000;
const ethBars = () => bars(300, 900_000, entryAt - 900_000, 100, 0.001);

test('a shadow position gets its features from the bars closed at the entry, and the market block with them', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars(), 'BTCUSD:1h': bars(300, H, entryAt - H), 'BTCUSD:4h': bars(300, 4 * H, entryAt - 4 * H) }, () => ctx({ at: entryAt - 30 * 60_000 }));
  const id = insertPosition(db, { bt: 2, entryAt });
  recorder.record(2, { id, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128, tp: [135] });
  const [row] = recorder.list({ book: 2 });
  assert.equal(row.featuresFrom, 'bars');
  assert.equal(row.missing, null);
  assert.ok(row.features && Number.isFinite(row.features.trend50) && row.features.side_long === 1, 'the engine\'s own feature set, side included');
  assert.equal(row.market.session, 'asia');
  assert.equal(row.market.btcBiasH4, -1);
  assert.equal(row.market.fundingSkewPct, 0.004);
  assert.equal(row.market.ctxAgeMin, 30, 'how stale the hourly context was at the entry');
  assert.ok((row.market.btcH1Trend50 ?? 0) > 0 && (row.market.btcH4Trend50 ?? 0) > 0, 'BTC climbing: above its EMA50');
  assert.ok((row.market.btcRet24h ?? 0) > 0);
});

test('an account position keeps the features the engine computed at entry', () => {
  const { db, recorder } = setup();
  const id = insertPosition(db, { bt: 0, entryAt });
  recorder.record(0, { id, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128, features: { side_long: 1, trend50: 1.5, copy_pilot: 1 } });
  const [row] = recorder.list({ book: 0 });
  assert.equal(row.featuresFrom, 'engine');
  assert.deepEqual(row.features, { side_long: 1, trend50: 1.5, copy_pilot: 1 });
  assert.deepEqual(recorder.featuresOf(id), row.features);
});

test('a position that cannot be measured is still recorded, with the reason, so coverage can be counted', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': bars(50, 900_000, entryAt - 900_000) });
  const few = insertPosition(db, { bt: 2, entryAt });
  recorder.record(2, { id: few, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128 });
  const noStop = insertPosition(db, { bt: 2, entryAt: entryAt + 1 });
  recorder.record(2, { id: noStop, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt: entryAt + 1, entryPrice: 130, sl: null });
  const odd = insertPosition(db, { bt: 2, entryAt: entryAt + 2 });
  recorder.record(2, { id: odd, symbol: 'ETHUSD', tf: '7m', side: 'long', entryAt: entryAt + 2, entryPrice: 130, sl: 128 });
  const rows = Object.fromEntries(recorder.list({ book: 2 }).map((r) => [r.positionId, r]));
  assert.equal(rows[few].featuresFrom, 'none');
  assert.equal(rows[few].missing, 'too few closed bars in the store');
  assert.equal(rows[few].features, null);
  assert.equal(rows[noStop].missing, 'no stop to measure from');
  assert.equal(rows[odd].missing, 'unknown timeframe');
  assert.equal(rows[few].market.session, 'asia', 'the market block is recorded even when the features are not');
  assert.equal(recorder.featuresOf(few), null);
});

test('recording is idempotent: the same position twice leaves one row and the first reading', () => {
  let n = 0;
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars() }, () => ctx({ fundingSkewPct: ++n }));
  const id = insertPosition(db, { bt: 2, entryAt });
  const p = { id, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128 };
  recorder.record(2, p);
  recorder.record(2, p);
  assert.equal(recorder.status().rows, 1);
  assert.equal(recorder.list({ book: 2 })[0].market.fundingSkewPct, 1);
  // a second recorder over the same database (a restart) does not overwrite either
  const again = new EntryStateRecorder({ db, enricher: new FeatureEnricher(db, store({})), candles: store({}), context: () => ctx({ fundingSkewPct: 99 }) });
  again.record(2, p);
  assert.equal(again.list({ book: 2 })[0].market.fundingSkewPct, 1);
});

test('missing context and untracked BTC bars are recorded as unknown, never as zero', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars() }, () => null);
  const id = insertPosition(db, { bt: 2, entryAt });
  recorder.record(2, { id, symbol: 'ETHUSD', tf: '15m', side: 'short', entryAt, entryPrice: 130, sl: 132 });
  const m = recorder.list({ book: 2 })[0].market;
  for (const k of ['ctxAt', 'ctxAgeMin', 'session', 'btcBiasH4', 'btcBiasD1', 'ethBiasH4', 'ethBiasD1', 'fundingSkewPct', 'btcH1Trend50', 'btcH4Trend50', 'btcRet24h'] as const) assert.equal(m[k], null, k);
  assert.equal(recorder.status().last24hWithoutContext, 1);
});

test('a failure in the recorder is counted and logged, never thrown into the book', () => {
  const db = new Db(':memory:');
  const boom = { compute: () => { throw new Error('bars store exploded'); } };
  const recorder = new EntryStateRecorder({ db, enricher: boom, candles: store({}), context: () => ctx() });
  assert.doesNotThrow(() => recorder.record(2, { id: 1, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128 }));
  assert.equal(recorder.status().failed, 1);
  assert.match(recorder.status().lastError ?? '', /exploded/);
  assert.equal(recorder.status().rows, 0);
  const throwingCtx = new EntryStateRecorder({ db, enricher: { compute: () => null }, candles: store({}), context: () => { throw new Error('no context'); } });
  assert.doesNotThrow(() => throwingCtx.record(2, { id: 2, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt, entryPrice: 130, sl: 128 }));
  assert.equal(throwingCtx.status().rows, 1, 'a context failure is a recorded unknown, not a lost row');
});

test('the listing joins the outcome in net R, and filters by book, time, market and side', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars() });
  const mk = (o: Parameters<typeof insertPosition>[1], side: string) => {
    const id = insertPosition(db, o);
    recorder.record(o.bt, { id, symbol: o.symbol ?? 'ETHUSD', tf: '15m', side, entryAt: o.entryAt, entryPrice: 130, sl: 128 });
    return id;
  };
  const win = mk({ bt: 2, entryAt, pnl: 16, fees: 1, risk: 10 }, 'long');
  mk({ bt: 2, entryAt: entryAt + 1000, symbol: 'SOLUSD', pnl: -9, fees: 1, risk: 10 }, 'short');
  const open = mk({ bt: 2, entryAt: entryAt + 2000, status: 'open' }, 'long');
  mk({ bt: 0, entryAt: entryAt + 3000 }, 'long');
  const all = recorder.list({ book: 2 });
  assert.equal(all.length, 3);
  assert.equal(all.find((r) => r.positionId === win)?.r, 1.5);
  assert.equal(all.find((r) => r.positionId === open)?.r, null, 'no R for a trade still open');
  assert.equal(all.find((r) => r.positionId === open)?.exitReason, null);
  assert.deepEqual(all.map((r) => r.entryAt), [entryAt + 2000, entryAt + 1000, entryAt], 'newest first');
  assert.equal(recorder.list({ book: 0 }).length, 1);
  assert.equal(recorder.list({ book: 2, symbol: 'SOLUSD' }).length, 1);
  assert.equal(recorder.list({ book: 2, side: 'long' }).length, 2);
  assert.equal(recorder.list({ book: 2, from: entryAt + 500, to: entryAt + 1500 }).length, 1);
  assert.equal(recorder.list({ book: 2, limit: 1 }).length, 1);
});

test('both books are attached, and only an opened position is recorded', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars() });
  const paper = Object.assign(new EventEmitter(), { book: 0 }), shadow = Object.assign(new EventEmitter(), { book: 2 });
  attachEntryState([paper, shadow], recorder);
  const a = insertPosition(db, { bt: 0, entryAt }), b = insertPosition(db, { bt: 2, entryAt: entryAt + 1 });
  const pos = (id: number, at: number) => ({ id, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt: at, entryPrice: 130, sl: 128 });
  paper.emit('position', { type: 'updated', position: pos(a, entryAt) });
  paper.emit('position', { type: 'closed', position: pos(a, entryAt) });
  assert.equal(recorder.status().rows, 0, 'updates and closes record nothing');
  paper.emit('position', { type: 'opened', position: pos(a, entryAt) });
  shadow.emit('position', { type: 'opened', position: pos(b, entryAt + 1) });
  shadow.emit('position', { type: 'opened' });
  assert.equal(recorder.list({ book: 0 }).length, 1);
  assert.equal(recorder.list({ book: 2 }).length, 1);
});

test('rows older than the retention are pruned (on the first record, then every few hours) and newer ones stay', () => {
  const { db, recorder } = setup({ 'ETHUSD:15m': ethBars() });
  const old = insertPosition(db, { bt: 2, entryAt: Date.now() - ENTRY_STATE_KEEP_MS - 1000 });
  const fresh = insertPosition(db, { bt: 2, entryAt: Date.now() - 1000 });
  recorder.record(2, { id: fresh, symbol: 'ETHUSD', tf: '15m', side: 'long', entryAt: Date.now() - 1000, entryPrice: 130, sl: 128 });
  // a row that is already past the retention, put in directly
  db.run("INSERT INTO entry_state(position_id,book,symbol,tf,side,entry_at,recorded_at,features,features_from,missing,market,version) VALUES (?,?,?,?,?,?,?,NULL,'none','x','{}',1)", old, 2, 'ETHUSD', '15m', 'long', Date.now() - ENTRY_STATE_KEEP_MS - 1000, Date.now());
  assert.equal(recorder.status().rows, 2);
  assert.equal(recorder.prune(), 1);
  assert.deepEqual(recorder.list({ book: 2 }).map((r) => r.positionId), [fresh]);
  assert.equal(recorder.prune(), 0, 'nothing more to remove');
});

test('BTC trend in ATRs needs enough closed bars and has the sign of the move', () => {
  assert.equal(trendInAtr(bars(40, H, T0)), null);
  assert.ok((trendInAtr(bars(300, H, T0, 100, 0.002)) ?? 0) > 0, 'a climb sits above its EMA50');
  assert.ok((trendInAtr(bars(300, H, T0, 100, -0.002)) ?? 0) < 0, 'a fall sits below it');
});
