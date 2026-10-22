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
  /** Faults the operator must act on first; empty is the normal state. */
  attention?: Array<{ key: string; text: string; href: string }>
  worker: { size: number; queued: number; busy: number }
  lastError: string | null
}

export interface PaperConfig {
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
  marketGate?: { enabled: boolean; minTurnoverUsd: number; maxBookCostPct?: number; probeNotionalUsd?: number; [k: string]: unknown }
  [k: string]: unknown
}
export interface IncubatorConfig {
  enabled: boolean
  tfs?: string[]
  maxShadow: number
  promote: { maxPerWeek: number; maxFleet: number; maxPerMarket?: number; maxPerScanner?: number; [k: string]: unknown }
  gate: { minTrades: number; minDays: number; minPfR: number; minAvgR: number; minPositiveWeeksPct: number; minWeeks?: number; staleDays?: number; [k: string]: unknown }
  demote: { window: number; minTrades: number; maxPfR: number; silentDays?: number; marketOutDays?: number; costStarvedRefusals?: number; costStarvedDays?: number }
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
  risk?: Partial<RiskConfig> & { regime?: Partial<NonNullable<RiskConfig['regime']>>; marketGate?: Partial<NonNullable<RiskConfig['marketGate']>> }
  incubator?: Partial<IncubatorConfig> & { promote?: Partial<IncubatorConfig['promote']>; gate?: Partial<IncubatorConfig['gate']>; demote?: Partial<IncubatorConfig['demote']> }
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
  funnel?: RunFunnel
}
/** What one run produced and where it emptied (decision 77). */
export interface RunFunnel { raw: { alerts: number; conditions: number; shapes: number; labels: number; plots: number }; events: { entries: number; exits: number; info: number }; drops: Record<string, number>; actions: Record<string, number>; note?: string }

/** The `?view=lite` shape: enough to resolve a name, a status and visibility, nothing more. */
export interface ScannerIndexEntry {
  id: string
  name: string
  status: ScannerStatus
  category?: string
  enabled: boolean
  /** Scheduled right now: enabled, runnable and not quarantined. */
  active?: boolean
  hidden?: boolean
  overlay: boolean
  /** Error from the newest run of this scanner, or null; the full view carries the whole run record. */
  lastRunError: string | null
}

export interface Scanner {
  id: string
  name: string
  /** The last seven days of this scanner's entry signals by outcome (decision 87). */
  week?: { entries: number; opened: number; gate: number; fee: number; regime: number; guard: number; other: number } | null
  author?: string
  file: string
  url: string
  status: ScannerStatus
  reason: string | null
  enabled: boolean
  /** Scheduled right now: enabled, runnable and not quarantined. */
  active?: boolean
  hidden?: boolean
  overlay: boolean
  pineVersion: string
  lines: number
  symbols: string[]
  timeframes: string[]
  exitMode: ExitMode
  lastRun: LastRun | null
  stats: ScannerStats
  /** How the script is read (decision 48): entry channels, timezone, derivation rule, overrides. */
  reads?: { sources: EntrySource[] | null; timezone: string | null; rule: 'trailing' | 'oscillator' | null; inputs: Record<string, number | string | boolean> | null; exit: Record<string, unknown> | null; labels?: string[] | null; edge?: boolean | null; invert?: boolean }
  /** What it produced when last profiled: the author's plan, a direction, information, nothing. */
  kind?: ProfileKind | null
  profiledAt?: number | null
  health?: { fails: number; lastAt: number; lastError: string; reason: string | null; quarantined: boolean } | null
  /** Explicit (market, timeframe) pairs (decision 70); when set they replace symbols × timeframes. */
  pairs?: Array<{ symbol: string; tf: string }> | null
  /** Which books the scanner is in (decision 64): markets it trades in the account, markets it is proving in the shadow book, markets proposed for promotion. */
  books?: { account: string[]; shadow: string[]; proposed: string[] }
}

