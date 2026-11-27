import type { ExitMode, ScannerStatus } from './common.ts'

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
export interface RunFunnel {
  raw: { alerts: number; conditions: number; shapes: number; labels: number; plots: number }
  events: { entries: number; exits: number; info: number }
  drops: Record<string, number>
  actions: Record<string, number>
  note?: string
}

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
  week?: {
    entries: number
    opened: number
    pending?: number
    pilot?: number
    protection?: number
    gate: number
    fee: number
    regime: number
    guard: number
    other: number
    lastEntryAt?: number
    reasons?: Array<{ action: string; symbol: string; tf: string; n: number; lastAt: number }>
  } | null
  author?: string
  file: string
  url: string
  status: ScannerStatus
  reason: string | null
  enabled: boolean
  /** Scheduled right now: enabled, runnable and not quarantined. */
  active?: boolean
  scheduledCells?: number
  minAtrPct?: number
  entryProtection?: 'atr' | 'native' | 'inherit'
  entryLimit?: { tfs: string[]; atr: number; minutes: number } | null
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
  reads?: {
    sources: EntrySource[] | null
    timezone: string | null
    rule: 'trailing' | 'oscillator' | null
    inputs: Record<string, number | string | boolean> | null
    exit: Record<string, unknown> | null
    labels?: string[] | null
    edge?: boolean | null
    invert?: boolean
    /** Decision 195/201: the scanner's explicit title contract, and the id it is a variant of. */
    sides?: Record<string, 'long' | 'short' | 'none'> | null
    labelStyles?: Record<string, Record<string, 'long' | 'short' | 'none'>> | null
    variantOf?: string | null
  }
  /** What it produced when last profiled: the author's plan, a direction, information, nothing. */
  kind?: ProfileKind | null
  profiledAt?: number | null
  health?: {
    fails: number
    lastAt: number
    lastError: string
    reason: string | null
    quarantined: boolean
  } | null
  /** Explicit (market, timeframe) pairs (decision 70); when set they replace symbols × timeframes. */
  pairs?: Array<{ symbol: string; tf: string }> | null
  /** Which books the scanner is in (decision 64): markets it trades in the account, markets it is proving in the shadow book, markets proposed for promotion. */
  books?: {
    account: string[]
    shadow: string[]
    proposed: string[]
    tracked?: string[]
    candidates?: string[]
  }
  paperReadiness?: {
    at: number
    copyEnabled: boolean
    shadow: number
    eligible: number
    tracked: number
    candidates: number
    holds: Array<{ symbol: string; tf: string; reason: string }>
  } | null
}

export type EntrySource = 'alert' | 'alertcondition' | 'shape' | 'derived' | 'label'
export type ProfileKind = 'plan' | 'signal' | 'exits' | 'levels' | 'silent' | 'broken'
export interface ProfileRow {
  scannerId: string
  market: string
  tf: string
  at: number
  kind: ProfileKind
  ms: number
  entries: number
  withSl: number
  withTp: number
  exits: number
  info: number
  alertEntries: number
  alertconds: number
  shapes: number
  labels: number
  labelTexts: string[]
  plots: number
  error: string | null
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
  readingHash?: string
  inputs?: Record<string, number | string | boolean>
  timezone?: string
  sourceHash?: string | null
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
