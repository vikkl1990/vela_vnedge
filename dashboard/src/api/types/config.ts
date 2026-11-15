import type { ExitMode } from './common.ts'

// ---------- Health / config ----------

export interface Health {
  status: string
  uptimeSec: number
  mode: 'paper' | string
  now: number
  feed: { connected: boolean; lastTickAt: number | null; subscriptions: string[] }
  scanners: { total: number; runnable: number; enabled: number }
  /** Faults the operator must act on first; empty is the normal state. */
  attention?: Array<{ key: string; text: string; href: string }>
  worker: { size: number; queued: number; busy: number }
  lastError: string | null
  signalRecovery?: {
    pending: number
    oldest: number | null
    failed: number
    recent: Array<{
      signal_id: number
      kind: string
      received_at: number
      attempts: number
      last_error: string | null
      scanner_id: string
      symbol: string
      tf: string
    }>
  }
}

export interface PaperConfig {
  fundingGuard?: {
    enabled: boolean
    leadMinutes: number
    maxAgeSec: number
    scalpMaxR: number
    swingMaxR: number
  }
  marginPerTrade?: number
  maxStopLossPct: number
  initialEquity: number
  riskPerTradePct: number
  maxLeverage: number
  sizingMode: 'risk' | 'quality' | 'margin'
  minLeverage: number
  liquidation: boolean
  maintenanceMarginPct: number
  minRiskFeeRatio?: number
  feeRatePct: number
  slippageBps: number
  tpSplit: [number, number, number]
  breakEvenAfterTp1: boolean
  allowReversal: boolean
  fallbackAtrSl: number
  fallbackRR: [number, number, number]
  maxOpenPositions: number
  requireQuote?: boolean
  makerFeeRatePct?: number
  feeTaxPct?: number
  trailAfterR?: number
  trailGiveBackPct?: number
  floorAtR?: number
  floorKeepR?: number
  scriptDisasterStopAtr?: number
}
/** The risk layer, as far as the Settings page edits it (decision 119). */
export interface RiskConfig {
  enabled: boolean
  maxDailyLossPct: number
  maxWeeklyLossPct: number
  maxPositionsTotal: number
  maxPositionsPerSymbol: number
  perScannerMaxPositions: number
  reentryCooldownMinutes?: number
  burstWindowSec?: number
  regime?: { enabled: boolean; minAtrPct: number; noWeekend: boolean; minEr?: number; exempt?: string[] }
  marketGate?: {
    enabled: boolean
    minTurnoverUsd: number
    maxBookCostPct?: number
    probeNotionalUsd?: number
    [k: string]: unknown
  }
  [k: string]: unknown
}
export interface IncubatorConfig {
  enabled: boolean
  tfs?: string[]
  maxShadow: number
  promote: {
    maxPerWeek: number
    maxFleet: number
    countLimitsEnabled?: boolean
    maxPerMarket?: number
    maxPerScanner?: number
    [k: string]: unknown
  }
  gate: {
    minTrades: number
    minDays: number
    minPfR: number
    minAvgR: number
    minPositiveWeeksPct: number
    minWeeks?: number
    staleDays?: number
    [k: string]: unknown
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
  mirror?: { enabled: boolean }
  [k: string]: unknown
}

export interface ScannerConfig {
  enabled: boolean
  symbols: string[] | null
  timeframes: string[] | null
  exitMode: ExitMode
}

export interface Config {
  symbols: string[]
  universe?: { mode: 'list' | 'top' | 'all'; top: number; exclude: string[] }
  resolvedSymbols?: string[]
  ml?: { minProb: number; useAsScore: boolean }
  autoTune?: { enabled: boolean; minTrades: number; minProfitFactor: number; intervalHours: number }
  timeframes: string[]
  historyBars: number
  paper: PaperConfig
  risk?: RiskConfig
  incubator?: IncubatorConfig
  execution: { mode: 'paper' | string }
  scanners: Record<string, ScannerConfig>
}

export type ConfigPatch = Partial<Omit<Config, 'paper' | 'scanners' | 'risk' | 'incubator'>> & {
  paper?: Partial<PaperConfig>
  risk?: Partial<RiskConfig> & {
    regime?: Partial<NonNullable<RiskConfig['regime']>>
    marketGate?: Partial<NonNullable<RiskConfig['marketGate']>>
  }
  incubator?: Partial<IncubatorConfig> & {
    promote?: Partial<IncubatorConfig['promote']>
    gate?: Partial<IncubatorConfig['gate']>
    demote?: Partial<IncubatorConfig['demote']>
  }
  scanners?: Record<string, Partial<ScannerConfig>>
}
