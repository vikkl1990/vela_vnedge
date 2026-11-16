// ---- market context (decision 101) ----
export interface MarketContext {
  symbol: string
  coin: string
  delta: {
    oiUsd: number | null
    oiChange6hUsd: number | null
    fundingPct: number | null
    change24hPct: number | null
    turnoverUsd: number | null
  }
  hl: {
    oi: number | null
    oiUsd: number | null
    fundingHourly: number | null
    premium: number | null
    markPx: number | null
    dayVolumeUsd: number | null
  } | null
  smart: {
    longUsd: number
    shortUsd: number
    netUsd: number
    longs: number
    shorts: number
    wallets: number
  } | null
  binance: {
    topTraderLongShort: number | null
    globalLongShort: number | null
    takerBuySell: number | null
    oiUsd: number | null
  } | null
}
export interface GlobalContext {
  at: number
  session: string
  bias: { BTC: { h4: number; d1: number }; ETH: { h4: number; d1: number } }
  fundingSkewPct: number | null
  cohort: { wallets: number; refreshedAt: number | null }
  sources: Record<'delta' | 'hyperliquid' | 'binance', 'ok' | 'failed' | 'skipped'>
}
export interface ContextView {
  global: GlobalContext | null
  markets: MarketContext[]
}

// ---- gate center ----
export type GateState = 'open' | 'armed' | 'blocking' | 'off' | 'attention'
export interface Gate {
  key: string
  group: string
  name: string
  state: GateState
  value: string
  rule: string
  next: string
  href?: string
}
export interface GatesView {
  at: number
  gates: Gate[]
  summary: { blocking: number; attention: number }
}

