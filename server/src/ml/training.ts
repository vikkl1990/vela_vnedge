/**
 * Pure model fitting for MlService (improvement plan S4). No database, no service state: the
 * same function runs in-process (tests, in-memory databases, worker failure) or inside
 * `trainWorker.ts`, so ML fitting can leave the market-data event loop without changing results.
 */
import { deriveRules, trainLogReg, type LogRegModel, type Rule, type Sample } from './model.ts';

export const MIN_SCANNER_SAMPLES = 40;
/** The newest rows training reads, as before. */
export const TRAINING_ROW_LIMIT = 100_000;

export interface TrainingInput {
  /** Scripts whose samples are excluded (decision 87). */
  excluded: string[];
  /** Training cutoff: only outcomes resolved at or before it are used. */
  t0: number;
  /** Account reset time, for the live-since-reset count. */
  resetAt: number;
}

export interface TrainingResult {
  globalModel: LogRegModel | null;
  timeframeModels: Array<[string, LogRegModel]>;
  /** Per-scanner (`id`) and per-cell (`JSON.stringify([id, tf])`) models. */
  models: Array<[string, LogRegModel]>;
  timeframeMetrics: Array<{ scannerId: string | null; tf: string; model: LogRegModel['metrics'] }>;
  global: { rules: Rule[]; baseline: { n: number; winRate: number; avgR: number } };
  scanners: Array<{ scannerId: string; samples: number; liveSamples: number; baseline: { n: number; winRate: number; avgR: number }; rules: Rule[]; model: LogRegModel | null }>;
  eligible: number; liveSamples: number; liveSinceReset: number;
  /** Newest resolution time among the samples used (0 when none). */
  maxResolvedAt: number;
  ms: number;
}

/** `ml_samples` rows → samples. */
export function rowsToSamples(rows: any[]): Sample[] {
  return rows.map(r => ({ scannerId: r.scanner_id, symbol: r.symbol, tf: r.tf, at: r.at, features: JSON.parse(r.features), win: r.win, r: r.r, pnl: r.pnl, exitReason: r.exit_reason, bt: Boolean(r.bt), resolvedAt: r.resolved_at ?? null }));
}

/** The samples training may use: not excluded, and resolved after entry and by the cutoff. */
export function eligibleSamples(samples: Sample[], inp: Pick<TrainingInput, 'excluded' | 't0'>): Sample[] {
  const ex = new Set(inp.excluded);
  return samples.filter(s => !ex.has(s.scannerId) && s.resolvedAt != null && Number.isFinite(s.resolvedAt) && s.resolvedAt >= s.at && s.resolvedAt <= inp.t0);
}

/** Fit the global, per-timeframe, per-scanner and per-cell models and derive rules. */
export function computeTraining(all: Sample[], inp: Pick<TrainingInput, 'resetAt'>): TrainingResult {
  const started = Date.now();
  const byScanner = new Map<string, Sample[]>();
  for (const s of all) { const l = byScanner.get(s.scannerId) ?? []; l.push(s); byScanner.set(s.scannerId, l); }
  const timeframeMetrics: TrainingResult['timeframeMetrics'] = [];
  const globalModel = trainLogReg(all);
  const timeframeModels: Array<[string, LogRegModel]> = [];
  for (const tf of new Set(all.map(s => s.tf))) {
    const model = trainLogReg(all.filter(s => s.tf === tf));
    if (model) { timeframeModels.push([tf, model]); timeframeMetrics.push({ scannerId: null, tf, model: model.metrics }); }
  }
  const g = deriveRules(all, { minN: 50 });
  const models: Array<[string, LogRegModel]> = [];
  const scanners: TrainingResult['scanners'] = [];
  for (const [id, list] of byScanner) {
    const m = list.length >= MIN_SCANNER_SAMPLES ? trainLogReg(list) : null;
    if (m) models.push([id, m]);
    for (const tf of new Set(list.map(s => s.tf))) {
      const rows = list.filter(s => s.tf === tf);
      const cell = rows.length >= MIN_SCANNER_SAMPLES ? trainLogReg(rows) : null;
      if (cell) { models.push([JSON.stringify([id, tf]), cell]); timeframeMetrics.push({ scannerId: id, tf, model: cell.metrics }); }
    }
    const { baseline, rules } = deriveRules(list);
    scanners.push({ scannerId: id, samples: list.length, liveSamples: list.filter(s => !s.bt).length, baseline, rules, model: m });
  }
  return {
    globalModel, timeframeModels, models, timeframeMetrics, global: { rules: g.rules, baseline: g.baseline }, scanners,
    eligible: all.length, liveSamples: all.filter(s => !s.bt).length, liveSinceReset: all.filter(s => !s.bt && s.at >= inp.resetAt).length,
    maxResolvedAt: all.reduce((v, s) => Math.max(v, s.resolvedAt!), 0), ms: Date.now() - started,
  };
}
