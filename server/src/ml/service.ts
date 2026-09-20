/**
 * Trade-learning service: stores samples (backtest + live), trains per-scanner and global
 * models, scores new entries, and produces improvement insights.
 */
import type { Db } from '../db.ts';
import { logger } from '../log.ts';
import { computeFeatures, type Features, type FeatureInputs } from './features.ts';
import { deriveRules, predict, trainLogReg, type LogRegModel, type Rule, type Sample } from './model.ts';

const log = logger.scoped('ml');
const MIN_SCANNER_SAMPLES = 40;

export interface ScannerInsight {
  scannerId: string; scannerName: string; samples: number; liveSamples: number;
  baseline: { n: number; winRate: number; avgR: number };
  model: { n: number; holdout: number; accuracy: number; auc: number; logLoss: number; baseWinRate: number } | null;
  importance: LogRegModel['importance'];
  rules: Rule[];
}

export interface MlSnapshot {
  trainedAt: number | null; samples: number; liveSamples: number; scannersWithModel: number;
  global: { model: LogRegModel['metrics'] | null; importance: LogRegModel['importance']; rules: Rule[]; baseline: { n: number; winRate: number; avgR: number } } | null;
  scanners: ScannerInsight[];
}

export class MlService {
  private db: Db;
  private globalModel: LogRegModel | null = null;
  private models = new Map<string, LogRegModel>();
  private snapshot: MlSnapshot | null = null;
  private names: () => Record<string, string>;
  private trainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Db, names: () => Record<string, string>) {
    this.db = db; this.names = names;
    db.db.exec(`CREATE TABLE IF NOT EXISTS ml_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL,
      features TEXT NOT NULL, win INTEGER NOT NULL, r REAL NOT NULL, pnl REAL NOT NULL, exit_reason TEXT NOT NULL, bt INTEGER NOT NULL DEFAULT 1,
      UNIQUE(scanner_id, symbol, tf, at, bt)
    ); CREATE INDEX IF NOT EXISTS idx_ml_scanner ON ml_samples(scanner_id);`);
    const saved = db.kvGet<{ global: LogRegModel | null; models: Record<string, LogRegModel>; snapshot: MlSnapshot }>('ml.model');
    if (saved) { this.globalModel = saved.global; for (const [k, v] of Object.entries(saved.models ?? {})) this.models.set(k, v); this.snapshot = saved.snapshot; log.info(`loaded ML models: global ${saved.global ? 'yes' : 'no'}, ${this.models.size} scanner models`); }
  }

  features(inp: FeatureInputs): Features { return computeFeatures(inp); }

  /** Replace the backtest samples of one scanner×symbol×tf with a fresh set. */
  replaceBacktestSamples(scannerId: string, symbol: string, tf: string, rows: Array<{ at: number; features: Features; win: boolean; r: number; pnl: number; exitReason: string }>) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM ml_samples WHERE scanner_id=? AND symbol=? AND tf=? AND bt=1', scannerId, symbol, tf);
      for (const r of rows) this.db.run('INSERT OR IGNORE INTO ml_samples(scanner_id, symbol, tf, at, features, win, r, pnl, exit_reason, bt) VALUES (?,?,?,?,?,?,?,?,?,1)', scannerId, symbol, tf, r.at, JSON.stringify(r.features), r.win ? 1 : 0, r.r, r.pnl, r.exitReason);
    });
    this.scheduleTrain();
  }

  addLiveSample(scannerId: string, symbol: string, tf: string, at: number, features: Features, win: boolean, r: number, pnl: number, exitReason: string) {
    this.db.run('INSERT OR IGNORE INTO ml_samples(scanner_id, symbol, tf, at, features, win, r, pnl, exit_reason, bt) VALUES (?,?,?,?,?,?,?,?,?,0)', scannerId, symbol, tf, at, JSON.stringify(features), win ? 1 : 0, r, pnl, exitReason);
    this.scheduleTrain();
  }

  private scheduleTrain() {
    if (this.trainTimer) clearTimeout(this.trainTimer);
    this.trainTimer = setTimeout(() => { this.trainTimer = null; try { this.train(); } catch (e: any) { log.error(`train failed: ${e?.message ?? e}`); } }, 30_000);
    this.trainTimer.unref();
  }

  samples(scannerId?: string, limit = 5000): Sample[] {
    const rows = scannerId
      ? this.db.all<any>('SELECT * FROM ml_samples WHERE scanner_id=? ORDER BY at DESC LIMIT ?', scannerId, limit)
      : this.db.all<any>('SELECT * FROM ml_samples ORDER BY at DESC LIMIT ?', limit);
    return rows.map(r => ({ scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, at: r.at, features: JSON.parse(r.features), win: r.win, r: r.r, pnl: r.pnl, exitReason: r.exit_reason, bt: Boolean(r.bt) }));
  }

  count(): { total: number; live: number } {
    const t = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM ml_samples')?.n ?? 0;
    const l = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM ml_samples WHERE bt=0')?.n ?? 0;
    return { total: t, live: l };
  }

  /** Train global + per-scanner models and derive rules. */
  train(): MlSnapshot {
    const t0 = Date.now();
    const all = this.samples(undefined, 100_000);
    const names = this.names();
    const byScanner = new Map<string, Sample[]>();
    for (const s of all) { const l = byScanner.get(s.scannerId) ?? []; l.push(s); byScanner.set(s.scannerId, l); }
    this.globalModel = trainLogReg(all);
    const gRules = deriveRules(all, { minN: 50 });
    const scanners: ScannerInsight[] = [];
    this.models.clear();
    for (const [id, list] of byScanner) {
      const m = list.length >= MIN_SCANNER_SAMPLES ? trainLogReg(list) : null;
      if (m) this.models.set(id, m);
      const { baseline, rules } = deriveRules(list);
      scanners.push({ scannerId: id, scannerName: names[id] ?? id, samples: list.length, liveSamples: list.filter(s => !s.bt).length, baseline, model: m?.metrics ?? null, importance: m?.importance.slice(0, 8) ?? [], rules });
    }
    scanners.sort((a, b) => b.samples - a.samples);
    this.snapshot = {
      trainedAt: Date.now(), samples: all.length, liveSamples: all.filter(s => !s.bt).length, scannersWithModel: this.models.size,
      global: this.globalModel ? { model: this.globalModel.metrics, importance: this.globalModel.importance, rules: gRules.rules, baseline: gRules.baseline } : null,
      scanners,
    };
    this.db.kvSet('ml.model', { global: this.globalModel, models: Object.fromEntries(this.models), snapshot: this.snapshot });
    log.info(`trained on ${all.length} samples (${this.models.size} scanner models, global AUC ${this.globalModel ? this.globalModel.metrics.auc.toFixed(2) : '-'}) in ${Date.now() - t0}ms`);
    return this.snapshot;
  }

  /** P(win) for an entry; scanner model when available, else global; null when nothing is trained. */
  score(scannerId: string, f: Features): { prob: number; model: 'scanner' | 'global' } | null {
    const m = this.models.get(scannerId);
    if (m) return { prob: predict(m, f), model: 'scanner' };
    if (this.globalModel) return { prob: predict(this.globalModel, f), model: 'global' };
    return null;
  }

  insights(): MlSnapshot | null { return this.snapshot; }
  insightFor(scannerId: string): ScannerInsight | null { return this.snapshot?.scanners.find(s => s.scannerId === scannerId) ?? null; }
}
