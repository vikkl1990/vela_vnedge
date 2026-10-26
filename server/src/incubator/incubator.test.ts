import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { ConfigStore, DEFAULT_CONFIG, type AppConfig } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { IncubatorStore } from './store.ts';
import { cohortStats, cohortVerdict, demoteVerdict, gateVerdict, overlapPct, pairStats, sliceOf, type TradeR, deliveryVerdict, type PairStats } from './gate.ts';
import { approve, demote, evaluate, recordScreen, reject, syncLive, type ScreenResult, livePairs, admitOnly, candidateBlockers, screenVerdict, screenTf, diversityRefusal, preferScript, cohortComparison, type VariantResult, atrNeededPct, tooQuietForTf, gateFor } from './cycle.ts';

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
  store.marketStaleMs = Infinity;   // these scenarios set the gate's verdicts once and walk the clock for weeks
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
  assert.deepEqual(patches, [{ id: 'cand', patch: { enabled: true, hidden: false, pairs: [{ symbol: 'ETHUSD', tf: '15m' }] } }]);
  assert.ok(store.events(10).some(e => e.to === 'live' && e.actor === 'admin'));
});

test('approval refuses past the weekly limit and when the fleet is full', () => {
  const { store, cfg, screen, insertTrade } = world();
  cfg.incubator.promote.maxPerWeek = 1;
  for (const s of ['a', 'b']) { recordScreen(store, { scannerId: s, symbol: 'SOLUSD', tf: '15m' }, screen(), cfg.incubator, T0); store.move({ scannerId: s, symbol: 'SOLUSD', tf: '15m' }, 'proposed', 'test', null, null, T0); }
  const [a, b] = ['a', 'b'].map(s => store.find(s, 'SOLUSD', '15m')!);
  for (const t of series(40,20,2,2,T0+1000)) insertTrade(2,'a','SOLUSD',t);
  approve(store, cfg, a.id, 'admin', () => {}, T0 + 21 * DAY);
  assert.throws(() => approve(store, cfg, b.id, 'admin', () => {}, T0 + 22 * DAY), /weekly promotion limit/);
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

test('the operator can demote a live pair without a gate proposal; the market leaves the scanner and the pair returns to shadow', () => {
  const { store, cfg } = world();
  syncLive(store, cfg, T0);
  const patches: any[] = [];
  const r = demote(store, cfg, store.find('live1', 'BTCUSD', '15m')!.id, 'admin', (id, patch) => patches.push({ id, patch }), 'misread script', T0 + DAY);
  assert.equal(r.stage, 'shadow');
  assert.deepEqual(patches, [{ id: 'live1', patch: { enabled: false } }]);
  assert.throws(() => demote(store, cfg, r.id, 'admin', () => {}, null, T0 + DAY), /nothing to demote/);
});

test('the shadow book does not compound: one lucky trade cannot inflate the next hundred', () => {
  const { db, cfg } = world();
  const live = new PaperEngine(db, () => cfg);
  const shadow = new PaperEngine(db, () => cfg, { book: 2 });
  const before = { live: live.equity(), shadow: shadow.equity() };
  const win = (bt: number) => db.run(
    "INSERT INTO positions(status, scanner_id, scanner_name, symbol, tf, side, qty, qty_open, contract_value, entry_price, entry_at, exit_at, realized_pnl, fees, risk_amount, bt) VALUES ('closed','s','s','BTCUSD','15m','long',1,0,1,100,1,2,?,0,10,?)",
    5_000, bt);
  win(0); win(2);
  const after = { live: new PaperEngine(db, () => cfg).equity(), shadow: new PaperEngine(db, () => cfg, { book: 2 }).equity() };
  assert.equal(after.live, before.live + 5_000, 'the live account compounds');
  assert.equal(after.shadow, before.shadow, 'the shadow purse is fixed, so R means the same thing on day thirty');
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

/** Five markets of one scanner, each with `n` trades over `days`. */
function cohort(symbols: string[], n: number, days: number, win: number, since = T0) {
  return symbols.map(symbol => ({ symbol, since, trades: series(n, days, win, 2, since + 1000) }));
}

test('pooling a scanner across its markets reaches a verdict that no single market can', () => {
  const g = DEFAULT_CONFIG.incubator.gate;
  const members = cohort(['a', 'b', 'c', 'd', 'e'], 8, 20, 2);
  const now = T0 + 21 * DAY;
  // eight trades on one market is not a sample, however good it looks
  assert.equal(gateVerdict(pairStats(members[0].trades, T0, now), g).decision, 'brewing');
  const c = cohortStats(members, now, g.minMarketTrades);
  assert.equal(c.trades, 40);
  assert.equal(c.markets, 5);
  assert.equal(cohortVerdict(c, g).decision, 'propose');
});

test('a cohort carried by one market is not promoted', () => {
  const g = DEFAULT_CONFIG.incubator.gate;
  const now = T0 + 21 * DAY;
  const members = [
    { symbol: 'winner', since: T0, trades: series(24, 20, 6, 2, T0 + 1000) },
    ...cohort(['b', 'c', 'd', 'e'], 8, 20, 0.6),
  ];
  const c = cohortStats(members, now, g.minMarketTrades);
  assert.ok((c.pfR ?? 0) > g.minPfR, 'pooled profit factor passes');
  assert.equal(c.positiveMarkets, 1);
  assert.equal(cohortVerdict(c, g).decision, 'brewing');
  assert.match(cohortVerdict(c, g).reasons.join(' '), /1\/5 markets positive/);
});

test('a cohort that fails on a full pooled sample retires together', () => {
  const { store, cfg, insertTrade, screen } = world();
  const markets = ['m1', 'm2', 'm3', 'm4', 'm5'];
  for (const m of markets) { recordScreen(store, { scannerId: 'dud', symbol: m, tf: '15m' }, screen(), cfg.incubator, T0); }
  assert.equal(evaluate(store, cfg, T0).admitted.length, 5);
  for (const m of markets) for (const t of series(8, 20, 0.4, 2, T0 + 1000)) insertTrade(2, 'dud', m, t);
  const rep = evaluate(store, cfg, T0 + 21 * DAY);
  assert.equal(rep.retired.length, 5, 'the whole cohort goes, not one market at a time');
  assert.equal(store.list(['shadow', 'proposed']).length, 0);
});

test('slots are filled by cohort, and running cohorts are topped up first', () => {
  const { store, cfg, screen } = world();
  cfg.incubator.maxShadow = 6;
  for (const m of ['x1', 'x2']) recordScreen(store, { scannerId: 'x', symbol: m, tf: '15m' }, screen(), cfg.incubator, T0);
  assert.equal(evaluate(store, cfg, T0).admitted.length, 2);

  // three more of x, and a rival scanner with a better screen: x is topped up to five first
  for (const m of ['x3', 'x4', 'x5']) recordScreen(store, { scannerId: 'x', symbol: m, tf: '15m' }, screen(), cfg.incubator, T0 + DAY);
  for (const m of ['y1', 'y2', 'y3']) recordScreen(store, { scannerId: 'y', symbol: m, tf: '15m' }, screen({ profitFactor: 3, trades: 80 }), cfg.incubator, T0 + DAY);
  const rep = evaluate(store, cfg, T0 + 2 * DAY);
  assert.deepEqual(rep.admitted.sort(), ['x x3 15m', 'x x4 15m', 'x x5 15m']);
  assert.equal(rep.free, 1, 'the last slot stays free: y cannot fill a cohort with it');
  assert.equal(store.list(['shadow']).filter(r => r.scannerId === 'x').length, 5);
});

test('gate.pool "pair" keeps the original one-market-at-a-time judgement', () => {
  const { store, cfg, insertTrade, screen } = world();
  cfg.incubator.gate.pool = 'pair';
  for (const m of ['p1', 'p2']) recordScreen(store, { scannerId: 'p', symbol: m, tf: '15m' }, screen(), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  for (const t of series(40, 20, 2, 2, T0 + 1000)) insertTrade(2, 'p', 'p1', t);
  for (const t of series(8, 20, 2, 2, T0 + 1000)) insertTrade(2, 'p', 'p2', t);
  const rep = evaluate(store, cfg, T0 + 21 * DAY);
  assert.deepEqual(rep.proposed, ['p p1 15m'], 'only the market with its own full sample');
});

test('cohort size and the retirement clock follow the timeframe', () => {
  const { store, cfg, screen } = world();
  cfg.incubator.maxShadow = 30;
  const markets = Array.from({ length: 14 }, (_, i) => `m${i}`);
  for (const m of markets) recordScreen(store, { scannerId: 'slow', symbol: m, tf: '4h' }, screen(), cfg.incubator, T0);
  assert.equal(evaluate(store, cfg, T0).admitted.length, 12, '4h trades rarely: twelve markets, not five');

  // at 4h a cohort gets 90 days, not 45, before it is retired unproven
  const thin = cohortStats(cohort(markets.slice(0, 12), 1, 50, 2), T0 + 50 * DAY, cfg.incubator.gate.minMarketTrades);
  assert.equal(cohortVerdict(thin, { ...cfg.incubator.gate, maxDays: cfg.incubator.gate.maxDaysByTf['4h'] }).decision, 'brewing');
  assert.equal(cohortVerdict(thin, cfg.incubator.gate).decision, 'retire', 'the 15m clock would have retired it');
});

test('pairs-aware fleet: a scanner with explicit pairs is promoted and demoted per (market, timeframe)', () => {
  const { store, cfg } = world();
  cfg.scanners.live1 = { enabled: true, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'BTCUSD', tf: '1h' }, { symbol: 'ETHUSD', tf: '4h' }] } as any;
  const s = syncLive(store, cfg, T0);
  assert.equal(s.added, 2);
  assert.deepEqual(store.list(['live']).map(r => `${r.symbol} ${r.tf}`).sort(), ['BTCUSD 1h', 'ETHUSD 4h'], 'live rows carry each pair\'s own timeframe');
  const patches: any[] = [];
  const r = demote(store, cfg, store.find('live1', 'BTCUSD', '1h')!.id, 'admin', (id, patch) => patches.push({ id, patch }), null, T0 + DAY);
  assert.equal(r.stage, 'shadow');
  assert.deepEqual(patches as unknown[], [{ id: 'live1', patch: { pairs: [{ symbol: 'ETHUSD', tf: '4h' }] } }], 'only that pair leaves; the other stays');
  cfg.scanners.live1.pairs = [{ symbol: 'ETHUSD', tf: '4h' }];
  const last = demote(store, cfg, store.find('live1', 'ETHUSD', '4h')!.id, 'admin', (id, patch) => patches.push({ id, patch }), null, T0 + DAY);
  assert.equal(last.stage, 'shadow'); assert.deepEqual(patches.at(-1) as unknown, { id: 'live1', patch: { enabled: false } }, 'the last pair switches the scanner off');
});

test('decision 79: an enabled scanner without pairs is not in the fleet, and a save above the fleet cap is refused', () => {
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  cfg.scanners = { bare: { enabled: true, symbols: null, timeframes: null, exitMode: 'both' } as any, paired: { enabled: true, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'BTCUSD', tf: '1h' }] } as any };
  assert.deepEqual(livePairs(cfg).map(p => p.scannerId), ['paired'], 'no fallback to the global symbol list');
  const store = new ConfigStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-cap-')), 'config.json'));
  store.update({ incubator: { ...store.get().incubator, promote: { ...store.get().incubator.promote, maxFleet: 3 } } } as any);
  store.setScanner('a', { enabled: true, pairs: [{ symbol: 'BTCUSD', tf: '1h' }, { symbol: 'ETHUSD', tf: '1h' }] });
  assert.throws(() => store.setScanner('b', { enabled: true, pairs: [{ symbol: 'SOLUSD', tf: '1h' }, { symbol: 'XRPUSD', tf: '1h' }] }), /above incubator.promote.maxFleet \(3\)/);
  assert.equal(store.get().scanners.b, undefined, 'the refused save changed nothing');
  store.setScanner('b', { enabled: true, pairs: [{ symbol: 'SOLUSD', tf: '1h' }] });
  assert.equal(livePairs(store.get()).length, 3);
});

test('decision 88: the screen judges the pass on the training part and demands a positive holdout it never looked at', () => {
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  const inc = { ...cfg.incubator, screen: { ...cfg.incubator.screen, minTrades: 10, minWindowsUp: 3, holdoutShare: 0.3, minHoldoutTrades: 5 } };
  const bars = Array.from({ length: 1000 }, (_, i) => ({ time: T0 + i * 900_000 }));
  const mk = (i: number, pnl: number) => ({ entryAt: T0 + i * 900_000, pnl, rMultiple: pnl / 10 });
  // 40 trades evenly spread, winners outnumber losers everywhere: passes, and the holdout agrees
  const good = Array.from({ length: 40 }, (_, k) => mk(k * 24 + 5, k % 3 === 2 ? -10 : 15));
  const a = screenVerdict(good, good.map(t => ({ ...t, pnl: t.pnl - 1 })), bars, inc, T0);
  assert.equal(a.pass, true); assert.ok(a.holdoutTrades! >= 5 && a.holdoutPass === true, JSON.stringify(a));
  assert.ok(a.trades < 40, 'the pass statistics count the training trades only');
  // the same training record with a losing holdout: the pass is withdrawn
  const bad = good.map(t => (t.entryAt >= bars[700].time ? { ...t, pnl: -12, rMultiple: -1.2 } : t));
  const b = screenVerdict(bad, bad.map(t => ({ ...t, pnl: t.pnl - 1 })), bars, inc, T0);
  assert.equal(b.holdoutPass, false); assert.equal(b.pass, false, 'a cell cannot pass on the part of history it was picked on');
  assert.equal(b.trades, a.trades, 'the training statistics are identical: only the holdout differs');
});

test('decision 88: a script that fires on more than a tenth of all bars cannot pass the screen', () => {
  const cfg: AppConfig = structuredClone(DEFAULT_CONFIG);
  const inc = { ...cfg.incubator, screen: { ...cfg.incubator.screen, minTrades: 10, minWindowsUp: 3, holdoutShare: 0.3, minHoldoutTrades: 5 } };
  const bars = Array.from({ length: 1000 }, (_, i) => ({ time: T0 + i * 900_000 }));
  const good = Array.from({ length: 40 }, (_, k) => ({ entryAt: T0 + (k * 24 + 5) * 900_000, pnl: k % 3 === 2 ? -10 : 15, rMultiple: (k % 3 === 2 ? -10 : 15) / 10 }));
  const stressed = good.map(t => ({ ...t, pnl: t.pnl - 1 }));
  assert.equal(screenVerdict(good, stressed, bars, inc, T0, 60).pass, true, 'sixty entries on a thousand bars is a signal');
  const dense = screenVerdict(good, stressed, bars, inc, T0, 300);
  assert.equal(dense.pass, false, 'three hundred entries on a thousand bars is a state');
  assert.ok((dense.entryDensity ?? 0) > 0.10);
});

test('decision 90: a pair whose shadow delivery is flat or worse against a screen promise half an R higher is retired by its record', () => {
  const s = (trades: number, avgR: number): PairStats => ({ trades, days: 20, wins: 0, winRatePct: 0, netR: avgR * trades, avgR, pfR: 1, weeks: 3, positiveWeeks: 1, positiveWeeksPct: 33, tStat: 9 });
  assert.equal(deliveryVerdict({ avgR: 1.03 }, s(22, -0.21)).retire, true, 'the BTC 15m case');
  assert.match(deliveryVerdict({ avgR: 1.03 }, s(22, -0.21)).reason ?? '', /delivery: -0.21R over 22 shadow trades against a screen of \+1.03R/);
  assert.equal(deliveryVerdict({ avgR: 1.03 }, s(12, -0.21)).retire, false, 'not before twenty trades');
  assert.equal(deliveryVerdict({ avgR: 0.30 }, s(30, 0.05)).retire, false, 'delivering something is not a lie');
  assert.equal(deliveryVerdict({ avgR: 0.30 }, s(30, -0.05)).retire, false, 'a small gap is noise');
  assert.equal(deliveryVerdict(null, s(40, -0.5)).retire, false, 'no promise, nothing to hold it to');
});

test('a pair on a market the gate refuses today is neither proposed nor admitted; a proposed one goes back to brewing (decision 104)', () => {
  const { db, store, cfg, insertTrade, screen } = world();
  syncLive(store, cfg, T0);
  recordScreen(store, { scannerId: 'cand', symbol: 'WIFUSD', tf: '15m' }, screen(), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'cand2', symbol: 'SOLUSD', tf: '15m' }, screen(), cfg.incubator, T0);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [{ symbol: 'WIFUSD', allowed: false, tracked: true, reasons: ['dead: $0.02M 24h turnover < $0.25M'] }, { symbol: 'SOLUSD', allowed: true, tracked: true, reasons: [] }] });
  const r1 = evaluate(store, cfg, T0);
  assert.deepEqual(r1.admitted, ['cand2 SOLUSD 15m'], 'the dead market holds no shadow slot');
  // the dead market later revives: the candidate is admitted, trades well, but dies again before the judge
  db.kvSet('risk.marketsToday', { enabled: true, at: T0 + DAY, markets: [{ symbol: 'WIFUSD', allowed: true, tracked: true, reasons: [] }, { symbol: 'SOLUSD', allowed: true, tracked: true, reasons: [] }] });
  assert.deepEqual(evaluate(store, cfg, T0 + DAY).admitted, ['cand WIFUSD 15m']);
  for (const t of series(40, 20, 2, 2, T0 + DAY + 1000)) insertTrade(2, 'cand', 'WIFUSD', t);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0 + 22 * DAY, markets: [{ symbol: 'WIFUSD', allowed: false, tracked: true, reasons: ['dead: $0.02M 24h turnover < $0.25M'] }] });
  const r2 = evaluate(store, cfg, T0 + 22 * DAY);
  assert.deepEqual(r2.proposed, [], 'a record on a market the account cannot trade is not a proposal');
  assert.equal(store.find('cand', 'WIFUSD', '15m')!.stage, 'shadow');
  assert.match(store.find('cand', 'WIFUSD', '15m')!.gate?.reasons?.[0] ?? '', /market gate refuses WIFUSD/);
  // the market revives: proposed; dies again: back to brewing with the reason on the row
  db.kvSet('risk.marketsToday', { enabled: true, at: T0 + 23 * DAY, markets: [{ symbol: 'WIFUSD', allowed: true, tracked: true, reasons: [] }] });
  assert.deepEqual(evaluate(store, cfg, T0 + 23 * DAY).proposed, ['cand WIFUSD 15m']);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0 + 24 * DAY, markets: [{ symbol: 'WIFUSD', allowed: false, tracked: true, reasons: ['costly book: 0.34% round trip'] }] });
  evaluate(store, cfg, T0 + 24 * DAY);
  assert.equal(store.find('cand', 'WIFUSD', '15m')!.stage, 'shadow');
});

