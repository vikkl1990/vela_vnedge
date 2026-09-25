import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export interface SignalRow {
  id: number; at: number; barTime: number; scannerId: string; scannerName: string; symbol: string; tf: string;
  kind: string; side: string | null; price: number | null; sl: number | null; tp: number[]; score: number | null;
  label: string; message: string; summary: string; source: string; levelsSource: string | null; action: string; positionId: number | null; mlProb?: number | null;
}

/** Columns added after the first release; SQLite has no IF NOT EXISTS for these. */
const ADDED_COLUMNS: Array<[string, string]> = [
  ['orders', 'ref_price REAL'], ['orders', 'bid REAL'], ['orders', 'ask REAL'],
  ['orders', 'quote_at INTEGER'], ['orders', 'price_source TEXT'],
  // how far a trade actually travelled, so a closed trade can be judged without replaying candles
  ['positions', 'peak_r REAL'], ['positions', 'peak_at INTEGER'], ['positions', 'worst_r REAL'], ['positions', 'worst_at INTEGER'],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, bar_time INTEGER NOT NULL, scanner_id TEXT NOT NULL, scanner_name TEXT NOT NULL,
  symbol TEXT NOT NULL, tf TEXT NOT NULL, kind TEXT NOT NULL, side TEXT, price REAL, sl REAL, tp TEXT NOT NULL DEFAULT '[]', score REAL,
  label TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, levels_source TEXT, action TEXT NOT NULL, position_id INTEGER,
  UNIQUE(scanner_id, symbol, tf, bar_time, kind, side, label)
);
CREATE INDEX IF NOT EXISTS idx_signals_at ON signals(at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_scanner ON signals(scanner_id, at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, scanner_id TEXT NOT NULL, scanner_name TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
  side TEXT NOT NULL, qty REAL NOT NULL, qty_open REAL NOT NULL, contract_value REAL NOT NULL, entry_price REAL NOT NULL, entry_at INTEGER NOT NULL,
  sl REAL, sl_original REAL, tp TEXT NOT NULL DEFAULT '[]', tp_hit TEXT NOT NULL DEFAULT '[]', break_even INTEGER NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0, fees REAL NOT NULL DEFAULT 0, risk_amount REAL NOT NULL DEFAULT 0, levels_source TEXT,
  exit_at INTEGER, exit_price REAL, exit_reason TEXT, signal_id INTEGER, fills TEXT NOT NULL DEFAULT '[]', bt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status, bt);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, position_id INTEGER NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL,
  side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, reason TEXT NOT NULL, bt INTEGER NOT NULL DEFAULT 0,
  -- fill quality: what the book looked like when this filled, so the cost assumption can be audited
  ref_price REAL, bid REAL, ask REAL, quote_at INTEGER, price_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_at ON orders(at DESC);

CREATE TABLE IF NOT EXISTS equity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, scanner_id TEXT, equity REAL NOT NULL, realized REAL NOT NULL, unrealized REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_at ON equity(scanner_id, at);

CREATE TABLE IF NOT EXISTS scanner_runs (
  scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT, bar_time INTEGER,
  PRIMARY KEY (scanner_id, symbol, tf)
);

CREATE TABLE IF NOT EXISTS backtests (
  scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, bars INTEGER NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (scanner_id, symbol, tf)
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- scripts that cannot run here: see scanners/health.ts
CREATE TABLE IF NOT EXISTS script_health (
  scanner_id TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL,
  last_error TEXT, reason TEXT, quarantined INTEGER NOT NULL DEFAULT 0
);

-- incubator: one row per scanner/market/timeframe it has an opinion on, and every move it made
CREATE TABLE IF NOT EXISTS incubator_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
  stage TEXT NOT NULL, since INTEGER NOT NULL, updated INTEGER NOT NULL, screen TEXT, gate TEXT, note TEXT,
  UNIQUE(scanner_id, symbol, tf)
);
CREATE INDEX IF NOT EXISTS idx_incubator_stage ON incubator_pairs(stage);
CREATE TABLE IF NOT EXISTS incubator_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, pair_id INTEGER NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
  from_stage TEXT, to_stage TEXT NOT NULL, actor TEXT NOT NULL, evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_incubator_events_at ON incubator_events(at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_pair ON positions(bt, scanner_id, symbol, tf, status);

-- The path a trade took from entry to exit: one row per sample or level event, so a trade can be
-- read back minute by minute — where it peaked, when the stop moved, which targets it touched.
CREATE TABLE IF NOT EXISTS position_path (
  position_id INTEGER NOT NULL, at INTEGER NOT NULL, price REAL NOT NULL, r REAL NOT NULL,
  sl REAL, event TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_position_path ON position_path(position_id, at);
`;

export interface BackupResult { file: string; bytes: number; at: number; ms: number; pruned: string[] }

export class Db {
  readonly db: DatabaseSync;
  /** Path of the database file (':memory:' for in-memory databases). */
  readonly file: string;
  /** Statement failures since start (UNIQUE-constraint rejections used for de-duplication are not counted). */
  errors = 0;
  lastError: { at: number; message: string } | null = null;

  constructor(file = path.join(DATA_DIR, 'vnedge.db')) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // busy_timeout: the incubator's daily job writes from its own process while the bot runs
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
    this.db.exec(SCHEMA);
    // additive migrations
    const cols = this.db.prepare('PRAGMA table_info(signals)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'summary')) this.db.exec("ALTER TABLE signals ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
    if (!cols.some(c => c.name === 'ml_prob')) this.db.exec('ALTER TABLE signals ADD COLUMN ml_prob REAL');
    for (const [table, decl] of ADDED_COLUMNS) {
      const name = decl.split(' ')[0];
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!existing.some(c => c.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${decl}`);
    }
  }

  run(sql: string, ...params: any[]) { try { return this.db.prepare(sql).run(...params); } catch (e) { this.noteError(e); throw e; } }
  all<T = any>(sql: string, ...params: any[]): T[] { try { return this.db.prepare(sql).all(...params) as T[]; } catch (e) { this.noteError(e); throw e; } }
  get<T = any>(sql: string, ...params: any[]): T | undefined { try { return this.db.prepare(sql).get(...params) as T | undefined; } catch (e) { this.noteError(e); throw e; } }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); this.noteError(e); throw e; }
  }

  private noteError(e: unknown) {
    const msg = String((e as any)?.message ?? e);
    if (/UNIQUE constraint/i.test(msg)) return; // expected: signal de-duplication
    this.errors++; this.lastError = { at: Date.now(), message: msg.slice(0, 300) };
  }

  // ---- maintenance (Phase 4 ops) ----

  /** Bytes on disk for the main file plus its WAL (0 for in-memory). */
  sizeBytes(): number {
    if (this.file === ':memory:') return 0;
    let n = 0;
    for (const f of [this.file, this.file + '-wal']) { try { n += fs.statSync(f).size; } catch { /* missing */ } }
    return n;
  }

  /** `PRAGMA quick_check`: 'ok' or the first problem reported by SQLite. */
  integrityCheck(): string {
    try { const r = this.db.prepare('PRAGMA quick_check').get() as any; return String(r?.quick_check ?? r?.integrity_check ?? 'ok'); }
    catch (e: any) { this.noteError(e); return String(e?.message ?? e); }
  }

  /**
   * Consistent snapshot via `VACUUM INTO` (works while the app keeps writing in WAL mode),
   * then deletes snapshots in `dir` older than `keepDays`. Names: `vnedge-YYYYMMDD-HHMMSS.db`.
   */
  backup(dir: string, keepDays: number, now = Date.now()): BackupResult {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(dir, `vnedge-${stamp}.db`);
    const t0 = Date.now();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); }
    catch (e) { this.noteError(e); throw e; }
    const bytes = fs.statSync(file).size;
    const pruned = Db.pruneBackups(dir, keepDays, now, file);
    return { file, bytes, at: now, ms: Date.now() - t0, pruned };
  }

  /** Delete `vnedge-*.db` snapshots in `dir` older than `keepDays` (never the file just written). Returns the removed paths. */
  static pruneBackups(dir: string, keepDays: number, now = Date.now(), keep?: string): string[] {
    const out: string[] = [];
    const cutoff = now - keepDays * 86_400_000;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return out; }
    for (const name of entries) {
      if (!/^vnedge-\d{8}-\d{6}\.db$/.test(name)) continue;
      const full = path.join(dir, name);
      if (keep && path.resolve(full) === path.resolve(keep)) continue;
      try { if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { force: true }); out.push(full); } } catch { /* ignore */ }
    }
    return out;
  }

  /** List snapshots in `dir`, newest first. */
  static listBackups(dir: string): Array<{ file: string; bytes: number; at: number }> {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    return entries.filter(n => /^vnedge-\d{8}-\d{6}\.db$/.test(n)).map(n => { const full = path.join(dir, n); const st = fs.statSync(full); return { file: full, bytes: st.size, at: st.mtimeMs }; }).sort((a, b) => b.at - a.at);
  }

  kvGet<T = any>(k: string): T | undefined { const r = this.get<{ v: string }>('SELECT v FROM kv WHERE k = ?', k); return r ? JSON.parse(r.v) : undefined; }
  kvSet(k: string, v: unknown) { this.run('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }

  // ---- signals ----
  insertSignal(s: Omit<SignalRow, 'id'>): number | null {
    try {
      const r = this.run(
        `INSERT INTO signals(at, bar_time, scanner_id, scanner_name, symbol, tf, kind, side, price, sl, tp, score, label, message, summary, source, levels_source, action, position_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.at, s.barTime, s.scannerId, s.scannerName, s.symbol, s.tf, s.kind, s.side, s.price, s.sl, JSON.stringify(s.tp), s.score, s.label, s.message, s.summary, s.source, s.levelsSource, s.action, s.positionId,
      );
      return Number(r.lastInsertRowid);
    } catch (e: any) {
      if (/UNIQUE/.test(String(e?.message))) return null;
      throw e;
    }
  }
  signalExists(scannerId: string, symbol: string, tf: string, barTime: number, kind: string, side: string | null, label: string): boolean {
    return Boolean(this.get('SELECT 1 FROM signals WHERE scanner_id=? AND symbol=? AND tf=? AND bar_time=? AND kind=? AND side IS ? AND label=?', scannerId, symbol, tf, barTime, kind, side, label));
  }
  updateSignalAction(id: number, action: string, positionId: number | null) { this.run('UPDATE signals SET action=?, position_id=? WHERE id=?', action, positionId, id); }
  signals(opts: { limit?: number; scanner?: string; symbol?: string; kind?: string; since?: number } = {}): SignalRow[] {
    const where: string[] = []; const params: any[] = [];
    if (opts.scanner) { where.push('scanner_id = ?'); params.push(opts.scanner); }
    if (opts.symbol) { where.push('symbol = ?'); params.push(opts.symbol); }
    if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }
    if (opts.since) { where.push('at >= ?'); params.push(opts.since); }
    const sql = `SELECT * FROM signals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 200, 2000));
    return this.all<any>(sql, ...params).map(rowToSignal);
  }
  signalById(id: number): SignalRow | undefined { const r = this.get<any>('SELECT * FROM signals WHERE id=?', id); return r ? rowToSignal(r) : undefined; }
  countSignals(scannerId: string): number { return this.get<{ n: number }>('SELECT COUNT(*) n FROM signals WHERE scanner_id=?', scannerId)?.n ?? 0; }
  /** Signal counts for every scanner in one query; building the scanner list one at a time was O(n) round trips. */
  countSignalsByScanner(): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.all<{ scanner_id: string; n: number }>('SELECT scanner_id, COUNT(*) n FROM signals GROUP BY scanner_id')) m.set(r.scanner_id, r.n);
    return m;
  }
}

export function rowToSignal(r: any): SignalRow {
  return {
    id: r.id, at: r.at, barTime: r.bar_time, scannerId: r.scanner_id, scannerName: r.scanner_name, symbol: r.symbol, tf: r.tf, kind: r.kind, side: r.side,
    price: r.price, sl: r.sl, tp: JSON.parse(r.tp || '[]'), score: r.score, label: r.label, message: r.message, summary: r.summary ?? '', source: r.source, levelsSource: r.levels_source,
    action: r.action, positionId: r.position_id, mlProb: r.ml_prob ?? null,
  };
}
