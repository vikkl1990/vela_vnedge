/**
 * Trade-learning service: stores samples (backtest + live), trains per-scanner and global
 * models, scores new entries, and produces improvement insights.
 */
import { SIMULATION_VERSION } from '../paper/version.ts';
import type { Db } from '../db.ts';
import { logger } from '../log.ts';
import { computeFeatures, FEATURE_LABELS, FEATURE_NAMES, featureVector, type Features, type FeatureInputs } from './features.ts';
import { predict, type LogRegModel, type Rule, type Sample } from './model.ts';
import {PredictionEvidence,type ModelEvidence,type PredictionContext} from './predictionEvidence.ts';
import { computeTraining, eligibleSamples, rowsToSamples, TRAINING_ROW_LIMIT, type TrainingInput, type TrainingResult } from './training.ts';
import { startTrainingWorker, type TrainHandle } from './trainRunner.ts';

const log = logger.scoped('ml');
const TRAINING_VERSION = 3;
/** Live feature vectors kept for drift monitoring. */
const DRIFT_WINDOW = 200;

export interface DriftFeature { feature: string; label: string; trainMean: number; trainStd: number; liveMean: number; liveStd: number; /** (liveMean − trainMean) / trainStd */ shift: number; drifted: boolean }
export interface DriftReport { at: number; n: number; window: number; threshold: number; drifted: number; features: DriftFeature[] }

export interface ScannerInsight {
  scannerId: string; scannerName: string; samples: number; liveSamples: number;
  baseline: { n: number; winRate: number; avgR: number };
  model: LogRegModel['metrics'] | null;
  calibration: LogRegModel['calibration'];
  importance: LogRegModel['importance'];
  rules: Rule[];
}

export interface MlSnapshot {
  timeframeModels?: Array<{ scannerId: string | null; tf: string; model: LogRegModel['metrics'] }>;
  eligibility?: { stored: number; eligible: number; excluded: number };
  trainedAt: number | null; samples: number; liveSamples: number; liveSinceReset: number; scannersWithModel: number;
  global: { model: LogRegModel['metrics'] | null; calibration: LogRegModel['calibration']; importance: LogRegModel['importance']; rules: Rule[]; baseline: { n: number; winRate: number; avgR: number } } | null;
  scanners: ScannerInsight[];
}

export class MlService {
  readonly predictionEvidence:PredictionEvidence;
  private modelEvidence:ModelEvidence|null=null;
  private db: Db;
  private globalModel: LogRegModel | null = null;
  private models = new Map<string, LogRegModel>();
  private timeframeModels = new Map<string, LogRegModel>();
  private snapshot: MlSnapshot | null = null;
  private names: () => Record<string, string>;
  private trainTimer: ReturnType<typeof setTimeout> | null = null;
  private liveFeatures: Array<{ at: number; f: Features }> = [];