test('decision 106: the screen rotates timeframes night by night', () => {
  const inc = { ...DEFAULT_CONFIG.incubator, tfs: ['15m', '1h', '4h'] };
  const days = Array.from({ length: 6 }, (_, i) => screenTf(inc, T0 + i * DAY));
  assert.deepEqual(new Set(days).size, 3, 'every timeframe comes round');
  assert.equal(days[0], days[3], 'a cycle of three');
  assert.equal(screenTf({ ...DEFAULT_CONFIG.incubator, tfs: undefined }, T0), DEFAULT_CONFIG.incubator.tf, 'no list: the single timeframe');
});

test('decision 106: the fleet spreads across markets and scanners; a crowded proposal is refused, a silent live cell is proposed for demotion, a stale shadow pair is retired', () => {
  const { db, store, cfg, insertTrade, screen } = world();
  cfg.incubator.promote = { ...cfg.incubator.promote, maxPerWeek: 10, maxFleet: 50, maxPerMarket: 1, maxPerScanner: 2 };
  cfg.scanners = { live1: { enabled: true, pairs: [{ symbol: 'BTCUSD', tf: '15m' }], timeframes: null, exitMode: 'both' } as any };
  syncLive(store, cfg, T0);
  assert.match(diversityRefusal(cfg, 'other', 'BTCUSD') ?? '', /already has 1 live cell/);
  assert.equal(diversityRefusal(cfg, 'other', 'ETHUSD'), null);
  // a proposal on the crowded market is refused at approval
  recordScreen(store, { scannerId: 'cand', symbol: 'BTCUSD', tf: '15m' }, screen(), cfg.incubator, T0);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [{ symbol: 'BTCUSD', allowed: true, tracked: true, reasons: [] }] });
  evaluate(store, cfg, T0);
  const row = store.find('cand', 'BTCUSD', '15m')!;
  store.move(row, 'proposed', 'test', null, 'forced for the test', T0 + 1);
  assert.throws(() => approve(store, cfg, row.id, 'op', () => {}, T0 + 2), /already has 1 live cell/);
  // the live cell never trades: after silentDays it is proposed for demotion
  cfg.incubator.demote = { ...cfg.incubator.demote, silentDays: 14 };
  const rep = evaluate(store, cfg, T0 + 15 * DAY);
  assert.deepEqual(rep.demoteProposed, ['live1 BTCUSD 15m']);
  assert.match(store.find('live1', 'BTCUSD', '15m')!.gate?.reasons?.[0] ?? '', /silent: no account trade in 15 days/);
  // a shadow pair with no shadow trade for staleDays is retired
  recordScreen(store, { scannerId: 'quiet', symbol: 'SOLUSD', tf: '1h' }, screen({ at: T0 + 15 * DAY }), cfg.incubator, T0 + 15 * DAY);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [{ symbol: 'SOLUSD', allowed: true, tracked: true, reasons: [] }] });
  // decision 108: the cap follows the timeframe; with no per-timeframe entry the 1h pair takes the 21-day fallback
  cfg.incubator.gate = { ...cfg.incubator.gate, staleDays: 21, staleDaysByTf: {} };
  assert.deepEqual(evaluate(store, cfg, T0 + 15 * DAY + 1).admitted, ['quiet SOLUSD 1h']);
  assert.equal(store.find('quiet', 'SOLUSD', '1h')!.stage, 'shadow');
  evaluate(store, cfg, T0 + 30 * DAY);
  assert.equal(store.find('quiet', 'SOLUSD', '1h')!.stage, 'shadow', 'not yet stale');
  const r3 = evaluate(store, cfg, T0 + 37 * DAY);
  assert.ok(r3.retired.includes('quiet SOLUSD 1h'));
  assert.match(JSON.stringify(store.events(5, store.find('quiet', 'SOLUSD', '1h')!.id)[0] ?? {}), /stale/);
});