export type EntrySource = 'alert' | 'alertcondition' | 'shape' | 'derived'
export type ProfileKind = 'plan' | 'signal' | 'exits' | 'levels' | 'silent' | 'broken'
export interface ProfileRow {
  scannerId: string; market: string; tf: string; at: number; kind: ProfileKind; ms: number
  entries: number; withSl: number; withTp: number; exits: number; info: number
  alertEntries: number; alertconds: number; shapes: number; labels: number; labelTexts: string[]; plots: number; error: string | null
}

export interface ScannerUpdate {
  enabled?: boolean
  hidden?: boolean
  symbols?: string[]
  timeframes?: string[]
  exitMode?: ExitMode
  sources?: EntrySource[] | null
  timezone?: string | null
  rule?: 'trailing' | 'oscillator' | null
  labels?: string[] | null
  invert?: boolean
  pairs?: Array<{ symbol: string; tf: string }> | null
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
  rMultiple: number
  /** Delta's own mark price (what an exchange liquidates against), when known. */
  exchangeMark?: number | null
}

export interface Fill {
  at: number
  price: number
  qty: number
  reason: string
}

export type ExitReason = 'tp3' | 'sl' | 'be' | 'trail' | 'script_exit' | 'reversal' | 'manual' | 'tp_partial' | string

export interface Trade {
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
  rMultiple: number
  exitReason: ExitReason
  fills: Fill[]
}

export interface Order {
  /** Where the fill price came from: 'exchange' (restated from the exchange's fill), 'quote' (crossed the live spread), 'slippage' (modelled), or null. */
  priceSource?: 'exchange' | 'quote' | 'slippage' | null
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
  type: 'opened' | 'updated' | 'closed' | 'voided'
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
  trainedAt: number | null; samples: number; liveSamples: number; liveSinceReset: number; scannersWithModel: number
  global: { model: MlMetrics | null; importance: MlImportance[]; rules: MlRule[]; baseline: { n: number; winRate: number; avgR: number } } | null
  scanners: MlScannerInsight[]
  counts?: { total: number; live: number }
  config?: { minProb: number; useAsScore: boolean }
}
// ---- the gate's yardstick (decision 108) ----
export interface YardBucket { label: string; lo: number; hi: number; n: number; avgR: number; winRatePct: number; sumR: number }
export interface YardThreshold { minProb: number; kept: number; keptAvgR: number; keptSumR: number; dropped: number; droppedAvgR: number; droppedSumR: number; deltaSumR: number }
export interface YardBook {
  trades: number; scored: number; scoredAtEntry: number; unscored: number; allAvgR: number; allSumR: number; auc: number | null
  buckets: YardBucket[]; thresholds: YardThreshold[]; verdict: { pays: boolean; minProb: number | null; text: string }
}
export interface MlYardstick {
  at: number; windowDays: number; model: { trainedAt: number | null; holdoutAuc: number | null; samples: number }
  config: { minProb: number; useAsScore: boolean }; enriched: { cached: number; unscorable: number }
  live: YardBook; shadow: YardBook; call: { minProb: number | null; text: string }
}

