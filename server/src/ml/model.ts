/**
 * Dependency-free learning on trade samples:
 *  - logistic regression (standardised features, L2, gradient descent) → P(win)
 *  - time-ordered holdout metrics (accuracy, AUC, log-loss)
 *  - bucket lift analysis → human-readable improvement rules per scanner
 */
import { FEATURE_NAMES, FEATURE_LABELS, type FeatureName, type Features, featureVector } from './features.ts';

export interface Sample {
  scannerId: string; symbol: string; tf: string; at: number;
  features: Features; win: number; r: number; pnl: number; exitReason: string; bt: boolean;
  /** Decision 192: when the outcome became known (the trade's exit); a sample still open at a split's boundary is purged from the side before it. */
  resolvedAt?: number | null;
}

export interface ReliabilityBucket { lo: number; hi: number; n: number; predicted: number; observed: number }

export interface ModelMetrics {
  /** Untouched test block: a constant fit-period win rate and a fixed, unoptimized .55 gate. */
  economic?: { baselineBrier: number; calibratedBrierSkill: number; testNetR: number; selectedN: number; selectedNetR: number; rejectedNetR: number; threshold: number };
  holdout: number; accuracy: number; auc: number; logLoss: number; baseWinRate: number;
  /**
   * Walk-forward split (decision 192): fitted on the oldest samples, Platt-calibrated on the next block, and every metric
   * below comes from the newest `testN` samples, which neither step saw. `purged`: samples left out of a fit because
   * their outcome was not known until after that step's boundary.
   */
  walkForward: { trainN: number; testN: number; trainTo: number; testFrom: number; testTo: number; calibrationN?: number; purged?: number };
  /** Brier score of the raw and the Platt-calibrated probabilities on the test block. */
  brier: number; brierCalibrated: number;
  logLossCalibrated: number;
  /** Reliability (calibration) buckets on the holdout: predicted vs observed win rate, raw and calibrated. */
  reliability: ReliabilityBucket[]; reliabilityCalibrated: ReliabilityBucket[];
}

export interface LogRegModel {
  mean: number[]; std: number[]; weights: number[]; bias: number; n: number;
  metrics: ModelMetrics;
  importance: Array<{ feature: FeatureName; label: string; weight: number }>;
  /** Platt scaling fitted on the holdout: p' = sigmoid(a·logit(p) + b). Null for models saved before calibration existed. */
  calibration: { a: number; b: number } | null;
}

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }
function logit(p: number) { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); }

/** Platt scaling: fit (a, b) minimising log-loss of sigmoid(a·z + b) on holdout logits. */
export function fitPlatt(logits: number[], ys: number[], opts: { epochs?: number; lr?: number; l2?: number } = {}): { a: number; b: number } {
  const n = logits.length;
  if (n < 10) return { a: 1, b: 0 };
  // Platt's prior-corrected targets reduce over-fitting on small holdouts
  const pos = ys.reduce((s, y) => s + y, 0), neg = n - pos;
  const tPos = (pos + 1) / (pos + 2), tNeg = 1 / (neg + 2);
  let a = 1, b = 0;
  const lr = opts.lr ?? 0.05, l2 = opts.l2 ?? 0.001, epochs = opts.epochs ?? 500;
  for (let ep = 0; ep < epochs; ep++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) { const t = ys[i] ? tPos : tNeg; const e = sigmoid(a * logits[i] + b) - t; ga += e * logits[i]; gb += e; }
    a -= lr * (ga / n + l2 * (a - 1)); b -= lr * (gb / n + l2 * b);
  }
  return { a, b };
}

/** Bucket predicted probabilities and compare with observed outcomes. */
export function reliability(probs: number[], ys: number[], buckets = 5): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = Array.from({ length: buckets }, (_, k) => ({ lo: k / buckets, hi: (k + 1) / buckets, n: 0, predicted: 0, observed: 0 }));
  for (let i = 0; i < probs.length; i++) { const k = Math.min(buckets - 1, Math.floor(probs[i] * buckets)); out[k].n++; out[k].predicted += probs[i]; out[k].observed += ys[i]; }
  for (const b of out) { if (b.n) { b.predicted /= b.n; b.observed /= b.n; } }
  return out;
}

function brier(probs: number[], ys: number[]): number { let s = 0; for (let i = 0; i < probs.length; i++) s += (probs[i] - ys[i]) ** 2; return probs.length ? s / probs.length : 0; }
function logLoss(probs: number[], ys: number[]): number { let ll = 0; for (let i = 0; i < probs.length; i++) { const p = Math.min(1 - 1e-6, Math.max(1e-6, probs[i])); ll -= ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p); } return probs.length ? ll / probs.length : 0; }

