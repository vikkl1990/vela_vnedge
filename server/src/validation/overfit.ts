/**
 * Selection-bias checks for screens (LuxAlgo Quant 2.0's validation set, after Bailey & López de Prado):
 *
 *   - Probability of Backtest Overfitting by combinatorially symmetric cross-validation (CSCV): split the history
 *     into S time blocks; for every way of calling half of them in-sample, take the candidate that did best there
 *     and see where it ranks on the other half. PBO is the share of splits where it lands in the bottom half. Near
 *     0: picking the best in-sample also picks well out of sample. Near 0.5 or above: the ranking is noise.
 *   - Deflated Sharpe Ratio: the probability that a candidate's Sharpe ratio beats the best one you would expect
 *     from `trials` candidates with no skill, given their spread of Sharpe ratios, the sample length, and the
 *     skew and fat tails of the returns. A screen of thousands of scripts needs a far higher Sharpe to mean anything
 *     than a single test does.
 *
 * Returns are per trade (R); Sharpe ratios are per trade, not annualised. Pure functions, no I/O.
 */

/** Running sums of a return series, so a candidate can be pooled across markets without keeping every trade. */
export interface Moments { n: number; s1: number; s2: number; s3: number; s4: number }

export const emptyMoments = (): Moments => ({ n: 0, s1: 0, s2: 0, s3: 0, s4: 0 });
export function momentsOf(rs: number[]): Moments {
  const m = emptyMoments();
  for (const r of rs) { m.n++; m.s1 += r; m.s2 += r * r; m.s3 += r ** 3; m.s4 += r ** 4; }
  return m;
}
export function addMoments(a: Moments, b: Moments): Moments {
  return { n: a.n + b.n, s1: a.s1 + b.s1, s2: a.s2 + b.s2, s3: a.s3 + b.s3, s4: a.s4 + b.s4 };
}

/** Mean, sample standard deviation, Sharpe ratio, skewness and (non-excess) kurtosis from running sums. */
export function momentStats(m: Moments): { n: number; mean: number; sd: number; sr: number; skew: number; kurt: number } {
  const n = m.n;
  if (n < 2) return { n, mean: n ? m.s1 / n : 0, sd: 0, sr: 0, skew: 0, kurt: 3 };
  const mean = m.s1 / n;
  const c2 = m.s2 / n - mean ** 2;                                    // population central moments
  const c3 = m.s3 / n - 3 * mean * m.s2 / n + 2 * mean ** 3;
  const c4 = m.s4 / n - 4 * mean * m.s3 / n + 6 * mean ** 2 * m.s2 / n - 3 * mean ** 4;
  const sd = Math.sqrt(Math.max(0, c2) * n / (n - 1));
  const pop = Math.sqrt(Math.max(0, c2));
  return { n, mean, sd, sr: sd > 0 ? mean / sd : 0, skew: pop > 0 ? c3 / pop ** 3 : 0, kurt: pop > 0 ? c4 / pop ** 4 : 3 };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + Math.sign(z) * erf);
}
/** Inverse standard normal CDF by bisection (plenty for p in [1e-12, 1 - 1e-12]). */
export function normInv(p: number): number {
  let lo = -12, hi = 12;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (normCdf(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

const EULER = 0.5772156649015329;
/** The Sharpe ratio the best of `trials` skill-less candidates would reach by luck, given their Sharpe variance. */
export function expectedMaxSharpe(trials: number, srVariance: number): number {
  if (!(trials > 1) || !(srVariance > 0)) return 0;
  return Math.sqrt(srVariance) * ((1 - EULER) * normInv(1 - 1 / trials) + EULER * normInv(1 - 1 / (trials * Math.E)));
}

/** P(true Sharpe > sr0) given the observed per-trade Sharpe, sample length, skew and kurtosis (probabilistic Sharpe ratio). */
export function probabilisticSharpe(sr: number, n: number, skew: number, kurt: number, sr0: number): number {
  if (n < 2) return 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - sr0) * Math.sqrt(n - 1)) / denom);
}

/** Deflated Sharpe ratio: the probabilistic Sharpe against the luck benchmark of `trials` candidates. */
export function deflatedSharpe(m: Moments, trials: number, srVariance: number): { dsr: number; sr: number; sr0: number } {
  const s = momentStats(m), sr0 = expectedMaxSharpe(trials, srVariance);
  return { dsr: probabilisticSharpe(s.sr, s.n, s.skew, s.kurt, sr0), sr: s.sr, sr0 };
}

/**
 * PBO by CSCV. `perf[b][j]` is candidate j's performance in time block b (total R, say); S = perf.length must be
 * even and at least 4. Candidates with no data in a block score 0 there. Ties rank in the middle.
 */
export function pboCscv(perf: number[][]): { pbo: number; splits: number; medianLogit: number } {
  const S = perf.length, J = perf[0]?.length ?? 0;
  if (S < 4 || S % 2 || J < 2) return { pbo: NaN, splits: 0, medianLogit: NaN };
  const halves: number[][] = [];
  const pick = (start: number, cur: number[]) => {
    if (cur.length === S / 2) { if (cur[0] === 0) halves.push([...cur]); return; }   // a half and its complement are one split
    for (let b = start; b < S; b++) { cur.push(b); pick(b + 1, cur); cur.pop(); }
  };
  pick(0, []);
  const logits: number[] = [];
  let below = 0;
  const sumOver = (bs: number[]) => { const out = new Array<number>(J).fill(0); for (const b of bs) for (let j = 0; j < J; j++) out[j] += perf[b][j] ?? 0; return out; };
  for (const half of halves) {
    for (const [isB, oosB] of [[half, complement(half, S)], [complement(half, S), half]]) {
      const is = sumOver(isB), oos = sumOver(oosB);
      let best = 0; for (let j = 1; j < J; j++) if (is[j] > is[best]) best = j;
      let lower = 0, equal = 0; for (let j = 0; j < J; j++) { if (j === best) continue; if (oos[j] < oos[best]) lower++; else if (oos[j] === oos[best]) equal++; }
      const w = (lower + equal / 2 + 0.5) / J;   // relative rank in (0, 1)
      logits.push(Math.log(w / (1 - w)));
      if (w < 0.5) below++;
    }
  }
  const sorted = [...logits].sort((a, b) => a - b);
  return { pbo: below / logits.length, splits: logits.length, medianLogit: sorted[Math.floor(sorted.length / 2)] };
}
function complement(bs: number[], S: number) { return [...Array(S).keys()].filter(b => !bs.includes(b)); }