// ---- incubator ----
export type IncubatorStage = 'candidate' | 'shadow' | 'proposed' | 'live' | 'demote_proposed' | 'retired'
export interface IncubatorStats {
  trades: number
  days: number
  wins: number
  winRatePct: number
  netR: number
  avgR: number
  pfR: number | null
  weeks: number
  positiveWeeks: number
  positiveWeeksPct: number
  /** Decision 186: the payoff shape. */
  tStat?: number
  avgWinR?: number
  avgLossR?: number
  reached1RPct?: number
  /** Cohort pooling (decision 89): how many markets the cohort runs on, how many are judged, how many are positive. */
  markets?: number
  marketsJudged?: number
  positiveMarkets?: number
  positiveMarketsPct?: number
  perMarket?: Array<{ symbol: string; trades: number; netR: number; avgR: number }>
}
export interface IncubatorScreen {
  pass: boolean
  at: number
  trades: number
  profitFactor: number
  netPnl: number
  netAtStress: number
  windowsUp: number
  winRatePct: number
  avgR: number
  bars: number
  days: number
  /** Decision 201: what the screen measured; absent on screens from before it (legacy). */
  provenance?: { source: string | null; reading: string; sim: number; policy: string }
}
/** Decision 201: each account cell's runs, failures and skips over a window. */
export interface RunHealthRow {
  scannerId: string
  symbol: string
  tf: string
  ok: number
  failed: number
  skipped: number
  lastFailAt: number | null
  lastError: string | null
}
export interface RestorationView {
  state: 'evaluating' | 'passed' | 'policy-changed' | 'invalid'
  passed: boolean
  reasons: string[]
  startedAt?: number
  at?: number
  requirements?: {
    minTrades: number
    minDays: number
    minPfR: number
    minAvgR: number
    minT: number
    stressBps: number
  }
  seed?: { exact: number; compatible: number; netR: number }
  stats?: IncubatorStats
  halves?: number[]
  stressedR?: number | null
  invalidFills?: number
}
export interface IncubatorPair {
  paperCopy?: { eligible: boolean; reason: string | null } | null
  restoration?: RestorationView | null
  collection?: {
    status: string
    active: boolean
    lastSuccessBar: number | null
    nextCloseAt: number
    scan: {
      bar_time: number
      at: number
      status: string
      reason: string | null
      last_success_bar: number | null
      last_success_at: number | null
      entry_signals: number
    } | null
    entries: { filled: number; open: number; pending: number }
    funnel: NonNullable<IncubatorPair['funnel']>
  } | null
  rotationUntil?: number | null
  admissionEvidence?: {
    score: number
    qualityScore: number
    estimatedDays: number | null
    factor: number
    requiredTrades: number
    horizonDays: number
  } | null
  /** The market gate's verdict on this pair's market today; null when the gate has not judged it. */
  market?: { allowed: boolean; reasons: string[] } | null
  id: number
  scannerId: string
  scannerName: string
  symbol: string
  tf: string
  stage: IncubatorStage
  proposedAt?: number | null
  since: number
  updated: number
  note: string | null
  screen: IncubatorScreen | null
  gate: {
    at: number
    decision: string
    reasons: string[]
    overlapPct?: number
    stats?: IncubatorStats
    marketOutDays?: number
    cohort?: string
    market?: { symbol: string; trades: number; netR: number; avgR: number } | null
    strategyComparison?: { preferred: 'script' | 'both'; reason: string }
  } | null
  stats: IncubatorStats | null
  openShadow: number
  /** Decision 112: what became of the cell's entry signals in the last 14 days — opened, or which gate refused them. */
  funnel?: {
    historyCapped?: boolean
    retainedSince?: number | null
    reasons?: Record<string, number>
    entries: number
    opened: number
    pending?: number
    regime: number
    cost: number
    market: number
    quote: number
    other: number
    lastOpenAt: number | null
  } | null
  /** When the cell's last trade in its book was entered. */
  lastTradeAt?: number | null
  accountHolding?: boolean
}
export interface IncubatorEvent {
  id: number
  at: number
  pairId: number
  scannerId: string
  symbol: string
  tf: string
  from: IncubatorStage | null
  to: IncubatorStage
  actor: string
  evidence: unknown
}
/** Decision 157: why the candidates that passed their screen are not in the shadow book, right now. */
export interface CandidateBlockers {
  passed: number
  free: number
  counts: {
    cooldown?: number
    unavailable?: number
    expired: number
    stale: number
    outside: number
    refused: number
    rescreen: number
    capped: number
    noSlot: number
    cohort: number
    admissible: number
  }
}
export interface IncubatorView {
  paperCopy?: { enabled: boolean; eligible: number; at: number }
  capacity?: {
    total: number
    used: number
    free: number
    overflow: number
    general: { slots: number; used: number; free: number }
    reserves: Array<{ slots: number; used: number; free: number; tfs?: string[]; markets?: string[] }>
  }
  rotation?: {
    enabled: boolean
    maxPerDay: number
    usedToday: number
    last: Array<{ at: number; out: number; in: number }>
  }
  candidates?: CandidateBlockers
  lastAdmit?: { at: number; actor: string; admitted: string[] } | null
  enabled: boolean
  config: {
    tf: string
    universeTop: number
    maxShadow: number
    cooldownDays: number
    screen: {
      minTrades: number
      minProfitFactor: number
      minWindowsUp: number
      stressBps: number
      slices: number
    }
    gate: {
      minTrades: number
      minDays: number
      minPfR: number
      minPositiveWeeksPct: number
      minAvgR: number
      maxOverlapPct: number
      maxDays: number
      failPfR: number
      /** Decision 196: how the gate judges (cohort of markets, or each pair), and its per-timeframe minimums. */
      pool?: 'cohort' | 'pair'
      minTradesByTf?: Record<string, number>
      minDaysByTf?: Record<string, number>
      maxDaysByTf?: Record<string, number>
    }
    promote: {
      maxPerWeek: number
      maxFleet: number
      countLimitsEnabled?: boolean
      auto?: boolean
      reviewMinutes?: number
    }
    demote: {
      window: number
      minTrades: number
      maxPfR: number
      silentDays?: number
      silentDaysByTf?: Record<string, number>
      marketOutDays?: number
      costStarvedRefusals?: number
      costStarvedDays?: number
    }
  }
  counts: Partial<Record<IncubatorStage, number>>
  fleet: number
  promotionsThisWeek: number
  lastRun: {
    at: number
    slice: string
    scripts: number
    symbols: number
    runs: number
    passed: number
    new: number
    ms: number
    truncated?: number
    report?: { admitted: string[]; proposed: string[]; retired: string[]; demoteProposed: string[] }
  } | null
  /** When the daily job last announced itself; newer than lastRun.at means that run never finished. */
  lastStart?: { at: number; slice: string } | null
  automation?: {
    attemptAt: number
    successAt: number
    evidenceAt: number
    screenAt: number
    actor: string | null
    error: string | null
    enabled: boolean
    paper: boolean
    running: boolean
    intervalMinutes: number
    evidenceMinutes: number
    nextAt: number
  }
  /** Last evidence review, including automatic promotion results and blockers. */
  lastHunt?: {
    at: number
    actor: string
    screen: {
      at: number
      slice: string
      runs: number
      passed: number
      newCandidates: number
      quarantined: number
      minutes: number
    } | null
    admitted: string[]
    proposed: string[]
    promoted: string[]
    blocked: string[]
    retired: string[]
    demoteProposed: string[]
    brewing: number
    free: number
    auto: boolean
  } | null
  runner: {
    startedAt?: number
    runs: number
    skipped: number
    errors: number
    entries: number
    lastBarAt: number
    active: number
  }
  pairs: IncubatorPair[]
  events: IncubatorEvent[]
}

