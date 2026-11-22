import type { LogLevel, LogScope, Side, SignalKind } from './common.ts'
import type { ScannerStats } from './scanner.ts'

// ---------- Signals, positions, trades ----------

export interface Signal {
  /** True when price/SL/TP came from the resulting position because the script sent none. */
  derived?: boolean
  id: number
  at: number
  barTime: number
  scannerId: string
  scannerName: string
  symbol: string
  tf: string
  kind: SignalKind
  side: Side | null
  price: number
  sl: number | null
  tp: (number | null)[]
  score: number | null
  label: string
  message: string
  /** Plain-English description of the signal. */
  summary?: string
  mlProb?: number | null
  source: string
  levelsSource: string
  action: string
  positionId: number | null
}

export interface Protection {
  floorAtR: number
  floorKeepR: number
  trailAfterR: number
  keepPct: number
  trailAtrMult: number
  trailDistanceR: number
  trailGiveBackPct: number
  trailSteps: [number, number][]
  trailStall: { minutes: number; factor: number } | null
  peakR: number
}
export interface PaperExecution {
  version: number
  marketQty: number
  desiredStop: number | null
  ackAt: number | null
  pending: {
    status: string
    reason: string
    last_error: string | null
    trigger_at: number
    ready_at: number
    qty: number
    filled_qty: number
  } | null
}
export interface Position {
  fleetSource?: import('../paperFleet.ts').FleetSource | null
  entrySizeScale?: number | null
  execution?: PaperExecution
  protection?: Protection | null
  funding?: number
  grossTradingPnl?: number
  id: number
  scannerId: string
  scannerName: string
  symbol: string
  tf: string
  side: Side
  qty: number
  qtyOpen: number
  contractValue: number
  marginLeverage?: number
  /** The market's maintenance margin the liquidation was modelled on (percent); null before decision 94. */
  maintenanceMarginPct?: number | null
  leverage?: number
  liqPrice?: number | null
  notional?: number
  notionalEntry?: number
  margin?: number | null
  entryPrice: number
  entryAt: number
  sl: number | null
  slOriginal: number | null
  tp: (number | null)[]
  tpHit: boolean[]
  /** Contracts allocated to each target. A zero leg never fills; the split is configurable. */
  legs?: number[]
  /** Best favourable excursion so far, in R; the trail arms once it passes paper.trailAfterR. */
  peakR?: number | null
  breakEven: boolean
  markPrice: number
  unrealizedPnl: number
  realizedPnl: number
  fees: number
  riskAmount: number
  rMultiple: number | null
  /** Delta's own mark price (what an exchange liquidates against), when known. */
  exchangeMark?: number | null
}

export interface Fill {
  at: number
  price: number
  qty: number
  reason: string
}

export type ExitReason =
  'tp3' | 'sl' | 'be' | 'trail' | 'script_exit' | 'reversal' | 'manual' | 'tp_partial' | string

export interface Trade {
  accountingPending?: boolean
  funding?: number
  grossTradingPnl?: number
  id: number
  positionId: number
  /** Fingerprint of the settings that produced the trade (decision 90). */
  configFp?: string | null
  scannerId: string
  scannerName: string
  symbol: string
  tf: string
  side: Side
  qty: number
  entryPrice: number
  exitPrice: number
  entryAt: number
  exitAt: number
  pnl: number
  pnlPct: number
  fees: number
  rMultiple: number | null
  exitReason: ExitReason
  fills: Fill[]
}

export interface Order {
  accountingState?: string | null
  confirmedQty?: number | null
  expectedQty?: number | null
  pnl?: number | null
  /** Where the fill price came from: 'exchange' (restated from the exchange's fill), 'quote' (crossed the live spread), 'slippage' (modelled), or null. */
  priceSource?:
    | 'exchange'
    | 'quote'
    | 'depth'
    | 'slippage'
    | 'candle-model'
    | 'tape-limit-model'
    | 'limit-candle-model'
    | 'limit-tape-model'
    | 'limit-tick-depth-model'
    | null
  liquidity?: 'maker' | 'taker' | null
  id: number
  at: number
  positionId: number
  scannerId: string
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  fee: number
  reason: string
}

export interface Stats {
  equity: number
  initialEquity: number
  /** Net of closed trades: the same number the Trades page sums. */
  closedPnl: number
  closedFees: number
  /** Open positions: banked legs, fees and mark. equity = initial + closedPnl + openPnl. */
  openPnl: number
  openFees: number
  peakEquity: number
  drawdownPct: number
  openPositions: number
  trades: number
  wins: number
  losses: number
  winRatePct: number
  profitFactor: number
  maxDrawdownPct: number
  byScanner: Record<string, ScannerStats>
  bySymbol: Record<string, { trades: number; pnl: number }>
}

export interface EquityPoint {
  at: number
  equity: number
  realized: number
  unrealized: number
}

export interface BacktestResult {
  at: number
  bars: number
  trades: Trade[]
  stats: Partial<ScannerStats> & Record<string, unknown>
  equity: { at: number; equity: number }[]
}

export interface LogEntry {
  at: number
  level: LogLevel
  scope: LogScope
  msg: string
  data?: unknown
}