test('decision 108: the positive-weeks share is judged only from minWeeks weeks, and the stale cap follows the timeframe', () => {
  // 32 trades over 15 days: the second week lost, so 1/3 weeks positive would fail at 60%; under three weeks the share is not asked
  const t = series(32, 15, 2, 2);
  for (const x of t) if (x.entryAt >= T0 + 7 * DAY) x.r = -0.1;
  const s = pairStats(t, T0, T0 + 15 * DAY);
  assert.ok(s.weeks === 3 && s.positiveWeeks === 1 && s.avgR >= gate.minAvgR && (s.pfR ?? 9) >= gate.minPfR, `${s.positiveWeeks}/${s.weeks} weeks, ${s.avgR.toFixed(2)}R, PF ${s.pfR}`);
  // decision 177's t-statistic is off here: this test is about the weeks rule
  assert.equal(gateVerdict(s, { ...gate, minWeeks: 0, minT: 0 }).decision, 'brewing');
  const v = gateVerdict(s, { ...gate, minWeeks: 4, minT: 0 });
  assert.equal(v.decision, 'propose');
  assert.ok(v.reasons.some(r => /judged from 4 weeks/.test(r)));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-stale-'));
  const db = new Db(path.join(dir, 'x.db'));
  const store = new IncubatorStore(db);
  const cfg: AppConfig = { ...DEFAULT_CONFIG, scanners: {}, incubator: { ...DEFAULT_CONFIG.incubator, gate: { ...gate, staleDays: 21, staleDaysByTf: { '4h': 45 } } } };
  store.move({ scannerId: 's', symbol: 'ETHUSD', tf: '15m' }, 'shadow', 'test', null, null, T0);
  store.move({ scannerId: 's', symbol: 'ETHUSD', tf: '4h' }, 'shadow', 'test', null, null, T0);
  const rep = evaluate(store, cfg, T0 + 30 * DAY);
  assert.deepEqual(rep.retired, ['s ETHUSD 15m'], 'the 15m pair is stale at 21 days; the 4h pair has 45');
  assert.equal(store.find('s', 'ETHUSD', '4h')!.stage, 'shadow');
  db.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('decision 109: a live cell with a known market refusal for marketOutDays is proposed for demotion; unknown data does not prove poor execution', () => {
  const { db, store, cfg } = world();
  cfg.incubator.demote = { ...cfg.incubator.demote, silentDays: 0, marketOutDays: 3 };
  cfg.scanners = {
    s1: { enabled: true, pairs: [{ symbol: 'BTCUSD', tf: '1h' }, { symbol: 'ETHUSD', tf: '1h' }, { symbol: 'ZZZUSD', tf: '1h' }], timeframes: null, exitMode: 'both' } as any,
  };
  syncLive(store, cfg, T0);
  // BTC refused, ETH allowed, ZZZ not judged at all while the gate has verdicts
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [
    { symbol: 'BTCUSD', allowed: false, tracked: true, reasons: ['dead: $0.02M 24h turnover < $0.05M'] },
    { symbol: 'ETHUSD', allowed: true, tracked: true, reasons: [] },
  ] });
  assert.deepEqual(evaluate(store, cfg, T0).demoteProposed, [], 'day one: counted, not proposed');
  assert.equal(store.find('s1', 'BTCUSD', '1h')!.gate?.reasons?.[0]?.startsWith('last '), true);
  assert.deepEqual(evaluate(store, cfg, T0 + 2 * DAY).demoteProposed, []);
  const r3 = evaluate(store, cfg, T0 + 3 * DAY);
  assert.deepEqual(r3.demoteProposed.sort(), ['s1 BTCUSD 1h']);
  assert.match(store.find('s1', 'BTCUSD', '1h')!.gate?.reasons?.[0] ?? '', /market out: the market gate refuses BTCUSD today: dead.*3 days in a row/);
  assert.equal(store.find('s1', 'ZZZUSD', '1h')!.stage, 'live');
  assert.equal(store.find('s1', 'ETHUSD', '1h')!.stage, 'live');
  // the market comes back: the counter clears and the days start over
  reject(store, store.find('s1', 'BTCUSD', '1h')!.id, 'op', null, T0 + 3 * DAY + 1);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [{ symbol: 'BTCUSD', allowed: true, tracked: true, reasons: [] }, { symbol: 'ETHUSD', allowed: true, tracked: true, reasons: [] }] });
  evaluate(store, cfg, T0 + 4 * DAY);
  assert.equal(store.marketOut()['s1|BTCUSD|1h'], undefined);
  db.kvSet('risk.marketsToday', { enabled: true, at: T0, markets: [{ symbol: 'BTCUSD', allowed: false, tracked: true, reasons: ['costly book'] }, { symbol: 'ETHUSD', allowed: true, tracked: true, reasons: [] }] });
  assert.deepEqual(evaluate(store, cfg, T0 + 5 * DAY).demoteProposed.filter(n => n.includes('BTC')), [], 'one day out again: not yet');
});