  constructor(db: Db, names: () => Record<string, string>) {
    this.db = db; this.names = names;
    this.predictionEvidence=new PredictionEvidence(db);
    db.db.exec(`CREATE TABLE IF NOT EXISTS ml_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scanner_id TEXT NOT NULL, symbol TEXT NOT NULL, tf TEXT NOT NULL, at INTEGER NOT NULL,
      features TEXT NOT NULL, win INTEGER NOT NULL, r REAL NOT NULL, pnl REAL NOT NULL, exit_reason TEXT NOT NULL, bt INTEGER NOT NULL DEFAULT 1,
      UNIQUE(scanner_id, symbol, tf, at, bt)
    ); CREATE INDEX IF NOT EXISTS idx_ml_scanner ON ml_samples(scanner_id);`);
    // decision 192: when each sample's outcome became known, so a time split can purge what was still open at its boundary
    try { db.db.exec('ALTER TABLE ml_samples ADD COLUMN resolved_at INTEGER'); } catch { /* already there */ }
    // Recover only exact, unique closed account trades. Never infer an exit from entry time.
    db.run(`UPDATE ml_samples AS s SET resolved_at=(
      SELECT MIN(p.exit_at) FROM positions p WHERE p.bt=0 AND p.status='closed'
        AND p.scanner_id=s.scanner_id AND p.symbol=s.symbol AND p.tf=s.tf AND p.entry_at=s.at AND p.exit_at>=s.at
    ) WHERE s.bt=0 AND s.resolved_at IS NULL AND 1=(
      SELECT COUNT(*) FROM positions p WHERE p.bt=0 AND p.status='closed'
        AND p.scanner_id=s.scanner_id AND p.symbol=s.symbol AND p.tf=s.tf AND p.entry_at=s.at AND p.exit_at>=s.at
    )`);
    if (db.kvGet<number>('ml.simulationVersion') !== SIMULATION_VERSION) {
      // Old backtests contain obsolete fill results; preserve recorded live history.
      db.transaction(() => {
        db.run('DELETE FROM ml_samples WHERE bt=1');
        db.run("DELETE FROM kv WHERE k='ml.model'");
        db.kvSet('ml.simulationVersion', SIMULATION_VERSION);
      });
      this.scheduleTrain();
    }
    const saved = db.kvGet<{ global: LogRegModel | null; models: Record<string, LogRegModel>; snapshot: MlSnapshot; version?: number; timeframeModels?: Record<string, LogRegModel> }>('ml.model');
    if (saved?.version === TRAINING_VERSION) { for (const [k, v] of Object.entries(saved.timeframeModels ?? {})) this.timeframeModels.set(k, v); this.globalModel = saved.global; for (const [k, v] of Object.entries(saved.models ?? {})) this.models.set(k, v); this.snapshot = saved.snapshot; log.info(`loaded ML models: global ${saved.global ? 'yes' : 'no'}, ${this.models.size} scanner models`); }
    if(saved?.version===TRAINING_VERSION)this.modelEvidence=(saved as typeof saved&{evidence?:ModelEvidence}).evidence??null;
    if (saved && saved.version !== TRAINING_VERSION) this.scheduleTrain();
    this.liveFeatures = db.kvGet<Array<{ at: number; f: Features }>>('ml.liveFeatures') ?? [];
    // a model trained before the feature set grew predicts without the new columns until it is retrained
    if (this.globalModel && this.globalModel.weights.length !== FEATURE_NAMES.length) { log.info(`feature set moved (${this.globalModel.weights.length} → ${FEATURE_NAMES.length}); retraining`); this.scheduleTrain(); }
  }

  features(inp: FeatureInputs): Features { return computeFeatures(inp); }

