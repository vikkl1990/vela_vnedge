/**
 * Types mirroring docs/API.md (VNEdge server contract).
 * Time values are epoch milliseconds unless the field name ends in `Sec`.
 */

export type Side = 'long' | 'short'
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '1d'
export type ScannerStatus = 'ok' | 'incompatible' | 'unavailable'
export type ExitMode = 'levels' | 'script' | 'both'
export type SignalKind = 'entry' | 'exit' | 'info'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogScope = 'feed' | 'scanner' | 'paper' | 'api' | string

// ---------- Health / config ----------

export interface Health {
  status: string
  uptimeSec: number
  mode: 'paper' | string
  now: number
  feed: { connected: boolean; lastTickAt: number | null; subscriptions: string[] }
  scanners: { total: number; runnable: number; enabled: number }
  worker: { size: number; queued: number; busy: number }
  lastError: string | null
}

export interface PaperConfig {
  initialEquity: number
  riskPerTradePct: number
  maxLeverage: number
  sizingMode: 'risk' | 'quality'
  minLeverage: number
  liquidation: boolean
  maintenanceMarginPct: number
  feeRatePct: number
  slippageBps: number
  tpSplit: [number, number, number]
  breakEvenAfterTp1: boolean
  allowReversal: boolean
  fallbackAtrSl: number
  fallbackRR: [number, number, number]
  maxOpenPositions: number
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
  timeframes: string[]
  historyBars: number
  paper: PaperConfig
  execution: { mode: 'paper' | string }
  scanners: Record<string, ScannerConfig>
}

export type ConfigPatch = Partial<Omit<Config, 'paper' | 'scanners'>> & {
  paper?: Partial<PaperConfig>
  scanners?: Record<string, Partial<ScannerConfig>>
}

// ---------- Markets & candles ----------

export interface Market {
  symbol: string
  description: string
  tickSize: number
  contractValue: number
  markPrice: number
  change24hPct: number
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Ticker {
  symbol: string
  price: number
  markPrice: number
  time: number
}

// ---------- Scanners ----------

export interface BacktestSummary {
  trades: number
  winRatePct: number
  pnl: number
  profitFactor: number
}

export interface ScannerStats {
  signals: number
  trades: number
  open: number
  wins: number
  losses: number
  winRatePct: number
  pnl: number
  pnlPct: number
  avgR: number
  profitFactor: number
  maxDrawdownPct: number
  backtest?: BacktestSummary | null
}

export interface LastRun {
  at: number
  ms: number
  symbol: string
  tf: string
  error: string | null
}

export interface Scanner {
  id: string
  name: string
  author?: string
  file: string
  url: string
  status: ScannerStatus
  reason: string | null
  enabled: boolean
  hidden?: boolean
  overlay: boolean
  pineVersion: string
  lines: number
  symbols: string[]
  timeframes: string[]
  exitMode: ExitMode
  lastRun: LastRun | null
  stats: ScannerStats
}

export interface ScannerUpdate {
  enabled?: boolean
  hidden?: boolean
  symbols?: string[]
  timeframes?: string[]
  exitMode?: ExitMode
}

export interface ScannerSource {
  id: string
  source: string
  patched: string
  patches: string[]
}

export interface OverlayPlotPoint {
  time: number
  value: number
  color?: string
}
export interface OverlayPlot {
  title: string
  style: string
  overlay: boolean
  data: OverlayPlotPoint[]
}
export interface OverlayShape {
  title: string
  time: number
  shape: string
  location: string
  color?: string
}
export interface OverlayLabel {
  time: number
  y: number
  text: string
  color?: string
}
export interface ScannerOverlay {
  at: number
  plots: OverlayPlot[]
  shapes: OverlayShape[]
  labels: OverlayLabel[]
}

// ---------- Signals, positions, trades ----------

export interface Signal {
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

export interface Position {
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
  breakEven: boolean
  markPrice: number
  unrealizedPnl: number
  realizedPnl: number
  fees: number
  riskAmount: number
  rMultiple: number
}

export interface Fill {
  at: number
  price: number
  qty: number
  reason: string
}

export type ExitReason = 'tp3' | 'sl' | 'be' | 'script_exit' | 'reversal' | 'manual' | 'tp_partial' | string

export interface Trade {
  id: number
  positionId: number
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
  rMultiple: number
  exitReason: ExitReason
  fills: Fill[]
}

export interface Order {
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
  realizedPnl: number
  unrealizedPnl: number
  fees: number
  openPositions: number
  trades: number
  wins: number
  losses: number
  winRatePct: number
  profitFactor: number
  maxDrawdownPct: number
  todayPnl: number
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

// ---------- SSE ----------

export interface TickEvent {
  symbol: string
  price: number
  time: number
}
export interface CandleEvent {
  symbol: string
  tf: string
  bar: Candle
  closed: boolean
}
export interface PositionEvent {
  type: 'opened' | 'updated' | 'closed'
  position: Position
}
export interface ScannerEvent {
  id: string
  lastRun: LastRun | null
  stats: ScannerStats
}
export interface HelloEvent {
  now: number
  health: Health
}

export interface SSEEventMap {
  hello: HelloEvent
  tick: TickEvent
  candle: CandleEvent
  signal: Signal
  position: PositionEvent
  trade: Trade
  order: Order
  scanner: ScannerEvent
  stats: Stats
  health: Health
  log: LogEntry
}
export type SSEEventName = keyof SSEEventMap

// ---------- Query params ----------

export interface SignalQuery {
  limit?: number
  scanner?: string
  symbol?: string
  kind?: SignalKind
  since?: number
}
export interface TradeQuery {
  limit?: number
  scanner?: string
  symbol?: string
}
export interface CandleQuery {
  symbol: string
  tf: string
  limit?: number
  from?: number
  to?: number
}

// ---- machine learning ----
export interface MlRule { feature: string; label: string; kind: 'prefer' | 'avoid'; condition: string; n: number; coverage: number; winRate: number; avgR: number; baselineAvgR: number; lift: number; text: string }
export interface MlMetrics { holdout: number; accuracy: number; auc: number; logLoss: number; baseWinRate: number }
export interface MlImportance { feature: string; label: string; weight: number }
export interface MlScannerInsight { scannerId: string; scannerName: string; samples: number; liveSamples: number; baseline: { n: number; winRate: number; avgR: number }; model: MlMetrics | null; importance: MlImportance[]; rules: MlRule[] }
export interface MlSnapshot {
  trainedAt: number | null; samples: number; liveSamples: number; scannersWithModel: number
  global: { model: MlMetrics | null; importance: MlImportance[]; rules: MlRule[]; baseline: { n: number; winRate: number; avgR: number } } | null
  scanners: MlScannerInsight[]
  counts?: { total: number; live: number }
  config?: { minProb: number; useAsScore: boolean }
}
