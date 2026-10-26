/**
 * Incubator state: which stage each scanner/market pair is in, and an audit trail of every move.
 *
 *   candidate ──▶ shadow ──▶ proposed ──(approve)──▶ live ──▶ demote_proposed ──(approve)──▶ shadow
 *        ▲            │           │                                  │
 *        │            └──────▶ retired ◀──(reject)───────────────────┘ (keep: back to live)
 *        └──── after cooldown ────┘
 *
 * The daily job (`npm run incubate`) and the bot both use this; SQLite in WAL mode with a busy
 * timeout lets them share the file.
 */
import type { Db } from '../db.ts';
import type { TradeR } from './gate.ts';

/** `tracked` (decision 139): shadow-traded for an operator's tracker, outside the gate, the slots, the screen and the mirror. */
export type Stage = 'candidate' | 'shadow' | 'proposed' | 'live' | 'demote_proposed' | 'retired' | 'tracked';
export const STAGES: Stage[] = ['proposed', 'demote_proposed', 'shadow', 'candidate', 'live', 'retired'];

export interface PairRow {
  id: number; scannerId: string; symbol: string; tf: string; stage: Stage; since: number; updated: number;
  screen: any | null; gate: any | null; note: string | null;
}

export interface EventRow { id: number; at: number; pairId: number; scannerId: string; symbol: string; tf: string; from: Stage | null; to: Stage; actor: string; evidence: any | null }

const toPair = (r: any): PairRow => ({
  id: r.id, scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, stage: r.stage, since: r.since, updated: r.updated,
  screen: r.screen ? JSON.parse(r.screen) : null, gate: r.gate ? JSON.parse(r.gate) : null, note: r.note,
});

/** Decision 190: `pending` is an order resting or waiting to fill; it is not an opened trade until it fills, and a lapsed one counts as `other`. */
export interface SignalFunnel { entries: number; opened: number; pending: number; regime: number; cost: number; market: number; quote: number; other: number; lastOpenAt: number | null }
/** The gate an entry signal's recorded action names (decision 112); the same words the Signals page shows. */
export function funnelClass(action: string): 'opened' | 'pending' | 'regime' | 'cost' | 'market' | 'quote' | 'other' {
  if (action === 'opened' || action === 'reversed') return 'opened';
  if (action.startsWith('pending')) return 'pending';
  if (action.startsWith('rejected:risk regime')) return 'regime';
  if (action.startsWith('rejected:stop too tight')) return 'cost';
  if (action.startsWith('rejected:risk market')) return 'market';
  if (action.startsWith('rejected:unpriceable')) return 'quote';
  return 'other';
}