export function trainLogReg(samples: Sample[], opts: { epochs?: number; lr?: number; l2?: number; holdoutFrac?: number } = {}): LogRegModel | null {
  const n = samples.length;
  if (n < 30) return null;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const X = sorted.map(s => featureVector(s.features));
  const y = sorted.map(s => s.win);
  const d = FEATURE_NAMES.length;
  // decision 192: three blocks in time — fit, calibrate, test — so the calibrated scores are measured on samples the
  // calibration never saw; a sample whose outcome was still unknown at a block's boundary is purged from that block's fit
  const holdout = Math.max(20, Math.floor(n * (opts.holdoutFrac ?? 0.2)));
  const trainN = n - holdout;
  const calN = Math.floor(holdout / 2), testStart = trainN + calN;
  const known = (i: number, boundary: number) => sorted[i].resolvedAt == null || sorted[i].resolvedAt! <= boundary;
  const fitIdx: number[] = [];
  for (let i = 0; i < trainN; i++) if (known(i, sorted[trainN].at)) fitIdx.push(i);
  let purged = trainN - fitIdx.length;
  if (fitIdx.length < 10) return null;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  const fN = fitIdx.length;
  for (let j = 0; j < d; j++) { let s = 0; for (const i of fitIdx) s += X[i][j]; mean[j] = s / fN; let v = 0; for (const i of fitIdx) v += (X[i][j] - mean[j]) ** 2; std[j] = Math.sqrt(v / fN) || 1; }
  const Z = X.map(row => row.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0); let b = 0;
  const lr = opts.lr ?? 0.05, l2 = opts.l2 ?? 0.01, epochs = opts.epochs ?? 300;
  for (let ep = 0; ep < epochs; ep++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (const i of fitIdx) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / fN + l2 * w[j]);
    b -= lr * (gb / fN);
  }
  const logitOf = (i: number) => { let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j]; return z; };
  // the calibration block: Platt scaling is fitted here, on outcomes known before the test block starts
  const calLogits: number[] = [], calYs: number[] = [];
  for (let i = trainN; i < testStart; i++) { if (!known(i, sorted[testStart].at)) { purged++; continue; } calLogits.push(logitOf(i)); calYs.push(y[i]); }
  // the test block: the newest samples, seen by neither the fit nor the calibration
  const probs: number[] = [], ys: number[] = [], logits: number[] = [];
  for (let i = testStart; i < n; i++) { const z = logitOf(i); logits.push(z); probs.push(sigmoid(z)); ys.push(y[i]); }
  let correct = 0;
  for (let i = 0; i < probs.length; i++) if ((probs[i] >= 0.5 ? 1 : 0) === ys[i]) correct++;
  const auc = rankAuc(probs, ys);
  const base = ys.reduce((a, v) => a + v, 0) / Math.max(1, ys.length);
  const importance = FEATURE_NAMES.map((f, j) => ({ feature: f, label: FEATURE_LABELS[f], weight: Number(w[j].toFixed(4)) })).sort((a, c) => Math.abs(c.weight) - Math.abs(a.weight));
  const calibration = calLogits.length >= 5 ? fitPlatt(calLogits, calYs) : { a: 1, b: 0 };
  const calProbs = logits.map(z => sigmoid(calibration.a * z + calibration.b));
  const fitPrior = fitIdx.reduce((sum, i) => sum + y[i], 0) / fN;
  const baselineBrier = brier(ys.map(() => fitPrior), ys);
  const testRows = sorted.slice(testStart);
  const selected = testRows.filter((_, i) => calProbs[i] >= .55);
  const testNetR = testRows.reduce((sum, s) => sum + s.r, 0);
  const selectedNetR = selected.reduce((sum, s) => sum + s.r, 0);
  const metrics: ModelMetrics = {
    economic: { baselineBrier, calibratedBrierSkill: baselineBrier > 0 ? 1 - brier(calProbs, ys) / baselineBrier : 0,
      testNetR, selectedN: selected.length, selectedNetR, rejectedNetR: testNetR - selectedNetR, threshold: .55 },
    holdout: probs.length, accuracy: correct / Math.max(1, probs.length), auc, logLoss: logLoss(probs, ys), baseWinRate: base,
    walkForward: { trainN: fN, testN: probs.length, trainTo: sorted[trainN - 1]?.at ?? 0, testFrom: sorted[testStart]?.at ?? 0, testTo: sorted[n - 1]?.at ?? 0, calibrationN: calLogits.length, purged },
    brier: brier(probs, ys), brierCalibrated: brier(calProbs, ys), logLossCalibrated: logLoss(calProbs, ys),
    reliability: reliability(probs, ys), reliabilityCalibrated: reliability(calProbs, ys),
  };
  return { mean, std, weights: w, bias: b, n, metrics, importance, calibration };
}

/** P(win). `calibrated` (default) applies the model's Platt scaling when it has one. */
export function predict(model: LogRegModel, f: Features, calibrated = true): number {
  const x = featureVector(f);
  let z = model.bias;
  for (let j = 0; j < x.length; j++) { const w = model.weights[j]; if (w === undefined) continue; z += w * ((x[j] - model.mean[j]) / (model.std[j] || 1)); }
  if (calibrated && model.calibration) return sigmoid(model.calibration.a * z + model.calibration.b);
  return sigmoid(z);
}