// ---- analytics ----
export interface Agg { trades: number; wins: number; winRatePct: number; pnl: number; fees: number; profitFactor: number | null }
export interface EdgeRow { key: string; label: string; n: number; avgR: number; lb90: number | null; ub90: number | null; winRatePct: number; sumR: number; costShare: number | null; verdict: 'paying' | 'undecided' | 'failing' }
export interface LearnExit { reason: string; n: number; avgR: number; medianPeakR: number | null; giveBackR: number | null; sumR: number }
export interface LearnBucket { label: string; n: number; avgR: number; sumR: number }
export interface BookLearning {
  trades: number; sumR: number; avgR: number; lb90: number | null; ub90: number | null; winRatePct: number
  avgWinR: number | null; avgLossR: number | null; breakevenWinPct: number | null; costShare: number | null
  grossUsd: number; feesUsd: number; netUsd: number
  stops: { n: number; neverMoved: number; firstBar: number; medianMinutes: number | null }
  exits: LearnExit[]; byScanner: EdgeRow[]; byPair: EdgeRow[]; byTf: EdgeRow[]
  curve: Array<{ i: number; t: number; cumR: number; ddR: number }>
  daily: Array<{ day: string; n: number; sumR: number }>
  holds: LearnBucket[]; hoursIst: LearnBucket[]
  /** Decision 108: R by the regime at entry and by session. */
  regimes: LearnBucket[]; sessions: LearnBucket[]
  windowDays?: number
}
export interface GoLiveCheck { key: string; label: string; ok: boolean; value: string; need: string }
export interface GoLiveVerdict { ok: boolean; checks: GoLiveCheck[]; sim: { paths: number; days: number; breachPct: number; dailyBreachPct: number; maxLossBreachPct: number; dd50Pct: number; dd95Pct: number; medianEndPct: number } | null }
export interface Learning {
  at: number; live: BookLearning; shadow: BookLearning
  /** The account's trades made under the settings that are live now (decision 90). */
  current?: BookLearning
  funnel: { stages: Record<string, number>; lastHunt: { at?: number; [k: string]: unknown } | null; shadowAgeDays: { median: number | null; over30: number }; gate: Record<string, unknown> }
  golive?: GoLiveVerdict
}
/** Account exits by reason and the totals, in dollars (decision 108): the journal gives everything else in R. */
export interface Analytics {
  at: number
  exits: Array<Agg & { reason: string }>
  totals: { live: Agg }
}

// ---- authentication ----

/** `viewer` is backtest only, `trader` adds trading, `admin` adds user management. */
export type Role = 'admin' | 'trader' | 'viewer' | 'guest'
/** Decision 117: a read-only, expiring, revocable way into the dashboard for someone without an account. */
export interface ShareLink { id: number; label: string; userId: number; createdBy: number | null; createdAt: number; expiresAt: number; revokedAt: number | null; uses: number; lastUsedAt: number | null }
export type Permission = 'read' | 'backtest' | 'trade' | 'admin'
export interface RoleOption { role: Role; label: string }

export interface Me {
  id: number
  username: string
  displayName: string
  role: Role
  roleLabel: string
  createdAt: number
  lastLoginAt: number | null
  disabled: boolean
}

export interface Session {
  user: Me
  permissions: Permission[]
  sessions: number
}

export interface AuthStatus {
  /** False on a brand new instance: the first administrator has not been created yet. */
  configured: boolean
  /** Only true when the browser is on the server itself, which is where first-run setup is allowed. */
  canSetup: boolean
  roles: RoleOption[]
}

// ---- market context (decision 101) ----
export interface MarketContext {
  symbol: string; coin: string
  delta: { oiUsd: number | null; oiChange6hUsd: number | null; fundingPct: number | null; change24hPct: number | null; turnoverUsd: number | null }
  hl: { oi: number | null; oiUsd: number | null; fundingHourly: number | null; premium: number | null; markPx: number | null; dayVolumeUsd: number | null } | null
  smart: { longUsd: number; shortUsd: number; netUsd: number; longs: number; shorts: number; wallets: number } | null
  binance: { topTraderLongShort: number | null; globalLongShort: number | null; takerBuySell: number | null; oiUsd: number | null } | null
}
export interface GlobalContext {
  at: number; session: string
  bias: { BTC: { h4: number; d1: number }; ETH: { h4: number; d1: number } }
  fundingSkewPct: number | null
  cohort: { wallets: number; refreshedAt: number | null }
  sources: Record<'delta' | 'hyperliquid' | 'binance', 'ok' | 'failed' | 'skipped'>
}
export interface ContextView { global: GlobalContext | null; markets: MarketContext[] }

