/**
 * Phase 1: does a scanner's live record agree with the backtest it was chosen on? Pure functions, no I/O.
 *
 * Each (scanner, timeframe) has an explicit baseline: the mean and standard deviation of R a trade in its own
 * spread-charged backtest, and the time from which live trades count against it. The live trades since then are
 * tested against the baseline mean (one-sided: is live worse than expected?), and against zero (is there an edge?).
 *
 *   collecting  fewer than 10 live trades: nothing to say yet
 *   pause       20+ trades, live significantly below the baseline (p < 0.05) and losing; or the live sum is −10R or worse
 *   watch       10+ trades and live below the baseline at p < 0.20
 *   confirmed   30+ trades, not below the baseline (p ≥ 0.20), and the live edge itself has a probabilistic Sharpe ≥ 95%
 *   consistent  otherwise: in line with the backtest so far
 */
import { momentStats, momentsOf, normCdf, probabilisticSharpe } from '../validation/overfit.ts';

export interface Baseline { meanR: number; sdR: number; n: number; since: number; source: string }
export type VerdictState = 'collecting' | 'consistent' | 'watch' | 'pause' | 'confirmed';
export interface CellVerdict {
  state: VerdictState; n: number; meanR: number; sumR: number; baselineMeanR: number;
  /** P(live mean this low or lower | the baseline is true). Small = live is worse than the backtest. */
  pBelow: number | null;
  /** Probabilistic Sharpe of the live R against zero. */
  psr: number | null;
  reason: string;
}

export const VERDICT_RULES = { minN: 10, pauseN: 20, pauseP: 0.05, watchP: 0.2, confirmN: 30, confirmPsr: 0.95, breakerSumR: -10 } as const;

export function judgeCell(rs: number[], b: Baseline, rules = VERDICT_RULES): CellVerdict {
  const s = momentStats(momentsOf(rs));
  const base = { n: s.n, meanR: s.mean, sumR: s.mean * s.n, baselineMeanR: b.meanR };
  if (s.n > 0 && base.sumR <= rules.breakerSumR)
    return { ...base, state: 'pause', pBelow: null, psr: null, reason: `live trades lost ${base.sumR.toFixed(1)}R since ${new Date(b.since).toISOString().slice(0, 10)} (breaker ${rules.breakerSumR}R)` };
  if (s.n < rules.minN) return { ...base, state: 'collecting', pBelow: null, psr: null, reason: `${s.n} of ${rules.minN} live trades` };
  // the wider of the live and backtest spread, so a lucky low-variance start cannot make a small dip look significant
  const sd = Math.max(s.sd, b.sdR, 1e-9);
  const pBelow = normCdf((s.mean - b.meanR) / (sd / Math.sqrt(s.n)));
  const psr = probabilisticSharpe(s.sr, s.n, s.skew, s.kurt, 0);
  const v = { ...base, pBelow, psr };
  if (s.n >= rules.pauseN && pBelow < rules.pauseP && s.mean < 0)
    return { ...v, state: 'pause', reason: `live ${s.mean.toFixed(3)}R a trade over ${s.n} trades against a backtest ${b.meanR.toFixed(3)}R: this far below by chance has p ${pBelow.toFixed(3)}` };
  if (pBelow < rules.watchP) return { ...v, state: 'watch', reason: `live ${s.mean.toFixed(3)}R a trade below the backtest ${b.meanR.toFixed(3)}R (p ${pBelow.toFixed(2)})` };
  if (s.n >= rules.confirmN && psr >= rules.confirmPsr) return { ...v, state: 'confirmed', reason: `live edge ${s.mean.toFixed(3)}R a trade over ${s.n} trades, probabilistic Sharpe ${(psr * 100).toFixed(0)}%` };
  return { ...v, state: 'consistent', reason: `live ${s.mean.toFixed(3)}R a trade over ${s.n} trades, in line with the backtest ${b.meanR.toFixed(3)}R` };
}

/** One live-vs-backtest comparison for a market and timeframe over a window. */
export interface ParityTrade { at: number; side: string }
export interface ParitySignal { barTime: number; at: number; side: string | null; action: string }
export interface ParityResult {
  backtest: number; live: number; matched: number;
  /** Backtest trades the account did not take, with what the live engine did with that bar's signal. */
  backtestOnly: Array<{ at: number; side: string; live: string }>;
  /** Live trades the backtest does not have. */
  liveOnly: Array<{ at: number; side: string }>;
}

/** Match backtest entries to live entries of the same side within `slackMs`; explain each unmatched backtest trade. */
export function compareParity(bt: ParityTrade[], live: ParityTrade[], signals: ParitySignal[], slackMs: number): ParityResult {
  const used = new Set<number>();
  const res: ParityResult = { backtest: bt.length, live: live.length, matched: 0, backtestOnly: [], liveOnly: [] };
  for (const t of [...bt].sort((a, b) => a.at - b.at)) {
    const i = live.findIndex((l, j) => !used.has(j) && l.side === t.side && Math.abs(l.at - t.at) <= slackMs);
    if (i >= 0) { used.add(i); res.matched++; continue; }
    const sig = signals.filter(s => s.side === t.side && Math.abs(s.at - t.at) <= slackMs).sort((a, b) => Math.abs(a.at - t.at) - Math.abs(b.at - t.at))[0];
    res.backtestOnly.push({ at: t.at, side: t.side, live: sig ? sig.action : 'no live signal' });
  }
  live.forEach((l, j) => { if (!used.has(j)) res.liveOnly.push({ at: l.at, side: l.side }); });
  return res;
}

/** A refusal by the account's own portfolio rules (a backtest trades one market alone), or a bar the bot was not running for: expected, not missed. */
export function isPortfolioRefusal(action: string): boolean {
  return /^rejected:risk (burst|re-entry cooldown|max \d+ positions|scanner at its|max positions)|^rejected:max open positions|^ignored:already in position|paused by edge watch|^not running:/.test(action);
}
