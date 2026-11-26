import type { WorkerResult } from '../pine/worker.ts';
import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ExitMode } from '../config.ts';
import type { MarketInfo } from '../paper/engine.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import type { MirroredReceipt } from '../scanners/inbox.ts';
import type { PairRow } from './store.ts';

export interface ShadowDelivery {
  version: 1;
  cell: PairRow;
  scannerName: string;
  patched: string;
  sourceHash: string | null;
  fingerprint: string;
  reading: unknown;
  scan?: {
    prepareDepth: boolean;
    result: WorkerResult;
    events: ScanEvent[];
    drops: Record<string, number>;
    since: number;
    newLabelKeys: string[];
    variantOf?: string;
  };
  plansFingerprint?: string;
  event: ScanEvent;
  bars: Bar[];
  market: MarketInfo;
  lastBar: Bar;
  exitMode: ExitMode;
  target: { positionId: number | null; pendingIds: number[] };
  accountTarget?: MirroredReceipt;
  receivedAt: number;
}
export interface ShadowReceipt {
  id: string;
  kind: string;
  payload: string | null;
  account_done: number;
  shadow_done: number;
  compare_done: number;
  received_at: number;
  attempts: number;
}
export class ShadowInbox {
  constructor(privateDb: Db) {
    this.db = privateDb;
    privateDb.run(`CREATE TABLE IF NOT EXISTS shadow_signal_inbox(
      id TEXT PRIMARY KEY,kind TEXT NOT NULL,received_at INTEGER NOT NULL,payload TEXT,
      account_done INTEGER NOT NULL DEFAULT 0,shadow_done INTEGER NOT NULL DEFAULT 0,compare_done INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,outcome TEXT,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,completed_at INTEGER)`);
    privateDb.run(
      'CREATE INDEX IF NOT EXISTS shadow_inbox_open ON shadow_signal_inbox(received_at) WHERE completed_at IS NULL',
    );
    privateDb.run('CREATE INDEX IF NOT EXISTS shadow_inbox_completed ON shadow_signal_inbox(completed_at)');
    privateDb.run(
      'CREATE INDEX IF NOT EXISTS shadow_inbox_pending ON shadow_signal_inbox(shadow_done,account_done,received_at)',
    );
  }
  readonly db: Db;
  accept(deliveries: ShadowDelivery[], advance: () => void): ShadowReceipt[] {
    return this.db.transaction(() => {
      const rows: ShadowReceipt[] = [];
      for (const d of deliveries) {
        const e = d.event,
          c = d.cell;
        const id = createHash('sha256')
          .update(
            JSON.stringify([
              c.scannerId,
              c.symbol,
              c.tf,
              e.barTime,
              d.scan ? 'scan' : e.kind,
              d.scan ? null : e.side,
              d.scan ? 'scan-output' : e.label,
              d.scan ? null : e.exitType,
            ]),
          )
          .digest('hex');
        this.db.run(
          'INSERT OR IGNORE INTO shadow_signal_inbox(id,kind,received_at,payload) VALUES(?,?,?,?)',
          id,
          d.scan ? 'scan' : e.kind,
          d.receivedAt,
          JSON.stringify(d),
        );
        rows.push(this.db.get<ShadowReceipt>('SELECT * FROM shadow_signal_inbox WHERE id=?', id)!);
      }
      advance();
      return rows;
    });
  }
  pending() {
    return this.db.all<ShadowReceipt>(
      "SELECT * FROM shadow_signal_inbox WHERE completed_at IS NULL AND (account_done=0 OR shadow_done=0 OR compare_done=0) AND retry_at<=? ORDER BY CASE kind WHEN 'exit' THEN 0 WHEN 'scan' THEN 1 ELSE 2 END,received_at LIMIT 100",
      Date.now(),
    );
  }
  status() {
    return this.db.get<{ pending: number; oldest: number | null; failed: number }>(
      'SELECT count(*) pending,min(received_at) oldest,coalesce(sum(last_error IS NOT NULL),0) failed FROM shadow_signal_inbox WHERE completed_at IS NULL',
    );
  }
  prune(now = Date.now()) {
    this.db.run(
      'DELETE FROM shadow_signal_inbox WHERE id IN (SELECT id FROM shadow_signal_inbox WHERE completed_at<? LIMIT 500)',
      now - 14 * 86400000,
    );
  }
  current(id: string) {
    return this.db.get<ShadowReceipt>('SELECT * FROM shadow_signal_inbox WHERE id=?', id)!;
  }
  finish(id: string, part: 'account' | 'shadow' | 'compare', outcome: string) {
    this.db.run(`UPDATE shadow_signal_inbox SET ${part}_done=1,outcome=? WHERE id=?`, outcome, id);
    this.db.run(
      'UPDATE shadow_signal_inbox SET payload=NULL,last_error=NULL,completed_at=? WHERE id=? AND account_done=1 AND shadow_done=1 AND compare_done=1',
      Date.now(),
      id,
    );
  }
  fail(id: string) {
    this.db.run(
      "UPDATE shadow_signal_inbox SET attempts=attempts+1,last_error='decision interrupted; retry pending',retry_at=? WHERE id=?",
      Date.now() + 1000,
      id,
    );
  }
}