// ---- gate center ----
export type GateState = 'open' | 'armed' | 'blocking' | 'off' | 'attention'
export interface Gate { key: string; group: string; name: string; state: GateState; value: string; rule: string; next: string; href?: string }
export interface GatesView { at: number; gates: Gate[]; summary: { blocking: number; attention: number } }

// ---- incubator ----
export type IncubatorStage = 'candidate' | 'shadow' | 'proposed' | 'live' | 'demote_proposed' | 'retired'
export interface IncubatorStats {
  trades: number; days: number; wins: number; winRatePct: number; netR: number; avgR: number; pfR: number | null
  weeks: number; positiveWeeks: number; positiveWeeksPct: number
  /** Cohort pooling (decision 89): how many markets the cohort runs on, how many are judged, how many are positive. */
  markets?: number; marketsJudged?: number; positiveMarkets?: number; positiveMarketsPct?: number; perMarket?: Array<{ symbol: string; trades: number; netR: number; avgR: number }>
}
export interface IncubatorScreen {
  pass: boolean; at: number; trades: number; profitFactor: number; netPnl: number; netAtStress: number
  windowsUp: number; winRatePct: number; avgR: number; bars: number; days: number
}
export interface IncubatorPair {
  /** The market gate's verdict on this pair's market today; null when the gate has not judged it. */
  market?: { allowed: boolean; reasons: string[] } | null
  id: number; scannerId: string; scannerName: string; symbol: string; tf: string; stage: IncubatorStage
  since: number; updated: number; note: string | null; screen: IncubatorScreen | null
  gate: { at: number; decision: string; reasons: string[]; overlapPct?: number; stats?: IncubatorStats; marketOutDays?: number; cohort?: string; market?: { symbol: string; trades: number; netR: number; avgR: number } | null; strategyComparison?: { preferred: 'script' | 'both'; reason: string } } | null
  stats: IncubatorStats | null; openShadow: number
  /** Decision 112: what became of the cell's entry signals in the last 14 days — opened, or which gate refused them. */
  funnel?: { entries: number; opened: number; regime: number; cost: number; market: number; quote: number; other: number; lastOpenAt: number | null } | null
  /** When the cell's last trade in its book was entered. */
  lastTradeAt?: number | null
}
export interface IncubatorEvent { id: number; at: number; pairId: number; scannerId: string; symbol: string; tf: string; from: IncubatorStage | null; to: IncubatorStage; actor: string; evidence: unknown }
/** Decision 157: why the candidates that passed their screen are not in the shadow book, right now. */
export interface CandidateBlockers {
  passed: number; free: number
  counts: { expired: number; stale: number; outside: number; refused: number; rescreen: number; capped: number; noSlot: number; cohort: number; admissible: number }
}
export interface IncubatorView {
  candidates?: CandidateBlockers
  lastAdmit?: { at: number; actor: string; admitted: string[] } | null
  enabled: boolean
  config: {
    tf: string; universeTop: number; maxShadow: number; cooldownDays: number
    screen: { minTrades: number; minProfitFactor: number; minWindowsUp: number; stressBps: number; slices: number }
    gate: { minTrades: number; minDays: number; minPfR: number; minPositiveWeeksPct: number; minAvgR: number; maxOverlapPct: number; maxDays: number; failPfR: number }
    promote: { maxPerWeek: number; maxFleet: number }
    demote: { window: number; minTrades: number; maxPfR: number; silentDays?: number; marketOutDays?: number; costStarvedRefusals?: number; costStarvedDays?: number }
  }
  counts: Partial<Record<IncubatorStage, number>>
  fleet: number; promotionsThisWeek: number
  lastRun: { at: number; slice: string; scripts: number; symbols: number; runs: number; passed: number; new: number; ms: number; truncated?: number; report?: { admitted: string[]; proposed: string[]; retired: string[]; demoteProposed: string[] } } | null
  /** When the daily job last announced itself; newer than lastRun.at means that run never finished. */
  lastStart?: { at: number; slice: string } | null
  /** The last hunt: judge + auto-promotion + digest, run when the daily screen finished or on a click. */
  lastHunt?: { at: number; actor: string; screen: { at: number; slice: string; runs: number; passed: number; newCandidates: number; quarantined: number; minutes: number } | null; admitted: string[]; proposed: string[]; promoted: string[]; blocked: string[]; retired: string[]; demoteProposed: string[]; brewing: number; free: number; auto: boolean } | null
  runner: { runs: number; skipped: number; errors: number; entries: number; lastBarAt: number; active: number }
  pairs: IncubatorPair[]; events: IncubatorEvent[]
}


