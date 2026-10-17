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
import { approve, demote, evaluate, recordScreen, reject, syncLive, type ScreenResult, livePairs, screenVerdict, screenTf, diversityRefusal } from './cycle.ts';

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
  assert.deepEqual(patches, [{ id: 'cand', patch: { enabled: true, hidden: false, pairs: [{ symbol: 'ETHUSD', tf: '15m' }] } }]);
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
  const s = (trades: number, avgR: number): PairStats => ({ trades, days: 20, wins: 0, winRatePct: 0, netR: avgR * trades, avgR, pfR: 1, weeks: 3, positiveWeeks: 1, positiveWeeksPct: 33 });
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
  assert.equal(gateVerdict(s, { ...gate, minWeeks: 0 }).decision, 'brewing');
  const v = gateVerdict(s, { ...gate, minWeeks: 4 });
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
