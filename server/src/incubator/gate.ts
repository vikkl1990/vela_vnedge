/**
 * The incubator's decisions, as pure functions of trade records.
 *
 * Everything is measured in R (net result over the risk at entry), not dollars: the shadow book
 * sizes against a notional purse so that no shadow pair is ever starved of margin by another, and R
 * is what transfers to the live account whatever its size.
 */
import type { IncubatorConfig } from '../config.ts';

export interface TradeR { entryAt: number; exitAt: number; r: number; side?: string }

export interface PairStats {
  trades: number; days: number; wins: number; winRatePct: number;
  netR: number; avgR: number; pfR: number | null;
  weeks: number; positiveWeeks: number; positiveWeeksPct: number;
}

const WEEK = 7 * 86400_000;

/** Stats of one pair's trades, counted from `since` (the day it entered the stage being judged). */
export function pairStats(trades: TradeR[], since: number, now = Date.now()): PairStats {
  const t = trades.filter(x => x.entryAt >= since);
  const gp = t.filter(x => x.r > 0).reduce((a, x) => a + x.r, 0);
  const gl = -t.filter(x => x.r <= 0).reduce((a, x) => a + x.r, 0);
  const netR = gp - gl;
  // weeks are counted from `since`; a week with no closed trade is neither positive nor negative
  const byWeek = new Map<number, number>();
  for (const x of t) { const w = Math.floor((x.exitAt - since) / WEEK); byWeek.set(w, (byWeek.get(w) ?? 0) + x.r); }
  const weeks = byWeek.size, positiveWeeks = [...byWeek.values()].filter(v => v > 0).length;
  const wins = t.filter(x => x.r > 0).length;
  return {
    trades: t.length, days: Math.max(0, (now - since) / 86400_000), wins, winRatePct: t.length ? wins / t.length * 100 : 0,
    netR, avgR: t.length ? netR / t.length : 0, pfR: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    weeks, positiveWeeks, positiveWeeksPct: weeks ? positiveWeeks / weeks * 100 : 0,
  };
}

export interface CohortMember { symbol: string; since: number; trades: TradeR[] }
export interface MarketLine { symbol: string; trades: number; netR: number; avgR: number }
export interface CohortStats extends PairStats {
  markets: number; marketsJudged: number; positiveMarkets: number; positiveMarketsPct: number; perMarket: MarketLine[];
}

/**
 * One scanner on one timeframe, judged on every market it runs in the shadow book at once.
 *
 * A single market produces about 0.35 trades a day, so a 30-trade sample takes five weeks on 15m and
 * half a year on 1h — longer than the 45 days a pair is allowed to brew. The edge being judged
 * belongs to the scanner, not to the market it happened to be admitted on, so the evidence is pooled
 * across its markets: five markets reach the same sample five times sooner. Each market's own trades
 * count only from the day that market joined, and the cohort's age is the age of its oldest member.
 */
export function cohortStats(members: CohortMember[], now = Date.now(), minMarketTrades = 3): CohortStats {
  const since = Math.min(...members.map(m => m.since));
  const per = members.map(m => {
    const t = m.trades.filter(x => x.entryAt >= m.since);
    const netR = t.reduce((a, x) => a + x.r, 0);
    return { symbol: m.symbol, trades: t.length, netR, avgR: t.length ? netR / t.length : 0 };
  });
  const base = pairStats(members.flatMap(m => m.trades.filter(x => x.entryAt >= m.since)), since, now);
  const judged = per.filter(p => p.trades >= minMarketTrades);
  const positive = judged.filter(p => p.netR > 0).length;
  return {
    ...base, markets: members.length, marketsJudged: judged.length, positiveMarkets: positive,
    positiveMarketsPct: judged.length ? positive / judged.length * 100 : 0,
    perMarket: per.sort((a, b) => b.avgR - a.avgR),
  };
}

export type GateVerdict = { decision: 'propose' | 'brewing' | 'retire'; reasons: string[] };

/**
 * Shadow → proposed, still brewing, or retired. Retirement is as deliberate as promotion: a pair
 * that has clearly failed on a full sample, or that has not proven itself in `maxDays`, frees its
 * slot for the next candidate instead of occupying it forever.
 */
