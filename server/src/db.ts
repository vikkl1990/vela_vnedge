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
  ['exchange_orders', "host TEXT NOT NULL DEFAULT 'unknown'"],
  ['positions', 'config_fp TEXT'],
  ['positions', 'evidence_scope TEXT'],
  ['scanner_runs', 'funnel TEXT'],
  ['orders', 'ref_price REAL'], ['orders', 'bid REAL'], ['orders', 'ask REAL'],
  ['orders', 'quote_at INTEGER'], ['orders', 'price_source TEXT'],
  // how far a trade actually travelled, so a closed trade can be judged without replaying candles
  ['positions', 'peak_r REAL'], ['positions', 'peak_at INTEGER'], ['positions', 'worst_r REAL'], ['positions', 'worst_at INTEGER'],
  ['script_profile', 'signature TEXT'], ['script_profile', 'bars INTEGER'], ['script_profile', 'window_start INTEGER'], ['script_profile', 'window_end INTEGER'], ['script_profile', 'origin TEXT'],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decision_trace (
 id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, book INTEGER NOT NULL,
 signal_id INTEGER, position_id INTEGER, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL,
 stage TEXT NOT NULL, reason TEXT, snapshot TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_decision_trace_book_id ON decision_trace(book,id DESC);
CREATE INDEX IF NOT EXISTS idx_decision_trace_signal ON decision_trace(signal_id,id);
CREATE INDEX IF NOT EXISTS idx_decision_trace_position ON decision_trace(position_id,stage,id);

CREATE TABLE IF NOT EXISTS evidence_flags (
 position_id INTEGER NOT NULL,entry_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('quarantined','cleared')),
 reason TEXT NOT NULL,source TEXT NOT NULL,checked_at INTEGER NOT NULL,PRIMARY KEY(position_id,entry_at)
);
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
CREATE TRIGGER IF NOT EXISTS trace_position_status AFTER UPDATE OF status ON positions
WHEN OLD.status != NEW.status
BEGIN
 INSERT INTO decision_trace(at,book,signal_id,position_id,scanner_id,symbol,tf,stage,reason)
 VALUES(CAST(unixepoch('subsec')*1000 AS INTEGER),NEW.bt,NEW.signal_id,NEW.id,NEW.scanner_id,NEW.symbol,NEW.tf,NEW.status,NEW.exit_reason);
END;
CREATE TRIGGER IF NOT EXISTS trace_pending_delete AFTER DELETE ON positions
WHEN OLD.status='pending'
BEGIN
 INSERT INTO decision_trace(at,book,signal_id,position_id,scanner_id,symbol,tf,stage,reason)
 VALUES(CAST(unixepoch('subsec')*1000 AS INTEGER),OLD.bt,OLD.signal_id,OLD.id,OLD.scanner_id,OLD.symbol,OLD.tf,'cancelled','pending record removed; see signal decision');
END;


CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, position_id INTEGER NOT NULL, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL,
  side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, reason TEXT NOT NULL, bt INTEGER NOT NULL DEFAULT 0,
  -- fill quality: what the book looked like when this filled, so the cost assumption can be audited
  ref_price REAL, bid REAL, ask REAL, quote_at INTEGER, price_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_at ON orders(at DESC);

CREATE TABLE IF NOT EXISTS ops_metrics (
  at INTEGER PRIMARY KEY, rss INTEGER NOT NULL, heap INTEGER NOT NULL, rss_pct REAL NOT NULL, queued INTEGER NOT NULL, busy INTEGER NOT NULL, recycled INTEGER NOT NULL,
  runs_h INTEGER NOT NULL, signals_h INTEGER NOT NULL, feed_up INTEGER NOT NULL, open_positions INTEGER NOT NULL, close_lag_s REAL
);

CREATE TABLE IF NOT EXISTS market_context (
  at INTEGER NOT NULL, symbol TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (at, symbol)
);
CREATE INDEX IF NOT EXISTS idx_market_context_symbol ON market_context(symbol, at);

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

-- what each script produced when last profiled on a market × timeframe (decision 48 / 54)
CREATE TABLE IF NOT EXISTS script_profile (
  scanner_id TEXT NOT NULL, market TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, ms INTEGER NOT NULL DEFAULT 0,
  entries INTEGER NOT NULL DEFAULT 0, with_sl INTEGER NOT NULL DEFAULT 0, with_tp INTEGER NOT NULL DEFAULT 0, exits INTEGER NOT NULL DEFAULT 0, info INTEGER NOT NULL DEFAULT 0,
  alert_entries INTEGER NOT NULL DEFAULT 0, alertconds INTEGER NOT NULL DEFAULT 0, shapes INTEGER NOT NULL DEFAULT 0, labels INTEGER NOT NULL DEFAULT 0, label_texts TEXT NOT NULL DEFAULT '[]', plots INTEGER NOT NULL DEFAULT 0, error TEXT,
  PRIMARY KEY (scanner_id, market, tf)
);

