/**
 * One incubator cycle, and the owner's approve/reject actions. Shared by the daily job and the API.
 */
import type { AppConfig, IncubatorConfig, ScannerConfig } from '../config.ts';
import { IncubatorStore, type PairRow, type Stage } from './store.ts';
import { cohortStats, cohortVerdict, demoteVerdict, gateVerdict, overlapPct, pairStats, screenScore, type CohortStats } from './gate.ts';

export interface ScreenResult {
  pass: boolean; at: number; trades: number; profitFactor: number; netPnl: number; netAtStress: number;
  windowsUp: number; winRatePct: number; avgR: number; bars: number; days: number;
}

type PairKey = { scannerId: string; symbol: string; tf: string };
const DAY = 86400_000;

/** The gate for one timeframe: a 4h pair cannot produce in 45 days what a 15m pair produces in 8. */
const gateFor = (inc: IncubatorConfig, tf: string) => ({ ...inc.gate, maxDays: inc.gate.maxDaysByTf?.[tf] ?? inc.gate.maxDays });
/** How many markets one scanner is admitted on at this timeframe. */
const marketsFor = (inc: IncubatorConfig, tf: string) => inc.admit.cohortMarkets[tf] ?? inc.admit.cohortMarkets.default ?? 5;

/** The live fleet as the config describes it: enabled, not hidden, one row per scanner × market. */
export function livePairs(cfg: AppConfig): PairKey[] {
  const tf = cfg.incubator.tf;
  return Object.entries(cfg.scanners).filter(([, v]) => v.enabled && !v.hidden)
    .flatMap(([id, v]) => (v.symbols ?? cfg.symbols).map(symbol => ({ scannerId: id, symbol, tf })));
}

/** Make the incubator's `live` rows match the config: the config is the record of what trades. */
export function syncLive(store: IncubatorStore, cfg: AppConfig, now = Date.now()): { added: number; removed: number } {
  const want = new Map(livePairs(cfg).map(p => [`${p.scannerId}|${p.symbol}|${p.tf}`, p]));
  let added = 0, removed = 0;
  for (const p of want.values()) {
    const cur = store.find(p.scannerId, p.symbol, p.tf);
    if (!cur || (cur.stage !== 'live' && cur.stage !== 'demote_proposed')) { store.move(p, 'live', 'config', null, 'in the live fleet', now); added++; }
  }
  for (const r of store.list(['live', 'demote_proposed'])) {
    if (!want.has(`${r.scannerId}|${r.symbol}|${r.tf}`)) { store.move(r, 'retired', 'config', null, 'removed from the live fleet', now); removed++; }
  }
  return { added, removed };
}

/** Record one screen result. Only passing results create candidates; the table stays small. */
export function recordScreen(store: IncubatorStore, p: PairKey, res: ScreenResult, inc: IncubatorConfig, now = Date.now()): 'new' | 'updated' | 'cooldown' | 'skipped' {
  const cur = store.find(p.scannerId, p.symbol, p.tf);
  if (!cur) {
    if (!res.pass) return 'skipped';
    const row = store.move(p, 'candidate', 'screen', res, null, now);
    store.setScreen(row.id, res, now);
    return 'new';
  }
  if (cur.stage === 'retired') {
    if (now - cur.since < inc.cooldownDays * DAY) return 'cooldown';
    if (!res.pass) return 'skipped';
    const row = store.move(p, 'candidate', 'screen', res, 'back after cooldown', now);
    store.setScreen(row.id, res, now);
    return 'new';
  }
  store.setScreen(cur.id, res, now);
  return 'updated';
}

export interface CycleReport { proposed: string[]; retired: string[]; brewing: number; demoteProposed: string[]; admitted: string[]; free: number }
const name = (r: PairKey) => `${r.scannerId} ${r.symbol} ${r.tf}`;

/** Judge every shadow and live pair, then fill free shadow slots with the best recent candidates. */
export function evaluate(store: IncubatorStore, cfg: AppConfig, now = Date.now()): CycleReport {
  const inc = cfg.incubator;
  const rep: CycleReport = { proposed: [], retired: [], brewing: 0, demoteProposed: [], admitted: [], free: 0 };
  const active = store.list(['shadow', 'proposed']);

  if (inc.gate.pool === 'cohort') judgeCohorts(store, cfg, active, rep, now);
  else for (const r of active) judgePair(store, cfg, r, rep, now);

  for (const r of store.list(['live'])) {
    const d = demoteVerdict(store.trades(r.scannerId, r.symbol, r.tf, 0).filter(t => t.entryAt >= r.since), inc.demote);
    store.setGate(r.id, { at: now, stats: d.stats, reasons: [d.reason], decision: d.demote ? 'demote' : 'keep' }, now);
    if (d.demote) { store.move(r, 'demote_proposed', 'gate', { stats: d.stats, reason: d.reason }, d.reason, now, { keepSince: true }); rep.demoteProposed.push(name(r)); }
  }

  admit(store, cfg, rep, now);
  return rep;
}

