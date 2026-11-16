// ---- analytics ----
export interface Agg {
  trades: number
  wins: number
  winRatePct: number
  pnl: number
  fees: number
  profitFactor: number | null
}
export interface EdgeRow {
  key: string
  label: string
  n: number
  avgR: number
  lb90: number | null
  ub90: number | null
  winRatePct: number
  sumR: number
  costShare: number | null
  verdict: 'paying' | 'undecided' | 'failing'
}
export interface LearnExit {
  reason: string
  n: number
  avgR: number
  medianPeakR: number | null
  giveBackR: number | null
  sumR: number
}
export interface LearnBucket {
  label: string
  n: number
  avgR: number
  sumR: number
}
export interface BookLearning {
  trades: number
  sumR: number
  avgR: number
  lb90: number | null
  ub90: number | null
  winRatePct: number
  avgWinR: number | null
  avgLossR: number | null
  breakevenWinPct: number | null
  costShare: number | null
  grossUsd: number
  feesUsd: number
  netUsd: number
  stops: { n: number; neverMoved: number; firstBar: number; medianMinutes: number | null }
  exits: LearnExit[]
  byScanner: EdgeRow[]
  byPair: EdgeRow[]
  byTf: EdgeRow[]
  curve: Array<{ i: number; t: number; cumR: number; ddR: number }>
  daily: Array<{ day: string; n: number; sumR: number }>
  holds: LearnBucket[]
  hoursIst: LearnBucket[]
  /** Decision 108: R by the regime at entry and by session. */
  regimes: LearnBucket[]
  sessions: LearnBucket[]
  windowDays?: number
}
export interface GoLiveCheck {
  key: string
  label: string
  ok: boolean
  value: string
  need: string
}
export interface GoLiveVerdict {
  ok: boolean
  checks: GoLiveCheck[]
  advisories?: Array<{ key: string; label: string; value: string; note: string }>
  sim: {
    paths: number
    days: number
    breachPct: number
    dailyBreachPct: number
    maxLossBreachPct: number
    dd50Pct: number
    dd95Pct: number
    medianEndPct: number
  } | null
}
export interface Learning {
  at: number
  live: BookLearning
  shadow: BookLearning
  /** Exact account policies plus readiness-compatible expansions of global count ceilings (decision 272). */
  current?: BookLearning
  funnel: {
    stages: Record<string, number>
    lastHunt: { at?: number; [k: string]: unknown } | null
    shadowAgeDays: { median: number | null; over30: number }
    gate: Record<string, unknown>
  }
  golive?: GoLiveVerdict
}
/** Account exits by reason and the totals, in dollars (decision 108): the journal gives everything else in R. */
export interface Analytics {
  at: number
  exits: Array<Agg & { reason: string }>
  totals: { live: Agg }
}
