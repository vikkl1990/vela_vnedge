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
}

export interface LogRegModel {
  mean: number[]; std: number[]; weights: number[]; bias: number; n: number;
  metrics: { holdout: number; accuracy: number; auc: number; logLoss: number; baseWinRate: number };
  importance: Array<{ feature: FeatureName; label: string; weight: number }>;
}

function sigmoid(z: number) { return 1 / (1 + Math.exp(-z)); }

export function trainLogReg(samples: Sample[], opts: { epochs?: number; lr?: number; l2?: number; holdoutFrac?: number } = {}): LogRegModel | null {
  const n = samples.length;
  if (n < 30) return null;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const X = sorted.map(s => featureVector(s.features));
  const y = sorted.map(s => s.win);
  const d = FEATURE_NAMES.length;
  const holdout = Math.max(10, Math.floor(n * (opts.holdoutFrac ?? 0.2)));
  const trainN = n - holdout;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < trainN; i++) s += X[i][j]; mean[j] = s / trainN; let v = 0; for (let i = 0; i < trainN; i++) v += (X[i][j] - mean[j]) ** 2; std[j] = Math.sqrt(v / trainN) || 1; }
  const Z = X.map(row => row.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0); let b = 0;
  const lr = opts.lr ?? 0.05, l2 = opts.l2 ?? 0.01, epochs = opts.epochs ?? 300;
  for (let ep = 0; ep < epochs; ep++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < trainN; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / trainN + l2 * w[j]);
    b -= lr * (gb / trainN);
  }
  // holdout metrics
  const probs: number[] = [], ys: number[] = [];
  for (let i = trainN; i < n; i++) { let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j]; probs.push(sigmoid(z)); ys.push(y[i]); }
  let correct = 0, ll = 0;
  for (let i = 0; i < probs.length; i++) { const p = Math.min(1 - 1e-6, Math.max(1e-6, probs[i])); if ((p >= 0.5 ? 1 : 0) === ys[i]) correct++; ll -= ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p); }
  const auc = rankAuc(probs, ys);
  const base = ys.reduce((a, v) => a + v, 0) / Math.max(1, ys.length);
  const importance = FEATURE_NAMES.map((f, j) => ({ feature: f, label: FEATURE_LABELS[f], weight: Number(w[j].toFixed(4)) })).sort((a, c) => Math.abs(c.weight) - Math.abs(a.weight));
  return { mean, std, weights: w, bias: b, n, metrics: { holdout: probs.length, accuracy: correct / Math.max(1, probs.length), auc, logLoss: ll / Math.max(1, probs.length), baseWinRate: base }, importance };
}

export function predict(model: LogRegModel, f: Features): number {
  const x = featureVector(f);
  let z = model.bias;
  for (let j = 0; j < x.length; j++) z += model.weights[j] * ((x[j] - model.mean[j]) / model.std[j]);
  return sigmoid(z);
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
  for (const f of FEATURE_NAMES) {
    const vals = samples.map(s => s.features[f]);
    for (const bk of bucketsFor(f, vals)) {
      const inB = samples.filter(s => bk.test(s.features[f]));
      if (inB.length < minN || inB.length === n) continue;
      const cov = inB.length / n; const a = avg(inB); const lift = a - baseline.avgR;
      if (lift >= minLift && cov >= minCov) rules.push({ feature: f, label: FEATURE_LABELS[f], kind: 'prefer', condition: bk.name, n: inB.length, coverage: cov, winRate: wr(inB), avgR: a, baselineAvgR: baseline.avgR, lift, text: `Prefer ${FEATURE_LABELS[f]} ${bk.name}: avg ${a.toFixed(2)}R vs ${baseline.avgR.toFixed(2)}R baseline (${inB.length} trades, ${(cov * 100).toFixed(0)}% of entries)` });
      else if (-lift >= minLift && cov >= 0.1) rules.push({ feature: f, label: FEATURE_LABELS[f], kind: 'avoid', condition: bk.name, n: inB.length, coverage: cov, winRate: wr(inB), avgR: a, baselineAvgR: baseline.avgR, lift, text: `Avoid ${FEATURE_LABELS[f]} ${bk.name}: avg ${a.toFixed(2)}R vs ${baseline.avgR.toFixed(2)}R baseline (${inB.length} trades, ${(cov * 100).toFixed(0)}% of entries)` });
    }
  }
  rules.sort((a, b) => Math.abs(b.lift) * b.coverage - Math.abs(a.lift) * a.coverage);
  return { baseline, rules: rules.slice(0, 12) };
}
