/**
 * One incubator cycle, and the owner's approve/reject actions. Shared by the daily job and the API.
 */
import type { AppConfig, IncubatorConfig, ScannerConfig } from '../config.ts';
import { IncubatorStore, type PairRow, type Stage } from './store.ts';
import { demoteVerdict, gateVerdict, overlapPct, pairStats, screenScore } from './gate.ts';

export interface ScreenResult {
  pass: boolean; at: number; trades: number; profitFactor: number; netPnl: number; netAtStress: number;
  windowsUp: number; winRatePct: number; avgR: number; bars: number; days: number;
}

type PairKey = { scannerId: string; symbol: string; tf: string };
const DAY = 86400_000;

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

  for (const r of store.list(['shadow', 'proposed'])) {
    const stats = pairStats(store.trades(r.scannerId, r.symbol, r.tf, 2), r.since, now);
    const shadowTrades = store.trades(r.scannerId, r.symbol, r.tf, 2).filter(t => t.entryAt >= r.since);
    const overlap = overlapPct(shadowTrades, store.liveTradesOn(r.symbol, r.scannerId));
    const v = gateVerdict(stats, inc.gate, overlap);
    store.setGate(r.id, { at: now, stats, overlapPct: overlap, ...v }, now);
    if (v.decision === 'propose' && r.stage === 'shadow') { store.move(r, 'proposed', 'gate', { stats, overlap, reasons: v.reasons }, 'passed the promotion gate', now, { keepSince: true }); rep.proposed.push(name(r)); }
    else if (v.decision !== 'propose' && r.stage === 'proposed' && v.decision === 'brewing') { store.move(r, 'shadow', 'gate', { stats, reasons: v.reasons }, 'no longer passes the gate', now, { keepSince: true }); rep.brewing++; }
    else if (v.decision === 'retire') { store.move(r, 'retired', 'gate', { stats, reasons: v.reasons }, v.reasons[0], now); rep.retired.push(name(r)); }
    else if (v.decision === 'brewing') rep.brewing++;
  }

  for (const r of store.list(['live'])) {
    const d = demoteVerdict(store.trades(r.scannerId, r.symbol, r.tf, 0).filter(t => t.entryAt >= r.since), inc.demote);
    store.setGate(r.id, { at: now, stats: d.stats, reasons: [d.reason], decision: d.demote ? 'demote' : 'keep' }, now);
    if (d.demote) { store.move(r, 'demote_proposed', 'gate', { stats: d.stats, reason: d.reason }, d.reason, now, { keepSince: true }); rep.demoteProposed.push(name(r)); }
  }

  const occupied = store.list(['shadow', 'proposed']).length;
  const free = Math.max(0, inc.maxShadow - occupied);
  const fresh = store.list(['candidate']).filter(r => r.screen?.pass && now - (r.screen?.at ?? 0) <= 8 * DAY);
  const ranked = fresh.sort((a, b) => screenScore(b.screen) - screenScore(a.screen)).slice(0, free);
  for (const r of ranked) { store.move(r, 'shadow', 'screen', { screen: r.screen, score: screenScore(r.screen) }, 'admitted to the shadow book', now); rep.admitted.push(name(r)); }
  rep.free = free - ranked.length;
  return rep;
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