export function gateVerdict(s: PairStats, g: IncubatorConfig['gate'], overlapPct = 0): GateVerdict {
  const pf = s.pfR ?? Infinity;
  const checks: Array<[boolean, string]> = [
    [s.trades >= g.minTrades, `${s.trades}/${g.minTrades} trades`],
    [s.days >= g.minDays, `${s.days.toFixed(1)}/${g.minDays} days`],
    [pf >= g.minPfR, `PF ${fmtPf(s.pfR)} (need ${g.minPfR})`],
    [s.positiveWeeksPct >= g.minPositiveWeeksPct, `${s.positiveWeeks}/${s.weeks} weeks positive (need ${g.minPositiveWeeksPct}%)`],
    [s.avgR >= g.minAvgR, `${s.avgR.toFixed(2)}R per trade (need ${g.minAvgR})`],
    [overlapPct <= g.maxOverlapPct, `${overlapPct.toFixed(0)}% of entries duplicate a live pair (max ${g.maxOverlapPct}%)`],
  ];
  const failing = checks.filter(c => !c[0]).map(c => c[1]);
  if (!failing.length) return { decision: 'propose', reasons: checks.map(c => c[1]) };
  if (s.trades >= g.minTrades && pf < g.failPfR) return { decision: 'retire', reasons: [`failed on a full sample: PF ${fmtPf(s.pfR)} < ${g.failPfR} over ${s.trades} trades`] };
  if (s.days >= g.maxDays) return { decision: 'retire', reasons: [`not proven after ${g.maxDays} days: ${failing.join('; ')}`] };
  return { decision: 'brewing', reasons: failing };
}

/**
 * The same gate, plus breadth: a cohort carried by one lucky market is not a scanner with an edge.
 * Breadth is only asked of cohorts with at least two markets that have traded enough to judge.
 */
export function cohortVerdict(s: CohortStats, g: IncubatorConfig['gate'], overlap = 0): GateVerdict {
  const v = gateVerdict(s, g, overlap);
  const broad = s.marketsJudged < 2 || s.positiveMarketsPct >= g.minPositiveMarketsPct;
  const breadth = `${s.positiveMarkets}/${s.marketsJudged} markets positive (need ${g.minPositiveMarketsPct}%)`;
  if (broad) return v.decision === 'propose' ? { ...v, reasons: [...v.reasons, breadth] } : v;
  if (v.decision === 'retire') return v;
  return { decision: 'brewing', reasons: [...v.reasons.filter(r => !r.startsWith('propose')), breadth] };
}

/** Live → proposed for demotion, judged on its most recent `window` trades. */
export function demoteVerdict(trades: TradeR[], d: IncubatorConfig['demote']): { demote: boolean; stats: PairStats; reason: string } {
  const recent = [...trades].sort((a, b) => a.exitAt - b.exitAt).slice(-d.window);
  const stats = pairStats(recent, 0, recent.at(-1)?.exitAt ?? Date.now());
  const pf = stats.pfR ?? Infinity;
  const demote = stats.trades >= d.minTrades && pf < d.maxPfR;
  return { demote, stats, reason: `last ${stats.trades} live trades: PF ${fmtPf(stats.pfR)}, ${stats.netR.toFixed(1)}R${demote ? ` (below ${d.maxPfR})` : ''}` };
}

/**
 * Share of a shadow pair's entries that a live pair on the same market also took, same side, within
 * `windowMs`. A candidate that mostly re-enters what the fleet already holds adds risk, not edge.
 */
export function overlapPct(shadow: TradeR[], live: TradeR[], windowMs = 15 * 60_000): number {
  if (!shadow.length) return 0;
  const hit = shadow.filter(s => live.some(l => l.side === s.side && Math.abs(l.entryAt - s.entryAt) <= windowMs)).length;
  return hit / shadow.length * 100;
}

/** Order screen candidates for the shadow slots: evidence per unit of luck, roughly a t-statistic. */
export function screenScore(c: { trades: number; profitFactor: number; windowsUp: number }): number {
  return (Math.min(c.profitFactor, 5) - 1) * Math.sqrt(c.trades) * (c.windowsUp / 8);
}

/** Which of `slices` daily slices a script belongs to: stable across runs, spread evenly. */
export function sliceOf(id: string, slices: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % slices;
}

export function fmtPf(pf: number | null): string { return pf === null ? '∞' : pf.toFixed(2); }