// ---- risk and exchange state ----
export interface RiskPeriod {
  start: number
  startEquity: number
  pnl: number
  pnlPct: number
  limitPct: number
  tripped: boolean
  trippedAt: number | null
}
export interface RiskState {
  at: number
  enabled: boolean
  halted: boolean
  haltReason: string | null
  manualHalt: { reason: string; at: number } | null
  equity: number
  peakEquity: number
  drawdownPct: number
  leverageMult: number
  /** Decision 188: what the size rule reads — the loss below the starting capital, or the drawdown from the peak. */
  sizing?: { from: 'capital' | 'peak'; drawdownPct: number; startEquity: number }
  day: RiskPeriod
  week: RiskPeriod
  [k: string]: unknown
}
export interface BracketOrder {
  id: number | string
  price: number
  size: number
  leg?: number
}
export interface LedgerRow {
  sourceOrderId?: number | null
  id: number
  positionId: number
  purpose: string
  reason: string | null
  leg: number | null
  clientOrderId: string
  productId: number
  symbol: string
  side: 'buy' | 'sell'
  size: number
  orderType: string
  stopPrice: number | null
  limitPrice: number | null
  state: 'intent' | 'submitted' | 'acknowledged' | 'filled' | 'cancelled' | 'rejected' | 'unknown'
  exchangeId: string | null
  filledSize: number
  avgPrice: number | null
  fee: number | null
  error: string | null
  createdAt: number
  updatedAt: number
}
export interface RecoveryReport {
  at: number
  settled: number
  restored: number
  replacedStops: number
  adoptedFills: number
  cancelledStray: number
  unmirrored: number[]
  notes: string[]
}
export interface ExecutionHandoff {
  scope: string
  pending: number
  blocked: number
  delivered: number
  cancelled: number
  oldest: number | null
  recent: Array<{
    id: number
    sourceOrderId: number
    positionId: number
    symbol: string
    side: string
    qty: number
    reason: string
    state: 'pending' | 'dispatching' | 'delivered' | 'cancelled' | 'blocked'
    createdAt: number
    updatedAt: number
    note: string | null
  }>
}
export interface ExecutionStatus {
  mode: string
  host: string | null
  hasKeys: boolean
  dryRun: boolean
  bracket: boolean
  brackets: Array<{
    positionId: number
    symbol: string
    stop: (BracketOrder & { exchangeId?: string }) | null
    tps: Array<BracketOrder & { exchangeId?: string }>
  }>
  lastReconcile: {
    at: number
    ok: boolean
    drift: Array<
      { kind?: string; symbol?: string; detail?: string; paper?: unknown; exchange?: unknown } | string
    >
    positions: number
    orders: number
    error?: string
  } | null
  unconfirmed?: number[]
  /** Positions the book has closed while the exchange still holds contracts; their protection stays until the sweep closes them. */
  stranded?: Array<{ positionId: number; symbol: string; qty: number; since: number; attempts: number }>
  exposure?: Record<string, number>
  lastRecovery?: RecoveryReport | null
  ledger?: LedgerRow[]
  outbox?: ExecutionHandoff
  accounting?: {
    total: number
    incomplete: number
    rows: Array<{
      sourceOrderId: number
      positionId: number
      symbol: string
      reason: string
      expectedQty: number
      confirmedQty: number
      state: string
      price: number | null
      fee: number | null
      updatedAt: number
    }>
  }
  products?: number
}