test('decision 112: a cost-starved live cell is proposed for demotion; one that opened is not; the funnel reads the signals table', () => {
  const { db, store, cfg } = world();
  cfg.incubator.demote = { ...cfg.incubator.demote, silentDays: 0, marketOutDays: 0, costStarvedRefusals: 5, costStarvedDays: 14 };
  cfg.scanners = { s1: { enabled: true, pairs: [{ symbol: 'BTCUSD', tf: '15m' }, { symbol: 'ETHUSD', tf: '15m' }], timeframes: null, exitMode: 'both' } as any };
  syncLive(store, cfg, T0);
  const now = T0 + 20 * DAY;   // decision 171: the cell has been live a full window
  const sig = (symbol: string, at: number, action: string) => db.insertSignal({ at, barTime: at, scannerId: 's1', scannerName: 'S1', symbol, tf: '15m', kind: 'entry', side: 'long', price: 100, sl: 99, tp: [], score: null, label: 'L', message: '', summary: '', source: 'alert', levelsSource: 'atr-fallback', action, positionId: null });
  for (let i = 0; i < 5; i++) sig('BTCUSD', now - i * DAY, 'rejected:stop too tight for fees (0.25% stop vs 0.19% round-trip cost; need ≥ 6×)');
  sig('BTCUSD', now - 6 * DAY, 'rejected:risk regime: choppy (efficiency 0.10 < 0.25)');
  for (let i = 0; i < 5; i++) sig('ETHUSD', now - i * DAY, 'rejected:stop too tight for fees (0.25% stop vs 0.19% round-trip cost; need ≥ 6×)');
  sig('ETHUSD', now - 2 * DAY + 60_000, 'opened'); // its own bar: the signals table keys on bar, side and label
  sig('BTCUSD', now - 20 * DAY, 'opened'); // outside the window
  const f = store.signalFunnel('s1', 'BTCUSD', '15m', now - 14 * DAY);
  assert.deepEqual(f, { entries: 6, opened: 0, pending: 0, regime: 1, cost: 5, market: 0, quote: 0, other: 0, lastOpenAt: null });
  const rep = evaluate(store, cfg, now);
  assert.deepEqual(rep.demoteProposed, ['s1 BTCUSD 15m']);
  assert.match(store.find('s1', 'BTCUSD', '15m')!.gate?.reasons?.[0] ?? '', /cost-starved: 5 of 6 signals refused by the cost rule and none opened in 14 days/);
  assert.equal(store.find('s1', 'ETHUSD', '15m')!.stage, 'live', 'one open in the window keeps the cell');
  assert.equal(store.signalFunnel('s1', 'ETHUSD', '15m', now - 14 * DAY).lastOpenAt, now - 2 * DAY + 60_000);
});