/** One market judged on its own: the original gate, kept for `gate.pool: 'pair'`. */
function judgePair(store: IncubatorStore, cfg: AppConfig, r: PairRow, rep: CycleReport, now: number): void {
  const trades = store.trades(r.scannerId, r.symbol, r.tf, 2);
  const stats = pairStats(trades, r.since, now);
  const overlap = overlapPct(trades.filter(t => t.entryAt >= r.since), store.liveTradesOn(r.symbol, r.scannerId));
  const v = gateVerdict(stats, gateFor(cfg.incubator, r.tf), overlap);
  store.setGate(r.id, { at: now, stats, overlapPct: overlap, ...v }, now);
  if (v.decision === 'propose' && r.stage === 'shadow') { store.move(r, 'proposed', 'gate', { stats, overlap, reasons: v.reasons }, 'passed the promotion gate', now, { keepSince: true }); rep.proposed.push(name(r)); }
  else if (v.decision === 'brewing' && r.stage === 'proposed') { store.move(r, 'shadow', 'gate', { stats, reasons: v.reasons }, 'no longer passes the gate', now, { keepSince: true }); rep.brewing++; }
  else if (v.decision === 'retire') { store.move(r, 'retired', 'gate', { stats, reasons: v.reasons }, v.reasons[0], now); rep.retired.push(name(r)); }
  else if (v.decision === 'brewing') rep.brewing++;
}

/**
 * One scanner on one timeframe judged across all of its shadow markets at once.
 *
 * The cohort passes or fails together, because what is being judged is the scanner. Only the best of
 * its markets are proposed for the fleet — at most `promote.maxPerWeek`, since nothing more than that
 * can be approved in a week anyway — and the rest keep trading in the shadow book as evidence.
 */
function judgeCohorts(store: IncubatorStore, cfg: AppConfig, active: PairRow[], rep: CycleReport, now: number): void {
  const inc = cfg.incubator;
  const groups = new Map<string, PairRow[]>();
  for (const r of active) { const k = `${r.scannerId}|${r.tf}`; const g = groups.get(k); g ? g.push(r) : groups.set(k, [r]); }

  for (const rows of groups.values()) {
    const members = rows.map(r => ({ row: r, symbol: r.symbol, since: r.since, trades: store.trades(r.scannerId, r.symbol, r.tf, 2) }));
    const stats = cohortStats(members, now, inc.gate.minMarketTrades);
    let hit = 0, n = 0;
    for (const m of members) {
      const t = m.trades.filter(x => x.entryAt >= m.since);
      n += t.length; hit += overlapPct(t, store.liveTradesOn(m.symbol, m.row.scannerId)) / 100 * t.length;
    }
    const overlap = n ? hit / n * 100 : 0;
    const v = cohortVerdict(stats, gateFor(inc, rows[0].tf), overlap);
    const cohort = `${rows[0].scannerId} ${rows[0].tf} across ${rows.length} market${rows.length === 1 ? '' : 's'}`;
    for (const m of members) store.setGate(m.row.id, { at: now, cohort, stats, overlapPct: overlap, market: stats.perMarket.find(p => p.symbol === m.symbol) ?? null, ...v }, now);

    if (v.decision === 'retire') {
      for (const m of members) { store.move(m.row, 'retired', 'gate', { cohort, stats, reasons: v.reasons }, `${cohort}: ${v.reasons[0]}`, now); rep.retired.push(name(m.row)); }
      continue;
    }
    const pick = v.decision === 'propose'
      ? new Set(stats.perMarket.filter(p => p.trades >= inc.gate.minMarketTrades && p.avgR > 0).slice(0, inc.promote.maxPerWeek).map(p => p.symbol))
      : new Set<string>();
    for (const m of members) {
      const wanted = pick.has(m.symbol);
      if (wanted && m.row.stage === 'shadow') { store.move(m.row, 'proposed', 'gate', { cohort, stats, reasons: v.reasons }, `${cohort} passed the gate`, now, { keepSince: true }); rep.proposed.push(name(m.row)); }
      else if (!wanted && m.row.stage === 'proposed') { store.move(m.row, 'shadow', 'gate', { cohort, stats, reasons: v.reasons }, 'no longer proposed', now, { keepSince: true }); rep.brewing++; }
      else if (!wanted) rep.brewing++;
    }
  }
}

/**
 * Fill the free shadow slots. Under cohort gating a scanner is admitted on several markets at once,
 * because one market alone cannot produce a judgeable sample inside `gate.maxDays`; cohorts already
 * running are topped up first, and a new cohort is only started when enough of its markets passed
 * the screen to fill `admit.minCohortMarkets` slots.
 */
