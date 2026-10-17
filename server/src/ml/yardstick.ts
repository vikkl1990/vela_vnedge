/**
 * The yardstick for the model's gate (decision 108): would refusing entries below a probability
 * have paid, on trades that really happened?
 *
 * Every closed trade of a book carries the probability the model gave it at entry (or, for trades
 * opened without one, the probability the current model gives the same entry after the fact).
 * The trades are bucketed by that probability, and for each candidate threshold the book is split
 * into what a gate at that level would have kept and what it would have dropped. A gate pays when
 * the trades it drops are a losing set large enough to matter — not when it merely raises the
 * average by discarding winners along with losers (decision 37's trap).
 *
 * Pure functions over (probability, R) pairs; the app supplies the trades, the page shows the table.
 */

export interface YardTrade { r: number; prob: number | null; scored: 'entry' | 'later' | null }
export interface YardBucket { label: string; lo: number; hi: number; n: number; avgR: number; winRatePct: number; sumR: number }
export interface YardThreshold {
  minProb: number; kept: number; keptAvgR: number; keptSumR: number;
  dropped: number; droppedAvgR: number; droppedSumR: number;
  /** R the book would have had under the gate minus the R it had: positive means the gate paid. */
  deltaSumR: number;
}
export interface YardVerdict { pays: boolean; minProb: number | null; text: string }
export interface YardBook {
  trades: number; scored: number; scoredAtEntry: number; unscored: number;
  allAvgR: number; allSumR: number;
  /** Rank agreement between probability and outcome on the scored trades: 0.5 is a coin flip. */
  auc: number | null;
  buckets: YardBucket[];
  thresholds: YardThreshold[];
  verdict: YardVerdict;
}

export const THRESHOLDS = [0.45, 0.5, 0.55, 0.6, 0.65] as const;
const EDGES = [0, 0.45, 0.5, 0.55, 0.6, 0.65, 1.0001];
const LABELS = ['< 45%', '45–50%', '50–55%', '55–60%', '60–65%', '≥ 65%'];

/** The smallest losing set a gate must remove before it is said to pay. */
export const MIN_DROPPED = 20;
export const MIN_DROPPED_SUM_R = 2;
export const MIN_DROPPED_AVG_R = -0.1;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

/** Area under the ROC curve of `prob` against `r > 0`, by ranks (ties split); null without both outcomes. */
export function rankAuc(pairs: Array<{ prob: number; win: boolean }>): number | null {
  const wins = pairs.filter(p => p.win).length, losses = pairs.length - wins;
  if (!wins || !losses) return null;
  const sorted = [...pairs].sort((a, b) => a.prob - b.prob);
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].prob === sorted[i].prob) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k].win) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - wins * (wins + 1) / 2) / (wins * losses);
}

export function yardstick(trades: YardTrade[]): YardBook {
  const all = trades.filter(t => Number.isFinite(t.r));
  const scored = all.filter(t => typeof t.prob === 'number' && Number.isFinite(t.prob));
  const rs = all.map(t => t.r);
  const buckets: YardBucket[] = LABELS.map((label, i) => {
    const g = scored.filter(t => t.prob! >= EDGES[i] && t.prob! < EDGES[i + 1]);
    const r = g.map(t => t.r);
    return { label, lo: EDGES[i], hi: Math.min(1, EDGES[i + 1]), n: g.length, avgR: mean(r), winRatePct: g.length ? g.filter(t => t.r > 0).length / g.length * 100 : 0, sumR: sum(r) };
  });
  // an unscored trade is taken by every gate: there is nothing to refuse it on (the shadow ledger's rule)
  const unscored = all.filter(t => !(typeof t.prob === 'number' && Number.isFinite(t.prob)));
  const thresholds: YardThreshold[] = THRESHOLDS.map(minProb => {
    const kept = [...scored.filter(t => t.prob! >= minProb), ...unscored], dropped = scored.filter(t => t.prob! < minProb);
    const keptR = kept.map(t => t.r), dropR = dropped.map(t => t.r);
    return { minProb, kept: kept.length, keptAvgR: mean(keptR), keptSumR: sum(keptR), dropped: dropped.length, droppedAvgR: mean(dropR), droppedSumR: sum(dropR), deltaSumR: sum(keptR) - sum(rs) };
  });
  return {
    trades: all.length, scored: scored.length, scoredAtEntry: scored.filter(t => t.scored === 'entry').length, unscored: unscored.length,
    allAvgR: mean(rs), allSumR: sum(rs),
    auc: rankAuc(scored.map(t => ({ prob: t.prob!, win: t.r > 0 }))),
    buckets, thresholds,
    verdict: verdictOf(thresholds, all.length),
  };
}

/** The gate pays at the threshold that removes the most R, provided what it removes is a losing set that matters. */
export function verdictOf(thresholds: YardThreshold[], n: number): YardVerdict {
  const paying = thresholds.filter(t => t.dropped >= MIN_DROPPED && t.droppedSumR <= -MIN_DROPPED_SUM_R && t.droppedAvgR <= MIN_DROPPED_AVG_R);
  if (!paying.length) {
    if (n < MIN_DROPPED * 2) return { pays: false, minProb: null, text: `${n} trades: too few to judge a gate (need ${MIN_DROPPED * 2})` };
    const best = [...thresholds].sort((a, b) => b.deltaSumR - a.deltaSumR)[0];
    return { pays: false, minProb: null, text: best && best.dropped ? `no threshold drops a losing set of ${MIN_DROPPED} or more trades; the best, ${pct(best.minProb)}, drops ${best.dropped} trades worth ${fmtR(best.droppedSumR)}` : 'no threshold drops anything' };
  }
  const best = [...paying].sort((a, b) => b.deltaSumR - a.deltaSumR)[0];
  return { pays: true, minProb: best.minProb, text: `a gate at ${pct(best.minProb)} would have dropped ${best.dropped} trades worth ${fmtR(best.droppedSumR)} (${fmtR(best.droppedAvgR)} each) and kept ${best.kept} at ${fmtR(best.keptAvgR)} each` };
}

/**
 * One call across the books: the shadow book is the out-of-sample test (its trades never train the
 * model), so it decides; the live book, which does train it, may only veto a gate that would have
 * cost it R.
 */
export function theCall(live: YardBook, shadow: YardBook): { minProb: number | null; text: string } {
  if (!shadow.verdict.pays || shadow.verdict.minProb === null) return { minProb: null, text: `the shadow book does not pay a gate: ${shadow.verdict.text}` };
  const at = live.thresholds.find(t => t.minProb === shadow.verdict.minProb);
  if (at && at.dropped >= 5 && at.deltaSumR < -1) return { minProb: null, text: `the shadow book pays a gate at ${pct(shadow.verdict.minProb)} but the account would have lost ${fmtR(-at.deltaSumR)} under it; no gate` };
  return { minProb: shadow.verdict.minProb, text: `set ml.minProb to ${shadow.verdict.minProb}: ${shadow.verdict.text}` };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}R`;