/** Apply a model's calibration to a raw probability (for probabilities produced elsewhere). */
export function calibrate(model: Pick<LogRegModel, 'calibration'>, rawProb: number): number {
  if (!model.calibration) return rawProb;
  return sigmoid(model.calibration.a * logit(rawProb) + model.calibration.b);
}

function rankAuc(p: number[], y: number[]): number {
  const pos = p.filter((_, i) => y[i] === 1), neg = p.filter((_, i) => y[i] === 0);
  if (!pos.length || !neg.length) return 0.5;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

// ---------- bucket lift analysis → rules ----------

export interface Rule {
  feature: FeatureName; label: string; kind: 'prefer' | 'avoid';
  condition: string; n: number; coverage: number; winRate: number; avgR: number; baselineAvgR: number; lift: number; text: string;
}

interface Bucket { name: string; test: (v: number) => boolean }

function bucketsFor(feature: FeatureName, values: number[]): Bucket[] {
  switch (feature) {
    case 'side_long': return [{ name: 'long', test: v => v === 1 }, { name: 'short', test: v => v === 0 }];
    case 'has_score': case 'lvl_script': case 'src_alert': case 'src_shape': case 'src_derived': case 'src_cond': return [{ name: 'yes', test: v => v >= 0.5 }, { name: 'no', test: v => v < 0.5 }];
    case 'hour': return [{ name: '00–07 UTC', test: v => v < 8 }, { name: '08–15 UTC', test: v => v >= 8 && v < 16 }, { name: '16–23 UTC', test: v => v >= 16 }];
    case 'dow': return [{ name: 'weekday', test: v => v >= 1 && v <= 5 }, { name: 'weekend', test: v => v === 0 || v === 6 }];
    default: {
      const s = [...values].sort((a, b) => a - b);
      if (!s.length || s[0] === s[s.length - 1]) return [];
      const q1 = s[Math.floor(s.length / 3)], q2 = s[Math.floor((2 * s.length) / 3)];
      if (q1 === q2) return [{ name: `≤ ${fmt(q1)}`, test: v => v <= q1 }, { name: `> ${fmt(q1)}`, test: v => v > q1 }];
      return [{ name: `low (≤ ${fmt(q1)})`, test: v => v <= q1 }, { name: `mid (${fmt(q1)}–${fmt(q2)})`, test: v => v > q1 && v <= q2 }, { name: `high (> ${fmt(q2)})`, test: v => v > q2 }];
    }
  }
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function deriveRules(samples: Sample[], opts: { minN?: number; minCoverage?: number; minLift?: number } = {}): { baseline: { n: number; winRate: number; avgR: number }; rules: Rule[] } {
  const n = samples.length;
  const minN = opts.minN ?? 20, minCov = opts.minCoverage ?? 0.2, minLift = opts.minLift ?? 0.15;
  const avg = (xs: Sample[]) => xs.reduce((a, s) => a + s.r, 0) / Math.max(1, xs.length);
  const wr = (xs: Sample[]) => xs.filter(s => s.win).length / Math.max(1, xs.length);
  const baseline = { n, winRate: wr(samples), avgR: avg(samples) };
  const rules: Rule[] = [];
  if (n < minN) return { baseline, rules };
  // samples recorded before a feature existed carry no value for it; read them as 0, as the model does
  const val = (s: Sample, f: FeatureName) => { const v = s.features[f]; return Number.isFinite(v) ? v : 0; };
  for (const f of FEATURE_NAMES) {
    const vals = samples.map(s => val(s, f));
    for (const bk of bucketsFor(f, vals)) {
      const inB = samples.filter(s => bk.test(val(s, f)));
      if (inB.length < minN || inB.length === n) continue;
      const cov = inB.length / n; const a = avg(inB); const lift = a - baseline.avgR;
      if (lift >= minLift && cov >= minCov) rules.push({ feature: f, label: FEATURE_LABELS[f], kind: 'prefer', condition: bk.name, n: inB.length, coverage: cov, winRate: wr(inB), avgR: a, baselineAvgR: baseline.avgR, lift, text: `Prefer ${FEATURE_LABELS[f]} ${bk.name}: avg ${a.toFixed(2)}R vs ${baseline.avgR.toFixed(2)}R baseline (${inB.length} trades, ${(cov * 100).toFixed(0)}% of entries)` });
      else if (-lift >= minLift && cov >= 0.1) rules.push({ feature: f, label: FEATURE_LABELS[f], kind: 'avoid', condition: bk.name, n: inB.length, coverage: cov, winRate: wr(inB), avgR: a, baselineAvgR: baseline.avgR, lift, text: `Avoid ${FEATURE_LABELS[f]} ${bk.name}: avg ${a.toFixed(2)}R vs ${baseline.avgR.toFixed(2)}R baseline (${inB.length} trades, ${(cov * 100).toFixed(0)}% of entries)` });
    }
  }
  rules.sort((a, b) => Math.abs(b.lift) * b.coverage - Math.abs(a.lift) * a.coverage);
  return { baseline, rules: rules.slice(0, 12) };
}