-- every order the executor ever intended to send, and what became of it: the durable order state
-- machine (decision 46). intent → submitted → acknowledged → filled | cancelled | rejected; unknown when
-- the exchange could not be asked. Recovery after a restart starts from these rows, never from memory.
CREATE TABLE IF NOT EXISTS exchange_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, position_id INTEGER NOT NULL, purpose TEXT NOT NULL, reason TEXT, leg INTEGER, client_order_id TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size INTEGER NOT NULL, order_type TEXT NOT NULL, stop_price REAL, limit_price REAL,
  state TEXT NOT NULL, exchange_id TEXT, filled_size INTEGER NOT NULL DEFAULT 0, avg_price REAL, fee REAL, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_position ON exchange_orders(position_id);
CREATE INDEX IF NOT EXISTS idx_exchange_orders_state ON exchange_orders(state);

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
    // Freeze reporting membership when an order receives its cell identity. Moving a cell
    // between tracker/shadow/live must not rewrite history. Legacy membership is inferred
    // once at migration, explicitly labelled; the old journal did not record entry-time stage.
    const scope = (alias: string, legacy = false) => `CASE
      WHEN ${alias}.bt=0 THEN 'account'
      WHEN ${alias}.scanner_id LIKE 'plan:%' THEN 'experiment'
      WHEN ${alias}.bt=2 THEN CASE WHEN EXISTS (SELECT 1 FROM incubator_pairs i
        WHERE i.stage='tracked' AND i.scanner_id=${alias}.scanner_id AND i.symbol=${alias}.symbol AND i.tf=${alias}.tf)
        THEN '${legacy ? 'legacy-' : ''}tracker' ELSE '${legacy ? 'legacy-' : ''}shadow' END
      ELSE 'other' END`;
    this.db.exec(`UPDATE positions AS p SET evidence_scope=${scope('p', true)}
      WHERE evidence_scope IS NULL AND scanner_id!='';
      CREATE TRIGGER IF NOT EXISTS position_scope_insert AFTER INSERT ON positions
      WHEN NEW.evidence_scope IS NULL AND NEW.scanner_id!=''
      BEGIN UPDATE positions SET evidence_scope=${scope('NEW')} WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS position_scope_identity AFTER UPDATE OF scanner_id ON positions
      WHEN NEW.evidence_scope IS NULL AND NEW.scanner_id!=''
      BEGIN UPDATE positions SET evidence_scope=${scope('NEW')} WHERE id=NEW.id; END;`);
  }

  run(sql: string, ...params: any[]) { try { return this.db.prepare(sql).run(...params); } catch (e) { this.noteError(e); throw e; } }
  all<T = any>(sql: string, ...params: any[]): T[] { try { return this.db.prepare(sql).all(...params) as T[]; } catch (e) { this.noteError(e); throw e; } }
  get<T = any>(sql: string, ...params: any[]): T | undefined { try { return this.db.prepare(sql).get(...params) as T | undefined; } catch (e) { this.noteError(e); throw e; } }
  private transactionDepth = 0;
  private commitCallbacks: Array<Array<() => void>> = [];
  get inTransaction(): boolean { return this.transactionDepth > 0; }
  /** Observers must never see a fill that its enclosing decision can still roll back. */
  afterCommit(fn: () => void): void {
    if (this.inTransaction) this.commitCallbacks.at(-1)!.push(fn);
    else fn();
  }
  transaction<T>(fn: () => T): T {
    const depth=this.transactionDepth++, savepoint=`nested_${depth}`;
    const callbacks: Array<() => void> = []; this.commitCallbacks.push(callbacks);
    let committed = false;
    try {
      this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      try { const r=fn();this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');committed=true;return r; }
      catch(e){this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');this.noteError(e);throw e;}
    } finally {
      this.transactionDepth--; this.commitCallbacks.pop();
      if (committed) {
        if (depth) this.commitCallbacks.at(-1)!.push(...callbacks);
        // A listener failure cannot turn an already committed transaction into a retry.
        else for (const fn of callbacks) { try { fn(); } catch (e) { this.noteError(e); } }
      }
    }
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
  signals(opts: { limit?: number; scanner?: string; symbol?: string; tf?: string; positionId?: number; kind?: string; since?: number } = {}): SignalRow[] {
    const where: string[] = []; const params: any[] = [];
    if (opts.scanner) { where.push('scanner_id = ?'); params.push(opts.scanner); }
    if (opts.symbol) { where.push('symbol = ?'); params.push(opts.symbol); }
    if (opts.tf) { where.push('tf = ?'); params.push(opts.tf); }
    if (opts.positionId !== undefined) { where.push('position_id = ?'); params.push(opts.positionId); }
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