export class IncubatorStore {
  private db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: number): PairRow | null { const r = this.db.get('SELECT * FROM incubator_pairs WHERE id=?', id); return r ? toPair(r) : null; }
  /**
   * The market gate's verdict per market as the risk layer last wrote it (decision 104): `true`
   * allowed, `false` refused with its reasons, `null` never judged. The account refuses entries on a
   * refused market, so the judge must not propose one and the admission must not fill a slot with one.
   */
  /**
   * Decision 112: what became of a live cell's entry signals since `since` — opened, or which gate refused them.
   * The account's own record from the signals table; the shadow runner keeps the same shape for shadow pairs.
   */
  signalFunnel(scannerId: string, symbol: string, tf: string, since: number): SignalFunnel {
    const rows = this.db.all<{ action: string; at: number }>("SELECT action, at FROM signals WHERE kind='entry' AND scanner_id=? AND symbol=? AND tf=? AND at>=?", scannerId, symbol, tf, since);
    const f: SignalFunnel = { entries: 0, opened: 0, pending: 0, regime: 0, cost: 0, market: 0, quote: 0, other: 0, lastOpenAt: null };
    for (const r of rows) { f.entries++; const k = funnelClass(r.action); f[k]++; if (k === 'opened') f.lastOpenAt = Math.max(f.lastOpenAt ?? 0, r.at); }
    return f;
  }

  /** Decision 112: the shadow runner's record of what became of each shadow pair's signals, by pair key: [at, class] pairs, newest last. */
  shadowFunnel(): Record<string, Array<[number, string]>> { return this.db.kvGet<Record<string, Array<[number, string]>>>('incubator.shadowFunnel') ?? {}; }
  setShadowFunnel(rec: Record<string, Array<[number, string]>>): void { this.db.kvSet('incubator.shadowFunnel', rec); }

  /** Decision 109: since when each live pair's market has been out (refused or not judged), by pair key; cleared the day it is allowed again. */
  /** Decision 125: the last bar each shadow pair acted on. */
  liveMarks(): Record<string, number> | undefined { return this.db.kvGet<Record<string, number>>('incubator.liveMarks'); }
  setDispatchStats(rec: Record<string,number>): void { this.db.kvSet('incubator.dispatch',rec); }
  setLiveMarks(rec: Record<string, number>): void { this.db.kvSet('incubator.liveMarks', rec); }
  /** Decision 132: when this cell was last admitted to the shadow book by the screen, so a cell returning from the account keeps that evidence window. */
  admittedAt(pairId: number): number | null {
    const r = this.db.get<{ at: number }>("SELECT at FROM incubator_events WHERE pair_id=? AND to_stage='shadow' AND actor='screen' ORDER BY at DESC LIMIT 1", pairId);
    return r?.at ?? null;
  }
  marketOut(): Record<string, number> { return this.db.kvGet<Record<string, number>>('incubator.marketOut') ?? {}; }
  setMarketOut(rec: Record<string, number>): void { this.db.kvSet('incubator.marketOut', rec); }

  /** Decision 184: how old the market gate's verdicts may be before the incubator treats them as stale (three refreshes). */
  marketStaleMs = 3 * 3600_000;
  marketsToday(now = Date.now(), maxAgeMs = this.marketStaleMs): Map<string, { allowed: boolean; reasons: string[]; turnoverUsd: number | null; stale?: boolean }> {
    const kv = this.db.kvGet<{ enabled?: boolean; at?: number; markets?: Array<{ symbol: string; allowed: boolean; reasons?: string[]; turnoverUsd?: number | null }> }>('risk.marketsToday');
    const out = new Map<string, { allowed: boolean; reasons: string[]; turnoverUsd: number | null; stale?: boolean }>();
    if (!kv || kv.enabled === false) return out;
    // decision 184: verdicts older than three refreshes are stale; the account's own gate already refuses on them, and
    // the incubator's proposals and admissions wait as well (the screen's universe keeps the last verdicts)
    const stale = typeof kv.at === 'number' && now - kv.at > maxAgeMs;
    for (const m of kv.markets ?? []) out.set(m.symbol, { allowed: Boolean(m.allowed), reasons: m.reasons ?? [], turnoverUsd: typeof m.turnoverUsd === 'number' ? m.turnoverUsd : null, ...(stale ? { stale: true } : {}) });
    return out;
  }

  find(scannerId: string, symbol: string, tf: string): PairRow | null {
    const r = this.db.get('SELECT * FROM incubator_pairs WHERE scanner_id=? AND symbol=? AND tf=?', scannerId, symbol, tf);
    return r ? toPair(r) : null;
  }
  list(stages?: Stage[]): PairRow[] {
    const rows = stages?.length
      ? this.db.all(`SELECT * FROM incubator_pairs WHERE stage IN (${stages.map(() => '?').join(',')}) ORDER BY updated DESC`, ...stages)
      : this.db.all('SELECT * FROM incubator_pairs ORDER BY updated DESC');
    return rows.map(toPair);
  }
  counts(): Record<string, number> {
    return Object.fromEntries(this.db.all<{ stage: string; n: number }>('SELECT stage, COUNT(*) n FROM incubator_pairs GROUP BY stage').map(r => [r.stage, r.n]));
  }

  /** Create the pair in `stage`, or move it there, and log the move with its evidence. */
  move(p: { scannerId: string; symbol: string; tf: string }, to: Stage, actor: string, evidence: any = null, note: string | null = null, at = Date.now(), opts: { keepSince?: boolean; since?: number } = {}): PairRow {
    return this.db.transaction(() => {
      const cur = this.find(p.scannerId, p.symbol, p.tf);
      if (cur && cur.stage === to) {
        this.db.run('UPDATE incubator_pairs SET updated=?, note=COALESCE(?, note) WHERE id=?', at, note, cur.id);
        return this.get(cur.id)!;
      }
      let id: number;
      // keepSince: shadow ⇄ proposed and live → demote_proposed are judged on the same evidence window
      if (cur) { this.db.run('UPDATE incubator_pairs SET stage=?, since=?, updated=?, note=? WHERE id=?', to, opts.since ?? (opts.keepSince ? cur.since : at), at, note, cur.id); id = cur.id; }
      else id = Number(this.db.run('INSERT INTO incubator_pairs(scanner_id, symbol, tf, stage, since, updated, note) VALUES (?,?,?,?,?,?,?)', p.scannerId, p.symbol, p.tf, to, at, at, note).lastInsertRowid);
      this.db.run('INSERT INTO incubator_events(at, pair_id, scanner_id, symbol, tf, from_stage, to_stage, actor, evidence) VALUES (?,?,?,?,?,?,?,?,?)',
        at, id, p.scannerId, p.symbol, p.tf, cur?.stage ?? null, to, actor, evidence === null ? null : JSON.stringify(evidence));
      return this.get(id)!;
    });
  }

  /**
   * Decision 151: the engine changed under the pair, so its evidence restarts. The stage stays; `since` (the start of the
   * window the gate judges, and of its deadline clock) moves to `at`. Logged as an event from the stage to itself.
   */
  restartEvidence(id: number, actor: string, note: string, at = Date.now()): PairRow | null {
    const cur = this.get(id); if (!cur) return null;
    this.db.transaction(() => {
      this.db.run('UPDATE incubator_pairs SET since=?, updated=?, note=? WHERE id=?', at, at, note, id);
      this.db.run('INSERT INTO incubator_events(at, pair_id, scanner_id, symbol, tf, from_stage, to_stage, actor, evidence) VALUES (?,?,?,?,?,?,?,?,?)',
        at, id, cur.scannerId, cur.symbol, cur.tf, cur.stage, cur.stage, actor, JSON.stringify({ restarted: { since: cur.since, note } }));
    });
    return this.get(id);
  }
  /** Decision 151: a candidate's screen was made on another engine; it is kept for the record but no longer admits the pair. */
  expireScreen(id: number, actor: string, note: string, at = Date.now()): PairRow | null {
    const cur = this.get(id); if (!cur?.screen) return cur ?? null;
    this.db.transaction(() => {
      this.db.run('UPDATE incubator_pairs SET screen=?, updated=?, note=? WHERE id=?', JSON.stringify({ ...cur.screen, at: 0, expiredAt: at, expiredBy: note }), at, note, id);
      this.db.run('INSERT INTO incubator_events(at, pair_id, scanner_id, symbol, tf, from_stage, to_stage, actor, evidence) VALUES (?,?,?,?,?,?,?,?,?)',
        at, id, cur.scannerId, cur.symbol, cur.tf, cur.stage, cur.stage, actor, JSON.stringify({ screenExpired: { at: cur.screen.at, note } }));
    });
    return this.get(id);
  }

  setScreen(id: number, screen: any, at = Date.now()) { this.db.run('UPDATE incubator_pairs SET screen=?, updated=? WHERE id=?', JSON.stringify(screen), at, id); }
  setGate(id: number, gate: any, at = Date.now()) { this.db.run('UPDATE incubator_pairs SET gate=?, updated=? WHERE id=?', JSON.stringify(gate), at, id); }

  events(limit = 100, pairId?: number): EventRow[] {
    const rows = pairId
      ? this.db.all('SELECT * FROM incubator_events WHERE pair_id=? ORDER BY at DESC, id DESC LIMIT ?', pairId, limit)
      : this.db.all('SELECT * FROM incubator_events ORDER BY at DESC, id DESC LIMIT ?', limit);
    return rows.map((r: any) => ({ id: r.id, at: r.at, pairId: r.pair_id, scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, from: r.from_stage, to: r.to_stage, actor: r.actor, evidence: r.evidence ? JSON.parse(r.evidence) : null }));
  }

  /**
   * Decision 171: the pair's last demotion (live or demote_proposed → shadow) and the gate's reason for it, read from the
   * demotion proposal that preceded it; the reason is null for the operator's own demotion. Null if never demoted.
   */
  lastDemotion(pairId: number): { at: number; reason: string | null } | null {
    const d = this.db.get<{ at: number; from_stage: string; evidence: string | null }>("SELECT at, from_stage, evidence FROM incubator_events WHERE pair_id=? AND from_stage IN ('live','demote_proposed') AND to_stage='shadow' ORDER BY at DESC, id DESC LIMIT 1", pairId);
    if (!d) return null;
    // decision 184: a demotion straight from live (the operator's) carries its own reason in its event; only one that
    // went through a proposal reads the proposal's (a rejected, older proposal is not this demotion's reason)
    if (d.from_stage !== 'demote_proposed') { let own: string | null = null; try { own = d.evidence ? (JSON.parse(d.evidence)?.reason ?? null) : null; } catch { own = null; } return { at: d.at, reason: own }; }
    const p = this.db.get<{ evidence: string | null }>("SELECT evidence FROM incubator_events WHERE pair_id=? AND to_stage='demote_proposed' AND at<=? ORDER BY at DESC, id DESC LIMIT 1", pairId, d.at);
    let reason: string | null = null;
    try { reason = p?.evidence ? (JSON.parse(p.evidence)?.reason ?? null) : null; } catch { reason = null; }
    return { at: d.at, reason };
  }

  /** Promotions to live since `since`, for the weekly limit. */
  promotionsSince(since: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM incubator_events WHERE to_stage='live' AND from_stage='proposed' AND at>=?", since)?.n ?? 0;
  }

  /** Closed trades of one pair in one book (0 live, 2 shadow), in R. */
  trades(scannerId: string, symbol: string, tf: string, book: number): TradeR[] {
    return this.db.all<any>(`SELECT side, entry_at, exit_at, realized_pnl, fees, risk_amount, peak_r FROM positions WHERE bt=? AND status='closed' AND scanner_id=? AND symbol=? AND tf=? AND risk_amount > 0 ORDER BY exit_at`, book, scannerId, symbol, tf)
      .map(r => ({ entryAt: r.entry_at, exitAt: r.exit_at, r: (r.realized_pnl - r.fees) / r.risk_amount, side: r.side, peakR: r.peak_r ?? undefined }));
  }
  /** Closed live trades on a market, any scanner: the overlap check compares against these. */
  liveTradesOn(symbol: string, excludeScanner?: string): TradeR[] {
    return this.db.all<any>(`SELECT side, entry_at, exit_at, realized_pnl, fees, risk_amount, scanner_id FROM positions WHERE bt=0 AND status='closed' AND symbol=? AND risk_amount > 0`, symbol)
      .filter(r => r.scanner_id !== excludeScanner)
      .map(r => ({ entryAt: r.entry_at, exitAt: r.exit_at, r: (r.realized_pnl - r.fees) / r.risk_amount, side: r.side }));
  }
  openShadowCount(scannerId: string, symbol: string, tf: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM positions WHERE bt=2 AND status='open' AND scanner_id=? AND symbol=? AND tf=?", scannerId, symbol, tf)?.n ?? 0;
  }
}