// ---- risk and exchange state ----
export interface RiskPeriod { start: number; startEquity: number; pnl: number; pnlPct: number; limitPct: number; tripped: boolean; trippedAt: number | null }
export interface RiskState {
  at: number; enabled: boolean; halted: boolean; haltReason: string | null
  manualHalt: { reason: string; at: number } | null
  equity: number; peakEquity: number; drawdownPct: number; leverageMult: number
  day: RiskPeriod; week: RiskPeriod
  [k: string]: unknown
}
export interface BracketOrder { id: number | string; price: number; size: number; leg?: number }
export interface LedgerRow {
  id: number; positionId: number; purpose: string; reason: string | null; leg: number | null; clientOrderId: string
  productId: number; symbol: string; side: 'buy' | 'sell'; size: number; orderType: string; stopPrice: number | null; limitPrice: number | null
  state: 'intent' | 'submitted' | 'acknowledged' | 'filled' | 'cancelled' | 'rejected' | 'unknown'; exchangeId: string | null
  filledSize: number; avgPrice: number | null; fee: number | null; error: string | null; createdAt: number; updatedAt: number
}
export interface RecoveryReport { at: number; settled: number; restored: number; replacedStops: number; adoptedFills: number; cancelledStray: number; unmirrored: number[]; notes: string[] }
export interface ExecutionStatus {
  mode: string; host: string | null; hasKeys: boolean; dryRun: boolean; bracket: boolean
  brackets: Array<{ positionId: number; symbol: string; stop: (BracketOrder & { exchangeId?: string }) | null; tps: Array<BracketOrder & { exchangeId?: string }> }>
  lastReconcile: { at: number; ok: boolean; drift: Array<{ kind?: string; symbol?: string; detail?: string; paper?: unknown; exchange?: unknown } | string>; positions: number; orders: number; error?: string } | null
  unconfirmed?: number[]
  /** Positions the book has closed while the exchange still holds contracts; their protection stays until the sweep closes them. */
  stranded?: Array<{ positionId: number; symbol: string; qty: number; since: number; attempts: number }>
  exposure?: Record<string, number>
  lastRecovery?: RecoveryReport | null
  ledger?: LedgerRow[]
  products?: number
}

/** The levels a path is read against: break even, the stop it opened with, and the targets. */
export interface PathLevels {
  /** decision 156: the trade's context, for the replay page */
  tf?: string
  scannerId?: string
  scannerName?: string
  book?: 'paper' | 'shadow' | 'backtest'
  status?: string
  levelsSource?: string | null
  realizedPnl?: number
  fees?: number
  riskAmount?: number
  id: number
  symbol: string
  side: 'long' | 'short'
  entryPrice: number
  entryAt: number
  slOriginal: number | null
  sl: number | null
  tp: number[]
  tpHit: number[]
  peakR: number | null
  peakAt: number | null
  worstR: number | null
  exitAt: number | null
  exitPrice: number | null
  exitReason: string | null
}

/** One sample or level event on a trade's path from entry to exit (decision 35). */
export interface PathPoint {
  at: number
  price: number
  r: number
  sl: number | null
  event: string | null
  note: string | null
}

