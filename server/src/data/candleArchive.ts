/**
 * A permanent archive of closed candles (phase 2 groundwork). Delta serves only a few weeks of 1m and 5m history, and the
 * candle store keeps bars in memory only, so a 5m edge could never be tested on more than ~40 days. This archive keeps
 * every closed 1m and 5m bar of the markets the bot follows in its own SQLite file (data/archive.db), back-filled as
 * far as Delta allows on first sight of a market and topped up from the newest archived bar after that. It is never
 * pruned. Research reads it with `bars()`; nothing in trading depends on it.
 */
import { DatabaseSync } from 'node:sqlite';

export interface ArchiveBar { time: number; open: number; high: number; low: number; close: number; volume: number }
/** Delta's candle shape: `time` in seconds. */
export interface SourceCandle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ArchiveDeps {
  /** Candles for [startSec, endSec] at a resolution ('1m', '5m'); pages internally. */
  fetch(symbol: string, tf: string, startSec: number, endSec: number): Promise<SourceCandle[]>;
  now?: () => number;
  /** Pause between requests, to stay polite with the public API (ms). */
  pauseMs?: number;
}
export interface SyncResult { symbol: string; tf: string; added: number; from: number | null; to: number | null; error?: string }

const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
/** How far back a market's first sync reaches (Delta serves roughly this much). */
export const FIRST_SYNC_DAYS: Record<string, number> = { '1m': 30, '5m': 60 };
/** Requests are cut into windows of at most this many bars (Delta pages ~2,000 a call; rest.candles stops at 20 pages). */
const WINDOW_BARS = 10_000;

export class CandleArchive {
  readonly db: DatabaseSync;
  private readonly deps: ArchiveDeps;
  private running: Promise<SyncResult[]> | null = null;

  constructor(file: string, deps: ArchiveDeps) {
    this.deps = deps;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS candles (symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
        PRIMARY KEY (symbol, tf, time)) WITHOUT ROWID;`);
  }

  close() { this.db.close(); }

  /** Open time (ms) of the newest archived bar, or null. */
  latest(symbol: string, tf: string): number | null {
    const r = this.db.prepare('SELECT MAX(time) t FROM candles WHERE symbol=? AND tf=?').get(symbol, tf) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  /** Insert closed bars (open time in ms); duplicates are ignored, so a re-run never double-counts. */
  insert(symbol: string, tf: string, bars: ArchiveBar[]): number {
    const st = this.db.prepare('INSERT OR IGNORE INTO candles(symbol,tf,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?,?)');
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const b of bars) {
        if (![b.time, b.open, b.high, b.low, b.close].every(Number.isFinite) || b.high < b.low) continue;
        n += Number(st.run(symbol, tf, b.time, b.open, b.high, b.low, b.close, Number.isFinite(b.volume) ? b.volume : 0).changes);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return n;
  }

  /** Archived bars in [from, to] (open time, ms), oldest first. */
  bars(symbol: string, tf: string, from = 0, to = Number.MAX_SAFE_INTEGER): ArchiveBar[] {
    return this.db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE symbol=? AND tf=? AND time BETWEEN ? AND ? ORDER BY time')
      .all(symbol, tf, from, to) as unknown as ArchiveBar[];
  }

  coverage(): Array<{ symbol: string; tf: string; bars: number; from: number; to: number }> {
    return this.db.prepare('SELECT symbol, tf, COUNT(*) bars, MIN(time) "from", MAX(time) "to" FROM candles GROUP BY symbol, tf ORDER BY symbol, tf').all() as any;
  }

  /** Top up every (symbol, tf): from the newest archived bar, or FIRST_SYNC_DAYS back for a market seen the first time. One sync at a time. */
  sync(symbols: string[], tfs = ['1m', '5m']): Promise<SyncResult[]> {
    if (this.running) return this.running;
    this.running = this.doSync(symbols, tfs).finally(() => { this.running = null; });
    return this.running;
  }

  private async doSync(symbols: string[], tfs: string[]): Promise<SyncResult[]> {
    const now = (this.deps.now ?? Date.now)(), out: SyncResult[] = [];
    for (const symbol of [...new Set(symbols)]) for (const tf of tfs) {
      const tfMs = TF_MS[tf];
      if (!tfMs) continue;
      const last = this.latest(symbol, tf);
      const start = last !== null ? last + tfMs : now - (FIRST_SYNC_DAYS[tf] ?? 30) * 86_400_000;
      const lastClosedOpen = Math.floor(now / tfMs) * tfMs - tfMs;   // the newest bar whose close has passed
      const res: SyncResult = { symbol, tf, added: 0, from: null, to: null };
      try {
        for (let a = start; a <= lastClosedOpen; a += WINDOW_BARS * tfMs) {
          const b = Math.min(lastClosedOpen, a + (WINDOW_BARS - 1) * tfMs);
          const got = await this.deps.fetch(symbol, tf, Math.floor(a / 1000), Math.floor(b / 1000));
          const bars = got.map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
            .filter(x => x.time >= a && x.time <= lastClosedOpen);
          res.added += this.insert(symbol, tf, bars);
          if (bars.length) { res.from ??= bars[0].time; res.to = bars.at(-1)!.time; }
          if (this.deps.pauseMs) await new Promise(r => setTimeout(r, this.deps.pauseMs));
        }
      } catch (e: any) { res.error = String(e?.message ?? e).slice(0, 200); }
      out.push(res);
    }
    return out;
  }
}