test('decision 114: a strategy cohort is judged on its own exits — preferred only when they beat the fleet on the cell yardstick', () => {
  const v = (o: Partial<VariantResult>): VariantResult => ({ trades: 60, avgR: 0.2, positiveHalves: true, marketsBetter: 3, marketsWorse: 1, markets: 5, ...o });
  assert.equal(preferScript(v({ avgR: 0.3 }), v({ avgR: 0.2 })).preferred, 'script');
  assert.equal(preferScript(v({ avgR: 0.3, positiveHalves: false }), v({ avgR: 0.2 })).preferred, 'both', 'a losing half keeps the fleet exits');
  assert.equal(preferScript(v({ avgR: 0.3, marketsBetter: 1, marketsWorse: 3 }), v({ avgR: 0.2 })).preferred, 'both', 'worse on most markets keeps the fleet exits');
  assert.equal(preferScript(v({ avgR: 0.15 }), v({ avgR: 0.2 })).preferred, 'both');
  assert.match(preferScript(v({ avgR: 0.3 }), v({ avgR: 0.2 })).reason, /exit mode script/);
  // from screens: two markets screened under both modes, one not (an indicator-era screen) is left out
  const sc = (trades: number, avgR: number, s?: { trades: number; avgR: number; avgR1: number; avgR2: number }): ScreenResult => ({ pass: true, at: T0, trades, profitFactor: 1.5, netPnl: 1, netAtStress: 1, windowsUp: 6, winRatePct: 50, avgR, avgR1: avgR, avgR2: avgR, bars: 4000, days: 40, scriptExit: s ? { ...s, sumR: s.avgR * s.trades } : undefined });
  const c = cohortComparison([sc(40, 0.1, { trades: 50, avgR: 0.3, avgR1: 0.2, avgR2: 0.4 }), sc(40, 0.2, { trades: 50, avgR: 0.35, avgR1: 0.3, avgR2: 0.4 }), sc(40, 0.5)]);
  assert.ok(c); assert.equal(c!.preferred, 'script'); assert.equal(c!.script.markets, 2); assert.equal(c!.script.trades, 100); assert.equal(c!.both.trades, 80);
  assert.ok(Math.abs(c!.script.avgR - 0.325) < 1e-9);
  assert.equal(cohortComparison([sc(40, 0.5)]), null, 'no screen under both modes: no comparison');
});

test('decision 115: a market is too quiet for a fast timeframe when its bars cannot clear the cost rule at the fallback stop', () => {
  const paper = { minRiskFeeRatio: 6, fallbackAtrSl: 1.5, feeRatePct: 0.05, feeTaxPct: 18 };
  // a 0.12% book: 15m needs 0.48% ATR; 5m needs √3 of that; 1h half; 4h a quarter
  assert.ok(Math.abs(atrNeededPct(0.12, '15m', paper)! - 0.48) < 1e-9);
  assert.ok(Math.abs(atrNeededPct(0.12, '5m', paper)! - 0.48 * 1.73) < 1e-9);
  assert.ok(Math.abs(atrNeededPct(0.12, '4h', paper)! - 0.12) < 1e-9);
  assert.equal(tooQuietForTf(0.09, 0.119, '15m', paper)?.startsWith('too quiet for 15m: 15m ATR 0.09%'), true, 'BTC on 15m');
  assert.equal(tooQuietForTf(2.25, 0.224, '15m', paper), null, 'ARIA clears');
  assert.equal(tooQuietForTf(0.5, 0.12, '1h', paper), null, 'the same market clears on 1h');
  assert.equal(tooQuietForTf(null, 0.12, '15m', paper), null, 'no reading: not refused');
  assert.ok(atrNeededPct(null, '15m', paper)! > 0.47, 'no book reading: the fees alone set the floor');
  assert.equal(atrNeededPct(0.12, '15m', { ...paper, minRiskFeeRatio: 0 }), null, 'cost rule off: no floor');
});

test('decision 132: pair mode admits by score with a per-scanner cap, and the gate scales its floors by timeframe', () => {
  const { store, cfg, screen } = world();
  cfg.incubator.gate.pool = 'pair';
  cfg.incubator.maxShadow = 10;
  cfg.incubator.admit.maxPerScannerTf = { '15m': 2 };
  for (let i = 0; i < 5; i++) recordScreen(store, { scannerId: 'hog', symbol: `M${i}USD`, tf: '15m' }, screen({ profitFactor: 3 }), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'other', symbol: 'XUSD', tf: '15m' }, screen({ profitFactor: 1.3 }), cfg.incubator, T0);
  const rep = evaluate(store, cfg, T0);
  assert.equal(rep.admitted.filter(n => n.startsWith('hog')).length, 2, 'one scanner holds at most its cap at a timeframe');
  assert.ok(rep.admitted.includes('other XUSD 15m'), 'the weaker candidate still gets a slot');
  // a passing screen stays eligible for the configured window, not eight days
  recordScreen(store, { scannerId: 'late', symbol: 'YUSD', tf: '15m' }, screen({ profitFactor: 1.4, at: T0 }), cfg.incubator, T0);
  assert.ok(evaluate(store, cfg, T0 + 20 * DAY).admitted.includes('late YUSD 15m'), 'eligible at 20 days');
  assert.ok(!evaluate(store, cfg, T0 + 40 * DAY).admitted.includes('late YUSD 15m'), 'stale after the window');
  cfg.incubator.gate.minTradesByTf = { '4h': 12 }; cfg.incubator.gate.minDaysByTf = { '4h': 45 };
  const g4 = gateFor(cfg.incubator, '4h'), g15 = gateFor(cfg.incubator, '15m');
  assert.equal(g4.minTrades, 12); assert.equal(g4.minDays, 45); assert.equal(g4.maxDays, 90);
  assert.equal(g15.minTrades, cfg.incubator.gate.minTrades); assert.equal(g15.minDays, cfg.incubator.gate.minDays);
});

test('decision 132: a cell demoted to the shadow book keeps the evidence window of its original admission', () => {
  const { store, cfg, screen } = world();
  recordScreen(store, { scannerId: 'cand', symbol: 'ETHUSD', tf: '15m' }, screen(), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  const p = store.find('cand', 'ETHUSD', '15m')!;
  store.move(p, 'live', 'admin', null, 'promoted', T0 + 10 * DAY);
  const patches: any[] = [];
  demote(store, cfg, p.id, 'admin', (id, patch) => patches.push({ id, patch }), null, T0 + 20 * DAY);
  const back = store.get(p.id)!;
  assert.equal(back.stage, 'shadow');
  assert.equal(back.since, T0, 'the shadow evidence from before promotion counts again');
});

test('decision 134: a strategy candidate screened before the fill fix waits for a fresh screen', () => {
  const { store, cfg, screen } = world();
  cfg.incubator.gate.pool = 'pair';
  recordScreen(store, { scannerId: 'strat', symbol: 'AUSD', tf: '15m' }, screen({ profitFactor: 3 }), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'strat', symbol: 'BUSD', tf: '15m' }, screen({ profitFactor: 3, fill: 'close' }), cfg.incubator, T0);
  recordScreen(store, { scannerId: 'ind', symbol: 'CUSD', tf: '15m' }, screen({ profitFactor: 2 }), cfg.incubator, T0);
  const rep = evaluate(store, cfg, T0, { needsRescreen: id => id === 'strat' });
  assert.ok(!rep.admitted.includes('strat AUSD 15m'), 'the flattered screen is not trusted');
  assert.ok(rep.admitted.includes('strat BUSD 15m'), 'a fresh screen is');
  assert.ok(rep.admitted.includes('ind CUSD 15m'), 'indicator screens are unaffected');
});