  /** Replace the backtest samples of one scanner×symbol×tf with a fresh set. */
  replaceBacktestSamples(scannerId: string, symbol: string, tf: string, rows: Array<{ at: number; features: Features; win: boolean; r: number; pnl: number; exitReason: string; resolvedAt?: number | null }>) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM ml_samples WHERE scanner_id=? AND symbol=? AND tf=? AND bt=1', scannerId, symbol, tf);
      for (const r of rows) this.db.run('INSERT OR IGNORE INTO ml_samples(scanner_id, symbol, tf, at, features, win, r, pnl, exit_reason, bt, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)', scannerId, symbol, tf, r.at, JSON.stringify(r.features), r.win ? 1 : 0, r.r, r.pnl, r.exitReason, r.resolvedAt ?? null);
    });
    this.scheduleTrain();
  }

  addLiveSample(scannerId: string, symbol: string, tf: string, at: number, features: Features, win: boolean, r: number, pnl: number, exitReason: string, resolvedAt = Date.now()) {
    this.db.run('INSERT OR IGNORE INTO ml_samples(scanner_id, symbol, tf, at, features, win, r, pnl, exit_reason, bt, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,0,?)', scannerId, symbol, tf, at, JSON.stringify(features), win ? 1 : 0, r, pnl, exitReason, resolvedAt);
    this.scheduleTrain();
  }

  /** Throttled: train at most once per 2 minutes while samples keep arriving (never starves during warm-up). */
  private scheduleTrain() {
    if (this.trainTimer || this.stopped) return;
    this.trainTimer = setTimeout(() => { this.trainTimer = null; void this.trainAsync().catch((e: any) => log.error(`train failed: ${e?.message ?? e}`)); }, 120_000);
    this.trainTimer.unref();
  }

  /** S4: fit in a worker thread off the market-data event loop. Off with VNEDGE_ML_WORKER=0 or for in-memory databases. */
  useWorker = process.env.VNEDGE_ML_WORKER !== '0';
  private training: Promise<MlSnapshot> | null = null;
  private trainHandle: TrainHandle | null = null;
  private retrainAfter = false;
  private stopped = false;
  /** Test seam: how a worker run is started. */
  startWorker: (file: string, input: TrainingInput) => TrainHandle = startTrainingWorker;

  /**
   * Train without blocking the event loop: the worker reads the samples through its own read-only
   * connection and fits every model; only applying and saving the result happens here. One run at a
   * time; a request during a run schedules one more. A failed worker falls back to in-process training.
   */
  trainAsync(): Promise<MlSnapshot> {
    if (this.training) { this.retrainAfter = true; return this.training; }
    if (!this.useWorker || this.db.file === ':memory:' || this.stopped) return Promise.resolve().then(() => this.train());
    const t0 = Date.now(), input = this.trainingInput(t0);
    const handle = this.trainHandle = this.startWorker(this.db.file, input);
    this.training = handle.promise
      .then(res => this.applyTraining(res, t0), (e: any) => {
        if (this.stopped) throw e;
        log.warn(`training worker failed (${e?.message ?? e}); training in-process instead`);
        return this.train();
      })
      .finally(() => {
        this.training = null; this.trainHandle = null;
        if (this.retrainAfter) { this.retrainAfter = false; this.scheduleTrain(); }
      });
    return this.training;
  }

  /** Stop scheduled and running training. */
  stop() {
    this.stopped = true;
    if (this.trainTimer) { clearTimeout(this.trainTimer); this.trainTimer = null; }
    this.trainHandle?.terminate();
  }

  private trainingInput(t0: number): TrainingInput {
    return { excluded: [...this.excluded()], t0, resetAt: this.db.kvGet<number>('paper.resetAt') ?? 0 };
  }

  samples(scannerId?: string, limit = 5000): Sample[] {
    const rows = scannerId
      ? this.db.all<any>('SELECT * FROM ml_samples WHERE scanner_id=? ORDER BY at DESC LIMIT ?', scannerId, limit)
      : this.db.all<any>('SELECT * FROM ml_samples ORDER BY at DESC LIMIT ?', limit);
    return rowsToSamples(rows);
  }

  count(): { total: number; live: number } {
    const t = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM ml_samples')?.n ?? 0;
    const l = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM ml_samples WHERE bt=0')?.n ?? 0;
    return { total: t, live: l };
  }

  /** Train global + per-scanner models and derive rules. */
  /** Scripts the runtime has given up on (they repaint, they time out): their samples are fiction and are left out of training (decision 87). */
  excluded: () => Set<string> = () => new Set();

  /** Synchronous, in-process training (the API's explicit retrain, tests, and the worker fallback). */
  train(): MlSnapshot {
    const t0 = Date.now(), input = this.trainingInput(t0);
    const all = eligibleSamples(this.samples(undefined, TRAINING_ROW_LIMIT), input);
    return this.applyTraining(computeTraining(all, input), t0);
  }

  /** Install a fitted result and persist it. Cheap: everything expensive happened in `computeTraining`. */
  private applyTraining(res: TrainingResult, t0: number): MlSnapshot {
    this.modelEvidence = null;
    const names = this.names();
    this.globalModel = res.globalModel;
    this.timeframeModels = new Map(res.timeframeModels);
    this.models = new Map(res.models);
    const scanners: ScannerInsight[] = res.scanners.map(s => ({ scannerId: s.scannerId, scannerName: names[s.scannerId] ?? s.scannerId, samples: s.samples, liveSamples: s.liveSamples,
      baseline: s.baseline, model: s.model?.metrics ?? null, calibration: s.model?.calibration ?? null, importance: s.model?.importance.slice(0, 8) ?? [], rules: s.rules }));
    scanners.sort((a, b) => b.samples - a.samples);
    const stored = this.count().total;
    this.snapshot = {
      timeframeModels: res.timeframeMetrics, eligibility: { stored, eligible: res.eligible, excluded: stored - res.eligible },
      trainedAt: Date.now(), samples: res.eligible, liveSamples: res.liveSamples, liveSinceReset: res.liveSinceReset, scannersWithModel: scanners.filter(s => s.model !== null).length,
      global: this.globalModel ? { model: this.globalModel.metrics, calibration: this.globalModel.calibration, importance: this.globalModel.importance, rules: res.global.rules, baseline: res.global.baseline } : null,
      scanners,
    };
    const bundle={version:TRAINING_VERSION,timeframeModels:Object.fromEntries(this.timeframeModels),global:this.globalModel,models:Object.fromEntries(this.models),snapshot:this.snapshot};
    this.modelEvidence=this.predictionEvidence.saveModel(bundle,this.snapshot.trainedAt!,res.maxResolvedAt);
    this.db.kvSet('ml.model', {...bundle,evidence:this.modelEvidence});
    log.info(`trained on ${res.eligible} samples (${this.models.size} scanner models, global AUC ${this.globalModel ? this.globalModel.metrics.auc.toFixed(2) : '-'}) in ${Date.now() - t0}ms (fit ${res.ms}ms)`);
    return this.snapshot;
  }

  /**
   * Calibrated P(win) for a live entry; scanner model when available, else global; null when
   * nothing is trained. Every scored feature vector feeds the drift monitor.
   */
  score(scannerId: string, f: Features, opts: { record?: boolean; tf?: string } = {}): { prob: number; raw: number; model: 'scanner' | 'global'; calibrated: boolean } | null {
    if (opts.record !== false) this.recordLive(f);
    // A timeframe-aware caller never falls back to a model trained on another horizon.
    const scannerKey = opts.tf ? JSON.stringify([scannerId, opts.tf]) : scannerId;
    const m = this.models.get(scannerKey) ?? (opts.tf ? this.timeframeModels.get(opts.tf) : this.globalModel);
    if (!m) return null;
    return { prob: predict(m, f, true), raw: predict(m, f, false), model: this.models.has(scannerKey) ? 'scanner' : 'global', calibrated: Boolean(m.calibration) };
  }

  scoreEntry(scannerId:string,f:Features,ctx:PredictionContext,record=true){
    const score=this.score(scannerId,f,{tf:ctx.tf,record});if(!score)return null;
    let receiptId:string|undefined;
    try{receiptId=this.predictionEvidence.record(scannerId,f,score.prob,`${score.model}:${ctx.tf}`,this.modelEvidence,ctx);}
    catch(e){log.warn(`prediction receipt unavailable: ${String(e)}`);}
    return {...score,receiptId};
  }
  bindPrediction(id:string|undefined,book:number,positionId:number|undefined|null,policyId:string|undefined){
    if(!id||positionId==null||!policyId)return;
    try{this.predictionEvidence.bind(id,book,positionId,policyId);}catch(e){log.warn(`prediction binding unavailable: ${String(e)}`);}
  }

  private recordLive(f: Features) {
    this.liveFeatures.push({ at: Date.now(), f });
    if (this.liveFeatures.length > DRIFT_WINDOW) this.liveFeatures.splice(0, this.liveFeatures.length - DRIFT_WINDOW);
    try { this.db.kvSet('ml.liveFeatures', this.liveFeatures); } catch (e: any) { log.warn(`persist live features failed: ${e?.message ?? e}`); }
  }

  /** Per-feature mean/std of the last live samples versus the global model's training distribution. */
  drift(threshold = 0.5): DriftReport {
    const live = this.liveFeatures.map(x => featureVector(x.f));
    const n = live.length;
    const m = this.globalModel;
    const features: DriftFeature[] = FEATURE_NAMES.map((name, j) => {
      let mean = 0, sd = 0;
      if (n) { mean = live.reduce((a, r) => a + r[j], 0) / n; sd = Math.sqrt(live.reduce((a, r) => a + (r[j] - mean) ** 2, 0) / n); }
      const tm = m?.mean[j] ?? 0, ts = m?.std[j] ?? 0;
      const shift = m && ts > 0 && n ? (mean - tm) / ts : 0;
      return { feature: name, label: FEATURE_LABELS[name], trainMean: tm, trainStd: ts, liveMean: mean, liveStd: sd, shift, drifted: Boolean(m) && n >= 30 && Math.abs(shift) > threshold };
    });
    return { at: Date.now(), n, window: DRIFT_WINDOW, threshold, drifted: features.filter(f => f.drifted).length, features };
  }

  /** Snapshot plus the live drift report (`drift`) — this is what `GET /api/ml` returns (drift is reported even before the first training). */
  insights(): MlSnapshot & { drift: DriftReport } { return { ...(this.snapshot ?? { trainedAt: null, samples: 0, liveSamples: 0, liveSinceReset: 0, scannersWithModel: 0, global: null, scanners: [] }), drift: this.drift() }; }
  insightFor(scannerId: string): ScannerInsight | null { return this.snapshot?.scanners.find(s => s.scannerId === scannerId) ?? null; }
}