function admit(store: IncubatorStore, cfg: AppConfig, rep: CycleReport, now: number): void {
  const inc = cfg.incubator;
  const active = store.list(['shadow', 'proposed']);
  let slots = Math.max(0, inc.maxShadow - active.length);
  const fresh = store.list(['candidate']).filter(r => r.screen?.pass && now - (r.screen?.at ?? 0) <= 8 * DAY);
  const take = (r: PairRow) => { store.move(r, 'shadow', 'screen', { screen: r.screen, score: screenScore(r.screen) }, 'admitted to the shadow book', now); rep.admitted.push(name(r)); slots--; };

  if (inc.gate.pool !== 'cohort') {
    for (const r of fresh.sort((a, b) => screenScore(b.screen) - screenScore(a.screen)).slice(0, slots)) take(r);
    rep.free = slots;
    return;
  }

  const held = new Map<string, number>();
  for (const r of active) { const k = `${r.scannerId}|${r.tf}`; held.set(k, (held.get(k) ?? 0) + 1); }
  const byCohort = new Map<string, PairRow[]>();
  for (const r of fresh) { const k = `${r.scannerId}|${r.tf}`; const g = byCohort.get(k); g ? g.push(r) : byCohort.set(k, [r]); }

  const cohorts = [...byCohort.entries()].map(([k, rows]) => ({
    k, rows: rows.sort((a, b) => screenScore(b.screen) - screenScore(a.screen)),
    score: Math.max(...rows.map(r => screenScore(r.screen))), running: held.get(k) ?? 0,
  }));
  // top up what is already brewing before starting anything new: those markets are already earning days
  const fillable = (c: { rows: PairRow[] }) => Number(c.rows.length >= inc.admit.minCohortMarkets);
  cohorts.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || fillable(b) - fillable(a) || b.score - a.score);

  for (const c of cohorts) {
    if (slots <= 0) break;
    const room = Math.min(marketsFor(inc, c.rows[0].tf) - c.running, c.rows.length, slots);
    if (room <= 0) continue;
    if (!c.running && room < Math.min(inc.admit.minCohortMarkets, c.rows.length)) continue;
    for (const r of c.rows.slice(0, room)) take(r);
  }
  rep.free = slots;
}

export class IncubatorError extends Error { status = 409; }

/**
 * Approve a proposal. Promotion puts the market into the scanner's live symbol list; approving a
 * demotion takes it out and sends the pair back to prove itself in the shadow book.
 */
export function approve(store: IncubatorStore, cfg: AppConfig, id: number, actor: string, setScanner: (id: string, patch: Partial<ScannerConfig>) => void, now = Date.now()): PairRow {
  const r = store.get(id);
  if (!r) throw Object.assign(new IncubatorError('unknown incubator pair'), { status: 404 });
  const inc = cfg.incubator;
  const sc = cfg.scanners[r.scannerId];
  const current = sc?.enabled && !sc.hidden ? (sc.symbols ?? cfg.symbols) : [];
  if (r.stage === 'proposed') {
    const week = store.promotionsSince(now - 7 * DAY);
    if (week >= inc.promote.maxPerWeek) throw new IncubatorError(`weekly promotion limit reached (${week}/${inc.promote.maxPerWeek}); try again later or raise incubator.promote.maxPerWeek`);
    const fleet = livePairs(cfg).length;
    if (fleet >= inc.promote.maxFleet) throw new IncubatorError(`the live fleet is full (${fleet}/${inc.promote.maxFleet} pairs); demote one first or raise incubator.promote.maxFleet`);
    const stats = pairStats(store.trades(r.scannerId, r.symbol, r.tf, 2), r.since, now);
    setScanner(r.scannerId, { enabled: true, hidden: false, symbols: [...new Set([...current, r.symbol])], timeframes: [r.tf] });
    return store.move(r, 'live', actor, { shadow: stats, gate: r.gate }, 'promoted from the shadow book', now);
  }
  if (r.stage === 'demote_proposed') {
    const rest = current.filter(s => s !== r.symbol);
    setScanner(r.scannerId, rest.length ? { symbols: rest } : { enabled: false });
    return store.move(r, 'shadow', actor, { live: r.gate?.stats ?? null }, 'demoted: back to the shadow book', now);
  }
  throw new IncubatorError(`nothing to approve: the pair is ${r.stage}`);
}

/** Reject a proposal: a promotion is retired (cooldown applies); a demotion is dismissed and the pair stays live. */
export function reject(store: IncubatorStore, id: number, actor: string, note: string | null = null, now = Date.now()): PairRow {
  const r = store.get(id);
  if (!r) throw Object.assign(new IncubatorError('unknown incubator pair'), { status: 404 });
  if (r.stage === 'proposed') return store.move(r, 'retired', actor, { gate: r.gate }, note ?? 'promotion rejected', now);
  if (r.stage === 'demote_proposed') return store.move(r, 'live', actor, { gate: r.gate }, note ?? 'kept live', now, { keepSince: true });
  throw new IncubatorError(`nothing to reject: the pair is ${r.stage}`);
}

export const ACTIVE_STAGES: Stage[] = ['shadow', 'proposed'];