test('decision 134: the backtest fills a market entry at the signal bar close, not at the event price', async () => {
  const { runBacktest } = await import('../paper/backtest.ts');
  const H = 3600_000; const bars = Array.from({ length: 40 }, (_, i) => ({ time: T0 + i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  bars[30] = { time: T0 + 30 * H, open: 100, high: 106, low: 99, close: 105, volume: 1 };
  for (let i = 31; i < 40; i++) bars[i] = { time: T0 + i * H, open: 105, high: 105.5, low: 104.5, close: 105, volume: 1 };
  bars[35] = { time: T0 + 35 * H, open: 105, high: 105.5, low: 80, close: 81, volume: 1 };   // the stop is hit, so the trade closes and its fill can be read
  const events = [{ kind: 'entry' as const, side: 'long' as const, price: 101, tp: [], label: 'STRATEGY entry long', message: '', source: 'alert' as const, barTime: bars[30].time, barIndex: 30 }];
  const r = runBacktest({ scannerId: 's', scannerName: 's', symbol: 'XUSD', tf: '1h', bars, events, cfg: { ...cfg0().paper, minRiskFeeRatio: 0 }, exitMode: 'both', contractValue: 1, tickSize: 0.01 });
  assert.equal(r.entries, 1);
  assert.equal(r.trades.length, 1, 'the trade closed');
  assert.ok(r.trades[0].entryPrice >= 105, `filled at the close, not at the 101 breakout level (got ${r.trades[0].entryPrice})`);
});
function cfg0() { return structuredClone(DEFAULT_CONFIG); }

test('decision 135: a script exit and a reversal fill at the close in the backtest, a target hit at its level', async () => {
  const { runBacktest } = await import('../paper/backtest.ts');
  const H = 3600_000; const bars = Array.from({ length: 40 }, (_, i) => ({ time: T0 + i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  bars[30] = { time: T0 + 30 * H, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 };
  bars[32] = { time: T0 + 32 * H, open: 100, high: 104, low: 99.5, close: 100.2, volume: 1 };
  const ev = (kind: 'entry' | 'exit', i: number, price?: number, exitType?: any) => ({ kind, side: 'long' as const, price, exitType, tp: [], label: kind, message: '', source: 'alert' as const, barTime: bars[i].time, barIndex: i });
  const base = { scannerId: 's', scannerName: 's', symbol: 'XUSD', tf: '1h', bars, cfg: { ...cfg0().paper, minRiskFeeRatio: 0, fallbackAtrSl: 5 }, exitMode: 'script' as const, contractValue: 1, tickSize: 0.01 };
  const closeExit = runBacktest({ ...base, events: [ev('entry', 30), ev('exit', 32, 103.5, 'close')] });
  assert.equal(closeExit.trades.length, 1);
  assert.ok(Math.abs((closeExit.trades[0].exitPrice ?? 0) - 100.2) < 0.2, `a script close fills at the bar close (got ${closeExit.trades[0].exitPrice})`);
});

test('decision 139: a tracker tracks new cells, keeps existing ones, and the gate never touches tracked cells', async () => {
  const { saveTracker, removeTracker, trackerView, listTrackers } = await import('./tracker.ts');
  const { db, store, cfg, screen } = world();
  recordScreen(store, { scannerId: 'w1', symbol: 'BTCUSD', tf: '15m' }, screen(), cfg.incubator, T0);
  evaluate(store, cfg, T0);   // w1 BTC 15m is admitted to the shadow book
  assert.equal(store.find('w1', 'BTCUSD', '15m')!.stage, 'shadow');
  const r = saveTracker(db, store, { id: 'willy', name: 'Willy on the majors', scanners: ['w1', 'w2'], symbols: ['BTCUSD', 'ETHUSD'], tfs: ['15m'] }, T0);
  assert.equal(r.added, 3); assert.equal(r.kept, 1, 'the shadow cell keeps its stage');
  assert.equal(store.find('w2', 'ETHUSD', '15m')!.stage, 'tracked');
  // forty days with no trades: a shadow cell would be retired as stale, a tracked one is left alone and holds no slot
  const rep = evaluate(store, cfg, T0 + 40 * DAY);
  assert.ok(!rep.retired.some(n => n.startsWith('w2')), 'tracked cells are never retired');
  assert.equal(store.list(['tracked']).length, 3);
  // recording a screen on a tracked cell does not move it
  recordScreen(store, { scannerId: 'w2', symbol: 'ETHUSD', tf: '15m' }, screen(), cfg.incubator, T0 + 41 * DAY);
  assert.equal(store.find('w2', 'ETHUSD', '15m')!.stage, 'tracked');
  const narrowed = saveTracker(db, store, { id: 'willy', name: 'Willy on the majors', scanners: ['w1', 'w2'], symbols: ['BTCUSD'], tfs: ['15m'] }, T0 + 41 * DAY);
  assert.equal(narrowed.released, 2, 'the ETH cells left the tracker');
  assert.equal(store.find('w1', 'ETHUSD', '15m')!.stage, 'candidate');
  saveTracker(db, store, { id: 'willy', name: 'Willy on the majors', scanners: ['w1', 'w2'], symbols: ['BTCUSD', 'ETHUSD'], tfs: ['15m'] }, T0 + 41 * DAY);
  const v = trackerView(db, store, listTrackers(db)[0]);
  assert.equal(v.cells.length, 4); assert.equal(v.totals.trades, 0);
  assert.equal(removeTracker(db, store, 'willy', T0 + 42 * DAY), 4, 'w1 BTC aged out of the shadow book at day 40, so the re-save tracked it too');
  assert.equal(store.list(['tracked']).length, 0); assert.equal(listTrackers(db).length, 0);
});

test('decision 151: restartEvidence moves the window start and logs it; expireScreen stops a candidate from being admitted', () => {
  const db = new Db(':memory:'); const store = new IncubatorStore(db);
  const sh = store.move({ scannerId: 's', symbol: 'BTCUSD', tf: '15m' }, 'shadow', 'screen', null, null, 1_000);
  const r = store.restartEvidence(sh.id, 'engine-upgrade', 'new engine', 5_000)!;
  assert.equal(r.stage, 'shadow');
  assert.equal(r.since, 5_000);
  const ev = store.events(5, sh.id)[0];
  assert.equal(ev.actor, 'engine-upgrade');
  assert.equal(ev.from, 'shadow');
  assert.equal(ev.to, 'shadow');
  const c = store.move({ scannerId: 's', symbol: 'ETHUSD', tf: '15m' }, 'candidate', 'screen', null, null, 1_000);
  store.setScreen(c.id, { pass: true, at: 4_000, trades: 50 });
  const x = store.expireScreen(c.id, 'engine-upgrade', 'new engine', 6_000)!;
  assert.equal(x.screen.at, 0, 'an expired screen is older than any candidate window');
  assert.equal(x.screen.trades, 50, 'the screen itself is kept for the record');
  assert.equal(x.screen.expiredAt, 6_000);
  db.db.close();
});

test('decision 157: candidateBlockers names what holds each passed candidate; admitOnly admits only the admissible, between hunts', () => {
  const { db, store, cfg, screen } = world();
  cfg.incubator.gate.pool = 'pair';
  cfg.incubator.maxShadow = 3;
  cfg.incubator.admit.maxPerScannerTf = { '15m': 1 };
  const T = T0 + DAY;
  db.kvSet('risk.marketsToday', { enabled: true, at: T, markets: [
    { symbol: 'AAA', allowed: true, reasons: [] }, { symbol: 'BBB', allowed: true, reasons: [] }, { symbol: 'CCC', allowed: true, reasons: [] },
    { symbol: 'NOPE', allowed: false, reasons: ['dead'] }, { symbol: 'DDD', allowed: true, reasons: [] }] });
  const at = (scannerId: string, symbol: string, over: Partial<ScreenResult> = {}) => recordScreen(store, { scannerId, symbol, tf: '15m' }, screen({ at: T, ...over }), cfg.incubator, T);
  at('a', 'AAA'); at('a', 'BBB');                         // the second of scanner a is over its cap of one
  at('b', 'CCC');                                          // admissible
  at('c', 'NOPE');                                         // refused by the gate today
  at('d', 'OUTSIDE');                                      // not judged by the gate at all
  at('e', 'DDD', { at: T - 40 * DAY });                    // a screen past its 30 days
  at('f', 'AAA', { fill: undefined } as any);              // a strategy screened before decision 134
  const ex = store.list(['candidate']).find(r => r.scannerId === 'b')!;
  at('g', 'DDD'); store.expireScreen(store.list(['candidate']).find(r => r.scannerId === 'g')!.id, 'engine-upgrade', 'test', T); // expired by an engine change
  at('h', 'DDD', { pass: false });                         // did not pass: not a candidate that waits
  const opts = { needsRescreen: (id: string) => id === 'f' };
  const b = candidateBlockers(store, cfg, T, opts);
  assert.equal(b.passed, 8);
  assert.deepEqual(b.counts, { expired: 1, stale: 1, outside: 1, refused: 1, rescreen: 1, capped: 1, noSlot: 0, cohort: 0, admissible: 2 });
  const admitted = admitOnly(store, cfg, T, opts);
  assert.equal(admitted.length, 2, 'what the classifier calls admissible is what admission takes');
  assert.ok(store.list(['shadow']).some(r => r.id === ex.id));
  assert.equal(store.list(['proposed', 'retired']).length, 0, 'admission alone neither judges nor retires');
  assert.equal(candidateBlockers(store, cfg, T, opts).counts.admissible, 0);
  cfg.incubator.enabled = false;
  assert.deepEqual(admitOnly(store, cfg, T, opts), [], 'off when the incubator is off');
});

test('decision 171: a freshly promoted cell is judged on its own live period, and a demoted pair returns only once its demotion is answered', () => {
  const { db, store, cfg, insertTrade, screen } = world();
  cfg.incubator.gate.pool = 'pair';
  cfg.incubator.demote = { ...cfg.incubator.demote, silentDays: 0, marketOutDays: 0, costStarvedRefusals: 5, costStarvedDays: 14 };
  cfg.incubator.mirror = { enabled: true };   // decision 184: the signal-funnel answer is a mirror-on rule; off, the shadow record decides
  recordScreen(store, { scannerId: 'p', symbol: 'p1', tf: '15m' }, screen(), cfg.incubator, T0);
  evaluate(store, cfg, T0);
  for (const t of series(40, 20, 2, 2, T0 + 1000)) insertTrade(2, 'p', 'p1', t);
  const sig = (at: number, action: string) => db.insertSignal({ at, barTime: at, scannerId: 'p', scannerName: 'P', symbol: 'p1', tf: '15m', kind: 'entry', side: 'long', price: 100, sl: 99, tp: [], score: null, label: 'L', message: '', summary: '', source: 'alert', levelsSource: 'atr-fallback', action, positionId: null });
  // the shadow mirror's refusals from before promotion (decision 116)
  for (let i = 1; i <= 5; i++) sig(T0 + 21 * DAY - i * DAY, 'rejected:stop too tight for fees (0.25% stop vs 0.19% round-trip cost; need ≥ 6×)');
  const promoteAt = T0 + 21 * DAY;
  assert.deepEqual(evaluate(store, cfg, promoteAt).proposed, ['p p1 15m']);
  const setScanner = (id: string, patch: any) => { cfg.scanners[id] = { ...(cfg.scanners[id] ?? { enabled: false, symbols: null, timeframes: null, exitMode: 'both' }), ...patch }; };
  const pair = store.find('p', 'p1', '15m')!;
  approve(store, cfg, pair.id, 'admin', setScanner, promoteAt);
  assert.equal(store.get(pair.id)!.stage, 'live');
  assert.deepEqual(evaluate(store, cfg, promoteAt + DAY).demoteProposed, [], 'live for a day: the refusals before promotion do not count');
  assert.deepEqual(evaluate(store, cfg, promoteAt + 15 * DAY).demoteProposed, [], 'a full window live, no refusal in it: kept');
  for (let i = 0; i < 5; i++) sig(promoteAt + 10 * DAY + i * DAY, 'rejected:stop too tight for fees (0.25% stop vs 0.19% round-trip cost; need ≥ 6×)');
  const demoteAt = promoteAt + 16 * DAY;
  assert.deepEqual(evaluate(store, cfg, demoteAt).demoteProposed, ['p p1 15m'], 'five refusals inside its own live window: cost-starved');
  approve(store, cfg, pair.id, 'admin', setScanner, demoteAt);
  assert.equal(store.get(pair.id)!.stage, 'shadow');
  assert.deepEqual(store.lastDemotion(pair.id), { at: demoteAt, reason: 'cost-starved: 5 of 5 signals refused by the cost rule and none opened in 14 days' });
  const soon = evaluate(store, cfg, demoteAt + DAY);
  assert.deepEqual(soon.proposed, [], 'the same shadow record, a day after the demotion: not proposed');
  assert.match(store.get(pair.id)!.gate?.reasons?.[0] ?? '', /cost-starved when demoted; since then 0 signal\(s\), 0 refused by the cost rule, none opened/);
  for (let i = 0; i < 3; i++) sig(demoteAt + 2 * DAY + i * 3600_000, 'rejected:stop too tight for fees (0.25% stop vs 0.19% round-trip cost; need ≥ 6×)');
  assert.deepEqual(evaluate(store, cfg, demoteAt + 3 * DAY).proposed, [], 'still refused by the cost rule: not proposed, however long ago');
  sig(demoteAt + 4 * DAY, 'opened');
  assert.deepEqual(evaluate(store, cfg, demoteAt + 4 * DAY + 60_000).proposed, ['p p1 15m'], 'the account opened one of its signals: the demotion is answered');
});

test('approval rechecks current pair evidence after losses or quarantine without changing allocation', () => {
 const {db,store,cfg,insertTrade}=world();cfg.incubator.gate.pool='pair';
 const k={scannerId:'recheck',symbol:'SOLUSD',tf:'15m'};
 store.move(k,'shadow','test',null,null,T0);
 for(const t of series(40,20,2,2,T0+1000))insertTrade(2,k.scannerId,k.symbol,t);
 const now=T0+21*DAY;evaluate(store,cfg,now);
 const row=store.find(k.scannerId,k.symbol,k.tf)!;assert.equal(row.stage,'proposed');
 db.run("INSERT INTO evidence_flags SELECT id,entry_at,'quarantined','invalid historical fill','test',? FROM positions WHERE scanner_id=? AND realized_pnl>0",now,k.scannerId);
 let patched=false;
 assert.throws(()=>approve(store,cfg,row.id,'admin',()=>{patched=true;},now),/no longer qualifies/);
 assert.equal(patched,false);assert.equal(store.get(row.id)!.stage,'proposed');
});

test('approval rechecks market eligibility instead of trusting a cached proposal',()=>{
 const {db,store,cfg,insertTrade}=world();cfg.incubator.gate.pool='pair';
 const k={scannerId:'recheck',symbol:'SOLUSD',tf:'15m'};store.move(k,'shadow','test',null,null,T0);
 for(const t of series(40,20,2,2,T0+1000))insertTrade(2,k.scannerId,k.symbol,t);
 const now=T0+21*DAY;evaluate(store,cfg,now);const row=store.find(k.scannerId,k.symbol,k.tf)!;
 db.kvSet('risk.marketsToday',{enabled:true,at:now,markets:[{symbol:'SOLUSD',allowed:false,reasons:['costly book'],turnoverUsd:10000000}]});
 assert.throws(()=>approve(store,cfg,row.id,'admin',()=>assert.fail('must not allocate'),now),/costly book/);
});

test('approval refreshes cohort evidence and requires the individual market to remain positive',()=>{
 for(const weakened of [false,true]){
  const {store,cfg,insertTrade}=world();cfg.incubator.gate.pool='cohort';
  for(const symbol of ['SOLUSD','XRPUSD','ETHUSD']){
   store.move({scannerId:'group',symbol,tf:'15m'},'shadow','test',null,null,T0);
   for(const t of series(40,20,2,2,T0+1000))insertTrade(2,'group',symbol,t);
  }
  const now=T0+21*DAY;evaluate(store,cfg,now);const row=store.find('group','SOLUSD','15m')!;assert.equal(row.stage,'proposed');
  if(weakened)for(const t of series(30,1,-1,2,now))insertTrade(2,'group','SOLUSD',t);
  let patched=false;const run=()=>approve(store,cfg,row.id,'admin',()=>{patched=true;},now+DAY);
  if(weakened){assert.throws(run,/no longer qualifies/);assert.equal(patched,false);}
  else {assert.equal(run().stage,'live');assert.equal(patched,true);}
 }
});

test('shadow admission uses the research turnover floor while promotion retains its higher floor',()=>{
 const {db,store,cfg,insertTrade,screen}=world();cfg.incubator.gate.pool='pair';cfg.incubator.minTurnoverUsd=1000000;cfg.incubator.gate.minTurnoverUsd=5000000;
 const markets=[{symbol:'SOLUSD',allowed:true,reasons:[],turnoverUsd:2000000},{symbol:'TINYUSD',allowed:true,reasons:[],turnoverUsd:500000}];
 db.kvSet('risk.marketsToday',{enabled:true,at:T0,markets});
 for(const symbol of ['SOLUSD','TINYUSD'])recordScreen(store,{scannerId:'research',symbol,tf:'15m'},screen(),cfg.incubator,T0);
 const b=candidateBlockers(store,cfg,T0);assert.equal(b.counts.admissible,1);assert.equal(b.counts.refused,1);
 assert.deepEqual(admitOnly(store,cfg,T0),['research SOLUSD 15m']);
 for(const t of series(40,20,2,2,T0+1000))insertTrade(2,'research','SOLUSD',t);
 const now=T0+21*DAY;assert.deepEqual(evaluate(store,cfg,now).proposed,[]);
 assert.equal(store.find('research','SOLUSD','15m')!.stage,'shadow');
 assert.match(store.find('research','SOLUSD','15m')!.gate.reasons.join(';'),/thin market/);
 assert.equal(cfg.incubator.mirror?.enabled,false);
});

test('promoting another pair preserves a scanner existing legacy symbol allocation',()=>{
 const {store,cfg,insertTrade}=world();cfg.incubator.gate.pool='pair';
 const k={scannerId:'live1',symbol:'ETHUSD',tf:'15m'};store.move(k,'shadow','test',null,null,T0);
 for(const t of series(40,20,2,2,T0+1000))insertTrade(2,k.scannerId,k.symbol,t);
 const now=T0+21*DAY;evaluate(store,cfg,now);const row=store.find(k.scannerId,k.symbol,k.tf)!;
 let patch:any;approve(store,cfg,row.id,'admin',(_id,p)=>{patch=p;},now);
 assert.deepEqual(patch.pairs,[{symbol:'BTCUSD',tf:'15m'},{symbol:'ETHUSD',tf:'15m'}]);
});

test('a positive live pair below the promotion turnover floor is not demoted when execution gate allows it',()=>{
 const {db,store,cfg,insertTrade}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:0,marketOutDays:3};syncLive(store,cfg,T0);
 db.kvSet('risk.marketsToday',{enabled:true,at:T0,markets:[{symbol:'BTCUSD',allowed:true,reasons:[],turnoverUsd:200000}]});
 for(const t of series(4,4,2,2,T0))insertTrade(0,'live1','BTCUSD',t);
 evaluate(store,cfg,T0);assert.deepEqual(evaluate(store,cfg,T0+4*DAY).demoteProposed,[]);
 assert.equal(store.find('live1','BTCUSD','15m')!.stage,'live');
});

test('pending demotion is rejudged, recovers to live without resetting its evidence clock, and cannot be approved stale',()=>{
 const {db,store,cfg}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:0,marketOutDays:3};syncLive(store,cfg,T0);
 const market=(allowed:boolean)=>db.kvSet('risk.marketsToday',{enabled:true,at:T0,markets:[{symbol:'BTCUSD',allowed,reasons:allowed?[]:['costly book'],turnoverUsd:10000000}]});
 market(false);evaluate(store,cfg,T0);evaluate(store,cfg,T0+4*DAY);const row=store.find('live1','BTCUSD','15m')!;assert.equal(row.stage,'demote_proposed');
 market(true);assert.throws(()=>approve(store,cfg,row.id,'op',()=>assert.fail('must not change allocation'),T0+4*DAY+1000),/no longer qualifies/);
 evaluate(store,cfg,T0+5*DAY);assert.equal(store.get(row.id)!.stage,'live');assert.equal(store.get(row.id)!.since,T0);
 assert.equal(store.get(row.id)!.gate.decision,'keep');assert.equal(store.marketOut()['live1|BTCUSD|15m'],undefined);
});

test('pending demotion refreshes a missing reason and retains an independent full-sample loss reason',()=>{
 const {store,cfg,insertTrade}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:0,marketOutDays:0};syncLive(store,cfg,T0);
 for(const t of series(40,20,.5,2,T0+1000))insertTrade(0,'live1','BTCUSD',t);
 evaluate(store,cfg,T0+21*DAY);const row=store.find('live1','BTCUSD','15m')!;store.setGate(row.id,null);
 evaluate(store,cfg,T0+22*DAY);assert.equal(store.get(row.id)!.stage,'demote_proposed');assert.match(store.get(row.id)!.gate.reasons[0],/last 40 live trades/);
 assert.equal(store.get(row.id)!.gate.stats.days<30,true,'sample age must not be counted from 1970');
});

test('unavailable, stale or missing market data does not establish persistent poor execution',()=>{
 const {db,store,cfg}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:0,marketOutDays:3};syncLive(store,cfg,T0);
 for(const [at,markets]of [[T0,[{symbol:'BTCUSD',allowed:false,reasons:['unavailable: order book not read']}]], [T0+4*DAY,[]]] as Array<[number,any[]]>){
  db.kvSet('risk.marketsToday',{enabled:true,at,markets});assert.deepEqual(evaluate(store,cfg,at).demoteProposed,[]);
 }
 assert.deepEqual(store.marketOut(),{});
});

test('stale depth and legacy turnover clocks cannot manufacture three days of execution refusal',()=>{
 const {db,store,cfg}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:0,marketOutDays:3};syncLive(store,cfg,T0);
 db.kvSet('incubator.marketOut',{'live1|BTCUSD|15m':T0-10*DAY});
 db.kvSet('risk.marketsToday',{enabled:true,at:T0,markets:[{symbol:'BTCUSD',allowed:false,reasons:['costly book'],turnoverUsd:10000000}]});
 assert.deepEqual(evaluate(store,cfg,T0).demoteProposed,[]);assert.equal(store.marketOut()['live1|BTCUSD|15m'],T0);
 store.marketStaleMs=3600000;
 assert.deepEqual(evaluate(store,cfg,T0+4*DAY).demoteProposed,[]);assert.deepEqual(store.marketOut(),{});
});

test('an active filled account position is not mistaken for a silent or cost-starved scanner',()=>{
 const {db,store,cfg}=world();cfg.incubator.demote={...cfg.incubator.demote,silentDays:1,marketOutDays:0,costStarvedRefusals:5};syncLive(store,cfg,T0);
 db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt) VALUES('open','live1','s','BTCUSD','15m','long',1,1,1,100,?,0)",T0);
 assert.deepEqual(evaluate(store,cfg,T0+20*DAY).demoteProposed,[]);
});

