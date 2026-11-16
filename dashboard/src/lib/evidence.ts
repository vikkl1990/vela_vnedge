import type { PerformanceStats } from '../api/types'

/**
 * How much an average R per trade can be believed. Trades closed on the same day move together, so the standard error is
 * clustered by day (computed on the server) and the interval uses a t value for the number of days, not 1.96.
 *
 * thin       fewer than 30 trades or fewer than 5 closing days: too little to say anything
 * edge       the 95% interval is above zero
 * negative   the 95% interval is below zero
 * unproven   the interval spans zero: it may be a real edge, a real loss or nothing
 */
export type EvidenceVerdict = 'thin' | 'edge' | 'negative' | 'unproven'

export const MIN_TRADES = 30
export const MIN_DAYS = 5

// two-sided 95% t values for 1..30 degrees of freedom
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
]
export const tCritical = (df: number): number => (df < 1 ? Infinity : df > 30 ? 1.96 : T95[df - 1])

export interface Evidence {
  verdict: EvidenceVerdict
  avgR: number | null
  lo: number | null
  hi: number | null
  trades: number
  days: number
}

export function evidenceOf(
  s: Pick<PerformanceStats, 'avgR' | 'rTrades'> & { seR?: number | null; rDays?: number },
): Evidence {
  const trades = s.rTrades,
    days = s.rDays ?? 0
  const base = { avgR: s.avgR, trades, days }
  if (s.avgR === null || s.seR == null || !Number.isFinite(s.seR))
    return { verdict: 'thin', lo: null, hi: null, ...base }
  const half = tCritical(days - 1) * s.seR
  const lo = s.avgR - half,
    hi = s.avgR + half
  if (trades < MIN_TRADES || days < MIN_DAYS) return { verdict: 'thin', lo, hi, ...base }
  return { verdict: lo > 0 ? 'edge' : hi < 0 ? 'negative' : 'unproven', lo, hi, ...base }
}

export const VERDICT_LABEL: Record<EvidenceVerdict, string> = {
  thin: 'too few',
  edge: 'edge',
  negative: 'losing',
  unproven: 'not proven',
}

const r2 = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`

/** The sentence behind a badge: the average, the interval and what it rests on. */
export function evidenceDetail(e: Evidence): string {
  const n = `${e.trades} trades on ${e.days} closing day${e.days === 1 ? '' : 's'}`
  if (e.avgR === null) return 'No trades with a recorded risk.'
  if (e.lo === null || e.hi === null)
    return `${r2(e.avgR)} per trade from ${n}: too few closing days to put an interval on it.`
  const range = `95% interval ${r2(e.lo)} to ${r2(e.hi)}`
  const why =
    e.verdict === 'thin'
      ? `Too few to judge (needs ${MIN_TRADES} trades on ${MIN_DAYS} days).`
      : e.verdict === 'edge'
        ? 'The interval is above zero.'
        : e.verdict === 'negative'
          ? 'The interval is below zero.'
          : 'The interval includes zero: it could be an edge, a loss or nothing.'
  return `${r2(e.avgR)} per trade from ${n}; ${range}, trades clustered by day. ${why}`
}
