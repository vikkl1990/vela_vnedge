import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

export interface SignalRow {
  id: number; at: number; barTime: number; scannerId: string; scannerName: string; symbol: string; tf: string;
  kind: string; side: string | null; price: number | null; sl: number | null; tp: number[]; score: number | null;
  label: string; message: string; summary: string; source: string; levelsSource: string | null; action: string; positionId: number | null; mlProb?: number | null;
}

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
  side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, reason TEXT NOT NULL, bt INTEGER NOT NULL DEFAULT 0
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
`;

export class Db {
  readonly db: DatabaseSync;

  constructor(file = path.join(DATA_DIR, 'vnedge.db')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // additive migrations
    const cols = this.db.prepare('PRAGMA table_info(signals)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'summary')) this.db.exec("ALTER TABLE signals ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
    if (!cols.some(c => c.name === 'ml_prob')) this.db.exec('ALTER TABLE signals ADD COLUMN ml_prob REAL');
  }

  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  all<T = any>(sql: string, ...params: any[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  get<T = any>(sql: string, ...params: any[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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
}

export function rowToSignal(r: any): SignalRow {
  return {
    id: r.id, at: r.at, barTime: r.bar_time, scannerId: r.scanner_id, scannerName: r.scanner_name, symbol: r.symbol, tf: r.tf, kind: r.kind, side: r.side,
    price: r.price, sl: r.sl, tp: JSON.parse(r.tp || '[]'), score: r.score, label: r.label, message: r.message, summary: r.summary ?? '', source: r.source, levelsSource: r.levels_source,
    action: r.action, positionId: r.position_id, mlProb: r.ml_prob ?? null,
  };
}
