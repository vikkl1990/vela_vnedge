/** Opt-in research semantics. An entry/opposite marker is never itself an invalidation. */
import type {ExitType, ScanEvent} from '../scanners/extractor.ts';
import type {Db} from '../db.ts';

export const SETUP_LIFECYCLE = 'confirmed-exit-v1' as const;

/** Milestones and stop amendments keep a setup alive. These notifications end it. */
export function invalidatesSetup(exit: ExitType): boolean {
  return ['close', 'flip', 'sl', 'be'].includes(exit);
}

export type SetupExitEvent = Pick<ScanEvent, 'barTime' | 'source' | 'label'>;

export function initSetupLifecycle(db: Db): void {
  db.run(`CREATE TABLE IF NOT EXISTS paper_setup_exits (
    book INTEGER NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
    event_key TEXT NOT NULL, at INTEGER NOT NULL, position_id INTEGER,
    pending_ids TEXT NOT NULL, PRIMARY KEY(book,scanner_id,symbol,tf,event_key))`);
}

/** Called inside the same decision transaction as cancellations and the close request. */
export function claimSetupExit(db: Db, input: {
  book: number; scannerId: string; symbol: string; tf: string; at: number;
  exitType: ExitType; side?: string; event?: SetupExitEvent;
  positionId: number | null; pendingIds: number[];
}): boolean {
  const key = input.event
    ? [input.event.barTime, input.event.source, input.event.label, input.exitType, input.side ?? null]
    : [input.at, input.exitType, input.side ?? null];
  return db.run('INSERT OR IGNORE INTO paper_setup_exits VALUES(?,?,?,?,?,?,?,?)',
    input.book, input.scannerId, input.symbol, input.tf, JSON.stringify(key), input.at,
    input.positionId, JSON.stringify(input.pendingIds)).changes > 0;
}