export interface MarketVerdict { symbol: string; allowed: boolean; tracked?: boolean; reasons: string[]; atrPct: number | null; turnoverUsd: number | null; spreadPct?: number | null; bookCostPct?: number | null; trades: number; pf: number | null; netUsd: number }
export interface MarketsToday { at: number; enabled: boolean; markets: MarketVerdict[] }

/** One minute of the process (decision 80). */
export interface OpsMetricRow { at: number; rss: number; heap: number; rssPct: number; queued: number; busy: number; recycled: number; runsH: number; signalsH: number; feedUp: number; openPositions: number; closeLagS: number | null }

/** Decision 136: one UTC day of both books and the incubator. */
export interface BookDay {
  trades: number; net: number; fees: number; sumR: number; avgR: number; wins: number; stops: number; trails: number
  trailKeeps: number | null
  byTf: Record<string, { trades: number; sumR: number }>
  best: { scanner: string; sumR: number } | null; worst: { scanner: string; sumR: number } | null
  marginSumR: number
}
export interface DailyRow {
  day: string; partial: boolean; account: BookDay; shadow: BookDay; equity: number
  incubator: { admitted: number; proposed: number; promoted: number; retired: number; demoted: number }
}

/** Decision 139: an operator's tracker of shadow-traded cells. */
export interface TrackerCell { scannerId: string; symbol: string; tf: string; stage: string; trades: number; sumR: number; avgR: number; wins: number; stops: number; open: number; lastAt: number | null }
export interface TrackerView {
  tracker: { id: string; name: string; scanners: string[]; symbols: string[]; tfs: string[]; createdAt: number }
  cells: TrackerCell[]
  totals: { cells: number; trading: number; trades: number; sumR: number; avgR: number; winRate: number; open: number }
}

// ---- decision 153: the Library ----
export interface LibraryFamily { key: string; label: string; count: number }
export type LibraryStage = 'live' | 'shadow' | 'proposed' | 'tracked' | 'candidate' | 'retired' | 'demote_proposed'
export interface LibraryEntry {
  id: string; name: string; author: string; family: string; origin: 'luxalgo' | 'tradingview' | 'other'
  status: 'runs' | 'fails' | 'quarantined'; error: string | null; scriptType: 'indicator' | 'strategy' | null
  overlay: boolean; updated: string | null; url: string; enabled: boolean
  stages: Partial<Record<LibraryStage, number>>
  shadow: { n: number; r: number; win: number; spark: number[] } | null
  paper: { n: number; net: number; r: number } | null
}
export interface LibraryList { at: number; families: LibraryFamily[]; scripts: LibraryEntry[]; favorites: string[] }
export interface LibraryPair {
  symbol: string; tf: string; stage: LibraryStage; since: number
  screen: { pass: boolean; trades: number | null; avgR: number | null; profitFactor: number | null; at: number | null; expired: boolean } | null
  shadow30: { n: number; r: number } | null
}
export interface LibraryTrade { book: 'paper' | 'shadow'; symbol: string; tf: string; side: string; entryAt: number; exitAt: number; exitReason: string; r: number; net: number | null }
export interface LibraryDetail extends LibraryEntry {
  license: string | null; pineVersion: string | null; lines: number | null; patches: string[]; reason: string | null
  health: { fails: number; lastError: string | null; quarantined: boolean; reason: string | null } | null
  pairs: LibraryPair[]; recent: LibraryTrade[]
}

/** Decision 174: screening on demand. */
export interface ScreenJob {
  id: string; label: string; ids: string[]; tf: string; markets?: string[]; actor: string; requestedAt: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; startedAt?: number; finishedAt?: number
  progress?: { scripts: number; done: number; runs: number; passed: number }; summary?: string; error?: string; tail: string[]
}
export interface ScreenQueueView { running: ScreenJob | null; queued: ScreenJob[]; history: ScreenJob[]; nightlyRunning: boolean; capped: boolean }
