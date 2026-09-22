import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { IncubatorStore } from './store.ts';
import { demoteVerdict, gateVerdict, overlapPct, pairStats, sliceOf, type TradeR } from './gate.ts';
import { approve, evaluate, recordScreen, reject, syncLive, type ScreenResult } from './cycle.ts';

const DAY = 86400_000;
const T0 = Date.UTC(2026, 0, 5);
const gate = DEFAULT_CONFIG.incubator.gate;

/** n trades spread over `days`, alternating wins of `win` R with losses of −1R so the PF is controllable. */
function series(n: number, days: number, win: number, lossEvery = 2, start = T0): TradeR[] {
  return Array.from({ length: n }, (_, i) => {
    const at = start + Math.floor((i / n) * days * DAY);
    return { entryAt: at, exitAt: at + 3600_000, r: i % lossEvery === 0 ? -1 : win, side: 'long' };
  });
}

test('the gate proposes only a full, profitable, consistent sample', () => {
  const good = pairStats(series(40, 20, 2), T0, T0 + 20 * DAY);        // PF 2, 20 days
  assert.equal(gateVerdict(good, gate).decision, 'propose');
  const young = pairStats(series(40, 5, 2), T0, T0 + 5 * DAY);         // enough trades, too few days
  assert.equal(gateVerdict(young, gate).decision, 'brewing');
  const thin = pairStats(series(10, 20, 2), T0, T0 + 20 * DAY);        // too few trades
  assert.equal(gateVerdict(thin, gate).decision, 'brewing');
  const bad = pairStats(series(40, 20, 0.5), T0, T0 + 20 * DAY);       // PF 0.5 on a full sample
  assert.equal(gateVerdict(bad, gate).decision, 'retire');
  const stale = pairStats(series(12, 50, 2), T0, T0 + 50 * DAY);       // never reached a full sample
  assert.equal(gateVerdict(stale, gate).decision, 'retire');
  // a duplicate of a live pair is not proposed however good it is
  assert.equal(gateVerdict(good, gate, 80).decision, 'brewing');
});

test('stats count only trades since the stage began, in R', () => {
  const t = [...series(10, 5, 2, 2, T0 - 10 * DAY), ...series(10, 5, 2, 2, T0)];
  assert.equal(pairStats(t, T0, T0 + 5 * DAY).trades, 10);
});

test('demotion needs a full recent window below the floor', () => {
  const d = DEFAULT_CONFIG.incubator.demote;
  assert.equal(demoteVerdict(series(40, 20, 0.5), d).demote, true);
  assert.equal(demoteVerdict(series(40, 20, 2), d).demote, false);
  assert.equal(demoteVerdict(series(10, 20, 0.5), d).demote, false, 'ten trades is not evidence');
});

test('overlap counts same-side entries near a live entry', () => {
  const s = series(10, 5, 2);
  assert.equal(overlapPct(s, s.map(x => ({ ...x }))), 100);
  assert.equal(overlapPct(s, s.map(x => ({ ...x, side: 'short' }))), 0);
  assert.equal(overlapPct(s, []), 0);
});

test('slices are stable and cover every slice', () => {
  const ids = Array.from({ length: 700 }, (_, i) => `script-${i}`);
  assert.equal(sliceOf('abc', 7), sliceOf('abc', 7));
  assert.equal(new Set(ids.map(x => sliceOf(x, 7))).size, 7);
});

function world() {
  const db = new Db(':memory:');
  const store = new IncubatorStore(db);
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = { live1: { enabled: true, symbols: ['BTCUSD'], timeframes: null, exitMode: 'both' } as any };
  const insertTrade = (book: number, scanner: string, symbol: string, t: TradeR) => db.run(
    "INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, exit_at, realized_pnl, fees, risk_amount, bt) VALUES ('closed',?,?,?,?,?,1,0,1,100,?,?,?,0,10,?)",
    scanner, scanner, symbol, '15m', t.side ?? 'long', t.entryAt, t.exitAt, t.r * 10, book);
  const screen = (over: Partial<ScreenResult> = {}): ScreenResult => ({ pass: true, at: T0, trades: 40, profitFactor: 1.6, netPnl: 100, netAtStress: 50, windowsUp: 6, winRatePct: 50, avgR: 0.2, bars: 4000, days: 41, ...over });
  return { db, store, cfg, insertTrade, screen };
}

