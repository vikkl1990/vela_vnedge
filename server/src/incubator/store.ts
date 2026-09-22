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

export type Stage = 'candidate' | 'shadow' | 'proposed' | 'live' | 'demote_proposed' | 'retired';
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

export class IncubatorStore {
  private db: Db;
  constructor(db: Db) { this.db = db; }

  get(id: number): PairRow | null { const r = this.db.get('SELECT * FROM incubator_pairs WHERE id=?', id); return r ? toPair(r) : null; }
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
  move(p: { scannerId: string; symbol: string; tf: string }, to: Stage, actor: string, evidence: any = null, note: string | null = null, at = Date.now(), opts: { keepSince?: boolean } = {}): PairRow {
    return this.db.transaction(() => {
      const cur = this.find(p.scannerId, p.symbol, p.tf);
      if (cur && cur.stage === to) {
        this.db.run('UPDATE incubator_pairs SET updated=?, note=COALESCE(?, note) WHERE id=?', at, note, cur.id);
        return this.get(cur.id)!;
      }
      let id: number;
      // keepSince: shadow ⇄ proposed and live → demote_proposed are judged on the same evidence window
      if (cur) { this.db.run('UPDATE incubator_pairs SET stage=?, since=?, updated=?, note=? WHERE id=?', to, opts.keepSince ? cur.since : at, at, note, cur.id); id = cur.id; }
      else id = Number(this.db.run('INSERT INTO incubator_pairs(scanner_id, symbol, tf, stage, since, updated, note) VALUES (?,?,?,?,?,?,?)', p.scannerId, p.symbol, p.tf, to, at, at, note).lastInsertRowid);
      this.db.run('INSERT INTO incubator_events(at, pair_id, scanner_id, symbol, tf, from_stage, to_stage, actor, evidence) VALUES (?,?,?,?,?,?,?,?,?)',
        at, id, p.scannerId, p.symbol, p.tf, cur?.stage ?? null, to, actor, evidence === null ? null : JSON.stringify(evidence));
      return this.get(id)!;
    });
  }

  setScreen(id: number, screen: any, at = Date.now()) { this.db.run('UPDATE incubator_pairs SET screen=?, updated=? WHERE id=?', JSON.stringify(screen), at, id); }
  setGate(id: number, gate: any, at = Date.now()) { this.db.run('UPDATE incubator_pairs SET gate=?, updated=? WHERE id=?', JSON.stringify(gate), at, id); }

  events(limit = 100, pairId?: number): EventRow[] {
    const rows = pairId
      ? this.db.all('SELECT * FROM incubator_events WHERE pair_id=? ORDER BY at DESC, id DESC LIMIT ?', pairId, limit)
      : this.db.all('SELECT * FROM incubator_events ORDER BY at DESC, id DESC LIMIT ?', limit);
    return rows.map((r: any) => ({ id: r.id, at: r.at, pairId: r.pair_id, scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, from: r.from_stage, to: r.to_stage, actor: r.actor, evidence: r.evidence ? JSON.parse(r.evidence) : null }));
  }

  /** Promotions to live since `since`, for the weekly limit. */
  promotionsSince(since: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM incubator_events WHERE to_stage='live' AND from_stage='proposed' AND at>=?", since)?.n ?? 0;
  }

  /** Closed trades of one pair in one book (0 live, 2 shadow), in R. */
  trades(scannerId: string, symbol: string, tf: string, book: number): TradeR[] {
    return this.db.all<any>(`SELECT side, entry_at, exit_at, realized_pnl, fees, risk_amount FROM positions WHERE bt=? AND status='closed' AND scanner_id=? AND symbol=? AND tf=? AND risk_amount > 0 ORDER BY exit_at`, book, scannerId, symbol, tf)
      .map(r => ({ entryAt: r.entry_at, exitAt: r.exit_at, r: (r.realized_pnl - r.fees) / r.risk_amount, side: r.side }));
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
