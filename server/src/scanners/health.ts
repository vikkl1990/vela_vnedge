/**
 * Which scripts are worth running again.
 *
 * The library holds 2,588 TradingView scripts and a large minority cannot execute here at all: they
 * ask for series Delta does not list (SPY, VIX, NDX), they will not transpile, or they loop until
 * the worker times out. Nothing learns from that today, so the nightly screen pays for them again
 * every night — 1,516 worker crashes in one 24h window, each one a worker spawned and torn down.
 *
 * A failure that can never succeed quarantines the script after it has happened on two markets (one
 * market could be bad data). Quarantine is not a verdict on the strategy: `reason` records what
 * broke, so a PineTS upgrade can clear the runtime failures and screen them again.
 */
import type { Db } from '../db.ts';

export interface HealthRow { scannerId: string; fails: number; lastAt: number; lastError: string; reason: string | null; quarantined: boolean }

/** Failures that will repeat on every run, with the reason to record. */
const PERMANENT: Array<[RegExp, string]> = [
  [/is not a Delta market|external series are not supported/i, 'needs a market Delta does not list'],
  [/Unsupported Pine Script version/i, 'Pine version the runtime does not support'],
  [/Failed to transpile/i, 'does not transpile'],
  [/hung: no result within|timed out after/i, 'never finishes under PineTS'],
  [/source not published|Invite-only|Protected script/i, 'source not published'],
  [/is not a function|is not defined/i, 'PineTS runtime gap — re-screen after a runtime upgrade'],
];

/** The reason this failure is permanent, or null when it might be transient (data, memory, a race). */
export function permanentReason(error: string | null | undefined): string | null {
  if (!error) return null;
  for (const [re, reason] of PERMANENT) if (re.test(error)) return reason;
  return null;
}

export class ScriptHealth {
  private db: Db;
  private threshold: number;
  private cache: Set<string> | null = null;
  constructor(db: Db, threshold = 2) { this.db = db; this.threshold = threshold; }

  /** Record one failed run. Returns true when this call quarantined the script. */
  record(scannerId: string, error: string | null | undefined, at = Date.now()): boolean {
    const reason = permanentReason(error);
    if (!reason) return false;
    const cur = this.db.get<any>('SELECT fails, quarantined FROM script_health WHERE scanner_id=?', scannerId);
    const fails = (cur?.fails ?? 0) + 1;
    const quarantined = fails >= this.threshold ? 1 : 0;
    this.db.run(
      `INSERT INTO script_health(scanner_id, fails, last_at, last_error, reason, quarantined) VALUES (?,?,?,?,?,?)
       ON CONFLICT(scanner_id) DO UPDATE SET fails=excluded.fails, last_at=excluded.last_at, last_error=excluded.last_error, reason=excluded.reason, quarantined=excluded.quarantined`,
      scannerId, fails, at, String(error).slice(0, 300), reason, quarantined);
    this.cache = null;
    return !cur?.quarantined && quarantined === 1;
  }

  /** A run that worked clears the record: the script is healthy whatever happened before. */
  clear(scannerId: string): void {
    if (this.db.run('DELETE FROM script_health WHERE scanner_id=?', scannerId).changes) this.cache = null;
  }

  quarantined(): Set<string> {
    return this.cache ??= new Set(this.db.all<{ scanner_id: string }>('SELECT scanner_id FROM script_health WHERE quarantined=1').map(r => r.scanner_id));
  }
  isQuarantined(scannerId: string): boolean { return this.quarantined().has(scannerId); }

  list(): HealthRow[] {
    return this.db.all<any>('SELECT * FROM script_health ORDER BY quarantined DESC, fails DESC')
      .map(r => ({ scannerId: r.scanner_id, fails: r.fails, lastAt: r.last_at, lastError: r.last_error, reason: r.reason, quarantined: !!r.quarantined }));
  }
  /** Let every quarantined script be screened again, e.g. after a PineTS upgrade. */
  release(reasonLike?: string): number {
    const r = reasonLike
      ? this.db.run('DELETE FROM script_health WHERE quarantined=1 AND reason LIKE ?', `%${reasonLike}%`)
      : this.db.run('DELETE FROM script_health WHERE quarantined=1');
    this.cache = null;
    return Number(r.changes ?? 0);
  }
}