test('lifecycle: screen → shadow → proposed → approved into the config', () => {
  const { store, cfg, insertTrade, screen } = world();
  syncLive(store, cfg, T0);
  assert.equal(store.list(['live']).length, 1);

  assert.equal(recordScreen(store, { scannerId: 'cand', symbol: 'ETHUSD', tf: '15m' }, screen(), cfg.incubator, T0), 'new');
  assert.equal(recordScreen(store, { scannerId: 'weak', symbol: 'ETHUSD', tf: '15m' }, screen({ pass: false }), cfg.incubator, T0), 'skipped');
  const r1 = evaluate(store, cfg, T0);
  assert.deepEqual(r1.admitted, ['cand ETHUSD 15m']);

  // shadow trades after admission, then the gate proposes it
  for (const t of series(40, 20, 2, 2, T0 + 1000)) insertTrade(2, 'cand', 'ETHUSD', t);
  const r2 = evaluate(store, cfg, T0 + 21 * DAY);
  assert.deepEqual(r2.proposed, ['cand ETHUSD 15m']);
  const p = store.find('cand', 'ETHUSD', '15m')!;
  assert.equal(p.stage, 'proposed');
  assert.equal(p.since, T0, 'proposal keeps the evidence window');

  const patches: any[] = [];
  const out = approve(store, cfg, p.id, 'admin', (id, patch) => patches.push({ id, patch }), T0 + 21 * DAY);
  assert.equal(out.stage, 'live');
  assert.deepEqual(patches, [{ id: 'cand', patch: { enabled: true, hidden: false, symbols: ['ETHUSD'], timeframes: ['15m'] } }]);
  assert.ok(store.events(10).some(e => e.to === 'live' && e.actor === 'admin'));
});

test('approval refuses past the weekly limit and when the fleet is full', () => {
  const { store, cfg, screen } = world();
  cfg.incubator.promote.maxPerWeek = 1;
  for (const s of ['a', 'b']) { recordScreen(store, { scannerId: s, symbol: 'SOLUSD', tf: '15m' }, screen(), cfg.incubator, T0); store.move({ scannerId: s, symbol: 'SOLUSD', tf: '15m' }, 'proposed', 'test', null, null, T0); }
  const [a, b] = ['a', 'b'].map(s => store.find(s, 'SOLUSD', '15m')!);
  approve(store, cfg, a.id, 'admin', () => {}, T0);
  assert.throws(() => approve(store, cfg, b.id, 'admin', () => {}, T0 + DAY), /weekly promotion limit/);
  cfg.incubator.promote.maxPerWeek = 5; cfg.incubator.promote.maxFleet = 1;
  assert.throws(() => approve(store, cfg, b.id, 'admin', () => {}, T0 + DAY), /fleet is full/);
});

test('reject retires a proposal, and cooldown keeps it out of the screen', () => {
  const { store, cfg, screen } = world();
  const k = { scannerId: 'c', symbol: 'XRPUSD', tf: '15m' };
  recordScreen(store, k, screen(), cfg.incubator, T0);
  store.move(k, 'proposed', 'test', null, null, T0);
  reject(store, store.find(k.scannerId, k.symbol, k.tf)!.id, 'admin', null, T0);
  assert.equal(store.find(k.scannerId, k.symbol, k.tf)!.stage, 'retired');
  assert.equal(recordScreen(store, k, screen(), cfg.incubator, T0 + 5 * DAY), 'cooldown');
  assert.equal(recordScreen(store, k, screen(), cfg.incubator, T0 + 31 * DAY), 'new');
});

test('a losing live pair is proposed for demotion; approving it removes the market and returns it to shadow', () => {
  const { store, cfg, insertTrade } = world();
  syncLive(store, cfg, T0);
  for (const t of series(40, 20, 0.5, 2, T0 + 1000)) insertTrade(0, 'live1', 'BTCUSD', t);
  const rep = evaluate(store, cfg, T0 + 21 * DAY);
  assert.deepEqual(rep.demoteProposed, ['live1 BTCUSD 15m']);
  const patches: any[] = [];
  const r = approve(store, cfg, store.find('live1', 'BTCUSD', '15m')!.id, 'admin', (id, patch) => patches.push({ id, patch }), T0 + 21 * DAY);
  assert.equal(r.stage, 'shadow');
  assert.deepEqual(patches, [{ id: 'live1', patch: { enabled: false } }]);
});

test('the shadow book never touches the live account', () => {
  const { db, cfg } = world();
  const live = new PaperEngine(db, () => cfg);
  const shadow = new PaperEngine(db, () => cfg, { book: 2 });
  db.run("INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, exit_at, realized_pnl, fees, risk_amount, bt) VALUES ('closed','s','s','BTCUSD','15m','long',1,0,1,100,1,2,-50,0,10,2)");
  assert.equal(live.closedPositions().length, 0);
  assert.equal(shadow.closedPositions().length, 1);
  assert.equal(live.equity(), cfg.paper.initialEquity);
});
