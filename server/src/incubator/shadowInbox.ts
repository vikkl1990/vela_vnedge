/**
 * Durable receipts for the shadow book (improvement plan S2).
 *
 * A shadow run used to advance its persisted bar watermark before any event reached the
 * shadow PaperEngine, with duplicates tracked only in memory. A process kill between the two
 * lost that bar's events for good — including script exits of held shadow positions — because
 * the next run reads only after the watermark.
 *
 * Now every event a run will apply to the shadow book is written here in the same transaction
 * that advances the watermark. The shadow decision and its receipt completion share one
 * `PaperEngine.commitDecision`. Startup and a timer retry pending receipts, exits first, under
 * the same conservative rules as the account inbox: an entry expires after at most 60 s and
 * needs an unchanged source and scanner reading; a recovered exit can touch only the position
 * it was received for.
 *
 * This boundary covers the shadow book only. Account mirroring keeps its own inbox.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ExitMode } from '../config.ts';
import type { MarketInfo } from '../paper/engine.ts';
import type { ScanEvent } from '../scanners/extractor.ts';

/** Bars kept in a receipt: enough for ATR, regime and the ML trend features (EMA200). */
export const SHADOW_RECEIPT_BARS = 300;
/** Completed receipts are kept this long for duplicate detection, then pruned. */
export const SHADOW_RECEIPT_KEEP_MS = 14 * 86_400_000;

export interface ShadowDelivery {
  version: 1;
  pairId: number; scannerId: string; scannerName: string; symbol: string; tf: string;
  ev: ScanEvent; bars: Bar[]; market: MarketInfo; exitMode: ExitMode; lastBar: Bar;
  /** Patched source and scanner reading at receipt; recovery refuses an entry when either changed. */
  sourceHash: string | null; scannerConfig: string;
  /** The shadow position an exit was received for (null when none was held). */
  targetPositionId: number | null;
}
export interface ShadowReceipt { event_key: string; kind: string; received_at: number; state: 'pending' | 'done'; payload: string | null; attempts: number }

export const shadowEventKey = (d: Pick<ShadowDelivery, 'scannerId' | 'symbol' | 'tf' | 'ev'>) => createHash('sha256').update(JSON.stringify([
  'shadow', d.scannerId, d.symbol, d.tf, d.ev.barTime, d.ev.kind, d.ev.side ?? null, d.ev.label, d.ev.exitType ?? null,
])).digest('hex');

export class ShadowInbox {
  private db: Db;
  private lastPrune = 0;
  constructor(db: Db) {
    this.db = db;
    db.run(`CREATE TABLE IF NOT EXISTS shadow_inbox (
      event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
      received_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done')),
      payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
      last_error TEXT, completed_at INTEGER, outcome TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS shadow_inbox_state ON shadow_inbox(state,received_at)');
  }

  /**
   * Record receipts for a run's events and run `advance` (the watermark move) in one transaction.
   * Returns the receipts this call created; an event that already has a receipt (any state) is
   * a duplicate and is not returned.
   */
  acceptAll(deliveries: ShadowDelivery[], at: number, advance: () => void): ShadowReceipt[] {
    return this.db.transaction(() => {
      const created: ShadowReceipt[] = [];
      for (const d of deliveries) {
        const key = shadowEventKey(d);
        const payload = JSON.stringify({ ...d, bars: d.bars.slice(-SHADOW_RECEIPT_BARS) });
        const r = this.db.run(`INSERT OR IGNORE INTO shadow_inbox(event_key,kind,scanner_id,symbol,tf,received_at,state,payload)
          VALUES(?,?,?,?,?,?,'pending',?)`, key, d.ev.kind, d.scannerId, d.symbol, d.tf, at, payload);
        if (r.changes) created.push(this.get(key)!);
      }
      advance();
      return created;
    });
  }

  get(key: string): ShadowReceipt | undefined { return this.db.get<ShadowReceipt>('SELECT * FROM shadow_inbox WHERE event_key=?', key); }
  /** Pending receipts, exits first, then the least recently attempted. */
  pending(limit = 100): ShadowReceipt[] {
    return this.db.all("SELECT * FROM shadow_inbox WHERE state='pending' ORDER BY CASE kind WHEN 'exit' THEN 0 ELSE 1 END,COALESCE(last_attempt_at,0),received_at LIMIT ?", limit);
  }
  attempt(key: string, at = Date.now()) { this.db.run("UPDATE shadow_inbox SET attempts=attempts+1,last_attempt_at=? WHERE event_key=? AND state='pending'", at, key); }
  fail(key: string, error: unknown) { this.db.run("UPDATE shadow_inbox SET last_error=? WHERE event_key=? AND state='pending'", String((error as Error)?.message ?? error).slice(0, 300), key); }
  /** Must run inside the shadow decision's transaction. */
  complete(key: string, outcome: string, at = Date.now()) {
    if (!this.db.inTransaction) throw new Error('shadow receipt must complete inside its decision transaction');
    this.db.run("UPDATE shadow_inbox SET state='done',payload=NULL,completed_at=?,outcome=?,last_error=NULL WHERE event_key=? AND state='pending'", at, outcome.slice(0, 200), key);
  }
  prune(now = Date.now()): number {
    if (now - this.lastPrune < 3600_000) return 0;
    this.lastPrune = now;
    return Number(this.db.run("DELETE FROM shadow_inbox WHERE state='done' AND completed_at<?", now - SHADOW_RECEIPT_KEEP_MS).changes ?? 0);
  }
  status() {
    return this.db.get<{ pending: number; oldest: number | null; failed: number }>(
      "SELECT COUNT(*) pending,MIN(received_at) oldest,COALESCE(SUM(last_error IS NOT NULL),0) failed FROM shadow_inbox WHERE state='pending'");
  }
}