test('major coverage tracker adds watch-only cells without promoting candidates or changing live cells', async () => {
  const { saveTracker } = await import('./tracker.ts');
  const db = new Db(':memory:'); const store = new IncubatorStore(db);
  try {
    store.move({scannerId:'s0',symbol:'BTCUSD',tf:'15m'},'live','test',{},'allocated',1000);
    store.move({scannerId:'s1',symbol:'ETHUSD',tf:'1h'},'candidate','test',{},'not qualified',1000);
    const def={id:'enabled-major-coverage',name:'Major coverage',scanners:Array.from({length:14},(_,i)=>`s${i}`),symbols:['BTCUSD','ETHUSD','SOLUSD','XRPUSD','BNBUSD','DOGEUSD','ADAUSD','AVAXUSD','LINKUSD','SUIUSD'],tfs:['15m','1h','4h']};
    const result=saveTracker(db,store,def,2000);
    assert.equal(result.added,419); assert.equal(result.kept,1);
    assert.equal(store.find('s0','BTCUSD','15m')!.stage,'live');
    assert.equal(store.find('s1','ETHUSD','1h')!.stage,'tracked');
    assert.equal(store.list(['live']).length,1);
    assert.equal(store.list(['tracked']).length,419);
    assert.equal(saveTracker(db,store,def,3000).added,0,'re-running cannot duplicate cells');
  } finally { db.db.close(); }
});
