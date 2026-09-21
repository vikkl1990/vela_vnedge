/**
 * Nightly SQLite snapshots (`VACUUM INTO data/backups/vnedge-YYYYMMDD-HHMMSS.db`) with
 * retention, plus on-demand runs for `POST /api/ops/backup`.
 */
import path from 'node:path';
import type { Db, BackupResult } from '../db.ts';
import { logger } from '../log.ts';

const log = logger.scoped('backup');

export interface BackupStatus {
  dir: string;
  lastAt: number | null;
  lastFile: string | null;
  lastBytes: number | null;
  lastMs: number | null;
  lastError: string | null;
  count: number;
  failures: number;
  nextAt: number | null;
  running: boolean;
}

export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<BackupResult> | null = null;
  private state = { lastAt: null as number | null, lastFile: null as string | null, lastBytes: null as number | null, lastMs: null as number | null, lastError: null as string | null, count: 0, failures: 0 };

  private db: Db;
  readonly dir: string;
  private cfg: () => { hourUtc: number; keepDays: number };

  constructor(db: Db, dir: string, cfg: () => { hourUtc: number; keepDays: number }) {
    this.db = db; this.dir = dir; this.cfg = cfg;
    const persisted = db.kvGet<{ at: number; file: string; bytes: number }>('ops.backup.last');
    if (persisted) { this.state.lastAt = persisted.at; this.state.lastFile = persisted.file; this.state.lastBytes = persisted.bytes; }
  }

  /** Run a snapshot now. Concurrent calls share the in-flight run. */
  run(reason = 'manual'): Promise<BackupResult> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const r = this.db.backup(this.dir, this.cfg().keepDays);
        this.state.lastAt = r.at; this.state.lastFile = r.file; this.state.lastBytes = r.bytes; this.state.lastMs = r.ms; this.state.lastError = null; this.state.count++;
        try { this.db.kvSet('ops.backup.last', { at: r.at, file: r.file, bytes: r.bytes }); } catch { /* non-fatal */ }
        log.info(`snapshot (${reason}): ${path.basename(r.file)} ${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${r.ms} ms${r.pruned.length ? `, pruned ${r.pruned.length}` : ''}`);
        return r;
      } catch (e: any) {
        this.state.failures++; this.state.lastError = String(e?.message ?? e).slice(0, 300);
        log.error(`snapshot (${reason}) failed: ${this.state.lastError}`);
        throw e;
      } finally { this.running = null; }
    })();
    return this.running;
  }

  /** Next scheduled run: today at `hourUtc` if still ahead, else tomorrow. */
  nextAt(now = Date.now()): number {
    const d = new Date(now); d.setUTCHours(this.cfg().hourUtc, 0, 0, 0);
    if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }

  /** Check once a minute whether the scheduled time has passed since the last run. */
  start() {
    this.stop();
    this.timer = setInterval(() => {
      const now = Date.now();
      const due = this.nextAt(now - 86_400_000); // the most recent scheduled instant at or before now
      if (due <= now && (this.state.lastAt === null || this.state.lastAt < due)) void this.run('scheduled').catch(() => { /* logged */ });
    }, 60_000);
    this.timer.unref();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  status(): BackupStatus { return { dir: this.dir, ...this.state, nextAt: this.nextAt(), running: this.running !== null }; }
}
