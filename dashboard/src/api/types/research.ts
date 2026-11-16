import type { PaperExecution } from './trading.ts'

/** The levels a path is read against: break even, the stop it opened with, and the targets. */
export interface PathLevels {
  execution?: PaperExecution
  executionReports?: Array<{
    at: number
    qty: number
    price: number
    reason: string
    trigger_at: number
    ready_at: number
  }>
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

export interface MarketVerdict {
  symbol: string
  allowed: boolean
  tracked?: boolean
  reasons: string[]
  atrPct: number | null
  turnoverUsd: number | null
  spreadPct?: number | null
  bookCostPct?: number | null
  trades: number
  pf: number | null
  netUsd: number
}
export interface MarketsToday {
  freshDepth?: boolean
  at: number
  enabled: boolean
  markets: MarketVerdict[]
}

/** One minute of the process (decision 80). */
export interface OpsMetricRow {
  at: number
  rss: number
  heap: number
  rssPct: number
  queued: number
  busy: number
  recycled: number
  runsH: number
  signalsH: number
  feedUp: number
  openPositions: number
  closeLagS: number | null
}

/** Decision 136: one UTC day of both books and the incubator. */
export interface BookDay {
  trades: number
  net: number
  fees: number
  sumR: number
  avgR: number
  wins: number
  stops: number
  trails: number
  trailKeeps: number | null
  byTf: Record<string, { trades: number; sumR: number }>
  byGroup: Record<string, { trades: number; sumR: number; net: number }>
  best: { scanner: string; sumR: number } | null
  worst: { scanner: string; sumR: number } | null
  marginSumR: number
}
export interface DailyRow {
  day: string
  partial: boolean
  account: BookDay
  shadow: BookDay
  equity: number
  incubator: { admitted: number; proposed: number; promoted: number; retired: number; demoted: number }
}

/** Decision 139: an operator's tracker of shadow-traded cells. */
export interface TrackerCell {
  scannerId: string
  symbol: string
  tf: string
  stage: string
  trades: number
  sumR: number
  avgR: number
  wins: number
  stops: number
  open: number
  lastAt: number | null
}
export interface TrackerView {
  tracker: {
    id: string
    name: string
    scanners: string[]
    symbols: string[]
    tfs: string[]
    createdAt: number
    scanPriority?: 'normal' | 'timely'
  }
  cells: TrackerCell[]
  totals: {
    cells: number
    trading: number
    trades: number
    sumR: number
    avgR: number
    winRate: number
    open: number
  }
}

// ---- decision 153: the Library ----
export interface LibraryFamily {
  key: string
  label: string
  count: number
}
export type LibraryStage =
  'live' | 'shadow' | 'proposed' | 'tracked' | 'candidate' | 'retired' | 'demote_proposed'
export interface LibraryEntry {
  id: string
  name: string
  author: string
  family: string
  origin: 'luxalgo' | 'tradingview' | 'other'
  status: 'runs' | 'fails' | 'quarantined'
  error: string | null
  scriptType: 'indicator' | 'strategy' | null
  overlay: boolean
  updated: string | null
  url: string
  enabled: boolean
  stages: Partial<Record<LibraryStage, number>>
  shadow: { n: number; r: number; win: number; spark: number[] } | null
  paper: { n: number; net: number; r: number } | null
}
export interface LibraryList {
  at: number
  families: LibraryFamily[]
  scripts: LibraryEntry[]
  favorites: string[]
}
export interface LibraryPair {
  symbol: string
  tf: string
  stage: LibraryStage
  since: number
  screen: {
    pass: boolean
    trades: number | null
    avgR: number | null
    profitFactor: number | null
    at: number | null
    expired: boolean
  } | null
  shadow30: { n: number; r: number } | null
}
export interface LibraryTrade {
  book: 'paper' | 'shadow'
  symbol: string
  tf: string
  side: string
  entryAt: number
  exitAt: number
  exitReason: string
  r: number
  net: number | null
}
export interface LibraryDetail extends LibraryEntry {
  license: string | null
  pineVersion: string | null
  lines: number | null
  patches: string[]
  reason: string | null
  health: { fails: number; lastError: string | null; quarantined: boolean; reason: string | null } | null
  pairs: LibraryPair[]
  recent: LibraryTrade[]
  authorReview?: AuthorReview
}

export interface AuthorReview {
  variant?: { base: string; reason: string | null } | null
  asOf: string
  sourceStatus: 'unreviewed' | 'matches' | 'changed'
  sourceReviewedAt: string | null
  sourceHash: string
  reviewedSourceHash: string | null
  descriptionStatus: 'unavailable' | 'retrieved' | 'changed' | 'reviewed'
  publication: {
    url: string
    author: string | null
    retrievedAt: string | null
    updatedAt: string | null
    version: number | null
    reviewedAt: string | null
    role: string | null
    summary: string | null
    requirements: string | null
    reviewBlocker?: { blocker: string; checkedAt: string | null }
  } | null
  reconciliationStatus:
    'unreviewed' | 'publication changed' | 'description only' | 'matches' | 'source changed or not inspected'
  reconciliation: {
    sourceChecked: boolean
    scope: string
    findings: Array<{
      kind: string
      marker: string
      evidence: string
      sourceLine: number | null
      action: string
    }>
  } | null
  contract: {
    type: string
    idea: string
    reviewScope?: string
    entries: Array<{ marker: string; channel: string; side: string; line: number | null; condition: string }>
    notEntries: Array<{ marker: string; channel: string; role: string; line: number }>
    stop: { has: boolean | null; how: string }
    targets: { has: boolean | null; how: string }
    exit: { has: boolean | null; how: string }
    timing: {
      note: string
      knownAtClose: boolean | null
      pivotLagBars: number | null
      lookahead: string
      repaints: boolean | null
    }
    claims: Array<{ marker: string; problem: string; line: number; evidence: string }>
  } | null
  claimMeaning: string
  integrationNotes: string[]
  patches: string[]
  admission: string
  reading: {
    reader: number
    sources: string[] | null
    labels: string[] | null
    sides: Record<string, string> | null
    labelStyles?: Record<string, Record<string, string>> | null
    exitMode: string
    entryProtection: string
  }
}

/** Decision 174: screening on demand. */
export interface ScreenJob {
  id: string
  label: string
  ids: string[]
  tf: string
  markets?: string[]
  actor: string
  requestedAt: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  startedAt?: number
  finishedAt?: number
  progress?: { scripts: number; done: number; runs: number; passed: number }
  summary?: string
  error?: string
  tail: string[]
}
export interface ScreenQueueView {
  running: ScreenJob | null
  queued: ScreenJob[]
  history: ScreenJob[]
  nightlyRunning: boolean
  capped: boolean
}

/** Decision 183: the signal radar, market × timeframe. */
export interface RadarCell {
  live: number
  shadow: number
  candidate: number
  tracked: number
  signals: number
  shadowSignals: number
  shadowHistoryCapped: boolean
  opened: number
  stops: number
  closes: number
  netR: number
  refusal: string | null
  bins: Array<{ opened: number; stops: number }>
}
export interface RadarMarket {
  symbol: string
  turnoverUsd: number | null
  allowed: boolean | null
  atrPct: number | null
  cells: Record<string, RadarCell | null>
}
export interface RadarView {
  at: number
  hours: number
  bins: number
  tfs: string[]
  markets: RadarMarket[]
  shadowHistoryCapped: boolean
  totals: Record<
    string,
    {
      live: number
      shadow: number
      candidate: number
      tracked: number
      signals: number
      shadowSignals: number
      opened: number
      stops: number
      closes: number
      netR: number
    }
  >
  reserve: Array<{ tfs?: string[]; markets?: string[]; slots: number }>
  maxShadow: number
}

/** Decision 187: the paper fills set beside Delta's real prints. Slippage is positive when the tape was worse than paper. */
export interface TapeAuditView {
  since: number | null
  fills: Array<{
    book: string
    kind: string
    n: number
    noPrints: number
    late?: number
    unobserved?: number
    medianBps: number | null
    meanBps: number | null
    p90Bps: number | null
    meanR: number | null
  }>
  limits: Array<{
    book: string
    n: number
    filled: number
    touched: number
    through: number
    medianVolBeforeThrough: number | null
  }>
  recent: Array<{
    id: number
    at: number
    book: number
    symbol: string
    tf: string | null
    kind: string
    side: string | null
    paper_price: number | null
    tape_price: number | null
    worst_print: number | null
    prints: number | null
    slip_bps: number | null
    slip_r: number | null
    extra: Record<string, unknown> | null
  }>
}

/** Decision 194: one strategy under several library ids. */
export interface DuplicateGroup {
  identity: string
  canonical: string
  aliases: string[]
}
/** Decision 194: shadow pairs (scanner|symbol|tf) whose entries coincide. */
export interface OverlapCluster {
  members: string[]
  trades: number
  sharedTrades: number
  links: Array<{
    a: string
    b: string
    symbol: string
    tf: string
    shared: number
    aTrades: number
    bTrades: number
    share: number
  }>
}

/** Decision 197: the early profit lock replayed on the books' own trades (a counterfactual on recorded paths). */
export interface LockStudyView {
  at: number
  since: number
  atR: number
  keepR: number
  rows: Array<{
    book: 'account' | 'shadow'
    tf: string
    trades: number
    withPath: number
    covered: number
    armed: number
    fired: number
    baseR: number
    lockR: number
    deltaR: number
    rescued: number
    rescuedR: number
    cutShort: number
    cutShortR: number
  }>
  daily: Array<{
    day: string
    book: 'account' | 'shadow'
    tf: string
    trades: number
    fired: number
    deltaR: number
  }>
  assumptions: string[]
}

export interface AllocationStats {
  n: number
  netR: number
  grossR: number
  feeR: number
  avgR: number | null
  stops: number
  firstBarStops: number
  cohorts: number
  missingCohort: number
}
export interface AllocationAudit {
  at: number
  since: number
  split: number
  note: string
  rows: Array<{
    scannerId: string
    scannerName: string
    symbol: string
    tf: string
    verdict: string
    account: { recent: AllocationStats; prior: AllocationStats }
    shadow: { recent: AllocationStats; prior: AllocationStats }
  }>
  execution: Array<{
    position_id: number
    book: number
    symbol: string
    tf: string
    entry_at: number
    source: string | null
    spread_bps: number | null
    quote_at: number | null
    quote_exchange_at: number | null
    entry_fee: number
    expected_exit_fee: number
    signal_delay_ms: number | null
    depth_state: string
    depth_lag_ms: number | null
    depth_vwap: number | null
    depth_impact_bps: number | null
    depth_coverage: number | null
    fillEvidence?: {
      role: string
      source: string
      admissionDepth: { checkedQty: number; receivedAt: number; exchangeAt: number } | null
      depth: { receivedAt: number; exchangeAt: number; requestedQty: number; vwap: number } | null
      limit: { placedAt: number; eventAt: number; observedAt: number; trigger: { kind: string } } | null
    } | null
  }>
}

export interface ReclaimTrialsView {
  at: number
  auditStartedAt: number | null
  trials: Array<{
    rule: {
      scannerId: string
      symbol: string
      tf: string
      sizeScale: number
      maxDailyEntries: number
      minSignalBarAtr?: number
      maxStopLossPct?: number
      pullbackAtr: number
      setupMinutes: number
      orderMinutes: number
    }
    active: boolean
    state: string
    counts: Record<string, number>
    pending: Array<{ id: number; phase: string; expiresAt: number | null; price: number | null }>
    open: number
    usedToday: number
    closed: number
    net: number
    sumR: number
    events: Array<{ at: number; event: string; reason: string | null; signal_id: number | null }>
    lastScan: { at: number; barTime: number; note: string | null } | null
  }>
}

export interface ExecutionQuality {
  observer: AccountObservation
  at: number
  mode: string
  fillSource?: 'candles' | 'tape'
  quotes?: {
    at: number
    total: number
    fresh: number
    l1: number
    fallback: number
    rows: Array<{
      symbol: string
      source: string
      bid: number
      ask: number
      bidSize: number | null
      askSize: number | null
      receivedAt: number
      exchangeAt: number | null
      bookAt: number | null
      ageMs: number
      fresh: boolean
    }>
  }
  funding: {
    method: string
    counts: { status: string; n: number }[]
    recent: {
      symbol: string
      at: number
      status: string
      source: string
      rate: number | null
      mark: number | null
      error: string | null
    }[]
  }
  depth: {
    books: { symbol: string; at: number | null; valid: boolean; fresh: boolean }[]
    gaps: { symbol: string; n: number; lastAt: number }[]
    symbols: string[]
    validBooks: string[]
    failures: number
    queued: number
    droppedPending: number
    retention: string
    stored: { n: number; oldest: number | null; newest: number | null; bytes: number | null }
  }
  replay?: {
    enabled: boolean
    ready: boolean
    symbols: string[]
    queuedBytes: number
    dropped: number
    failures: number
    lastError: string | null
    lastSyncAt: number | null
    lastEventAt: number | null
    segments: number
    bytes: number
    oldest: number | null
    newest: number | null
    openEvents: number
    prunedSegments: number
    retention: { targetDays: number; maxBytes: number; minFreeBytes: number }
    coverage: string
  }
  account: {
    cursors: { host: string; from_at: number; through_at: number; error: string | null }[]
    comparisons: { orderId: number; complete: boolean; quantityMatches: boolean | null }[]
    rows: { host: string; kind: string; n: number }[]
  }
}
export interface AccountObservation {
  at: number
  state: string
  message: string
  syncing: boolean
  account: null | {
    label: string
    environment: string
    snapshotStartedAt: number
    completedAt: number
    historyFrom: number
    historyThrough: number
    historyLagMs: number
    accountingStatus: string
    limitations: string
    counts: { kind: string; n: number }[]
    snapshot: {
      balances: {
        asset: string
        balance: string | null
        available: string | null
        tradingFeeCredit: string | null
      }[]
      positions: { productId: string; symbol: string | null; size: number; entryPrice: string | null }[]
      orders: {
        id: string
        productId: string
        symbol: string | null
        side: string
        size: number
        unfilled: number
        state: string
        reduceOnly: boolean | null
        stopPrice: string | null
      }[]
    }
    recent: {
      kind: string
      at: number
      id: string
      transactionType?: string | null
      asset?: string | null
      amount?: string | null
      commission?: string | null
      feeDetails?: Record<string, string | number> | null
    }[]
  }
}
export interface PerformanceFilter {
  from?: number
  to?: number
  scanner?: string
  symbol?: string
  tf?: string
  side?: string
  reason?: string
  group?: string
  sector?: string
}
export interface PerformanceStats {
  trades: number
  rTrades: number
  wins: number
  stops: number
  trails: number
  net: number
  commission: number
  funding: number
  grossTrading: number
  sumR: number | null
  avgR: number | null
  winRate: number | null
  stopRate: number | null
  profitFactor: number | null
  noLosses: boolean
  fundingUnknown: number
  avgCommissionR: number | null
}
export interface PerformanceGroup {
  key: string
  label: string
  paper: PerformanceStats
  shadow: PerformanceStats
}
export interface PerformanceReport {
  at: number
  from: number | null
  to: number
  firstClose: number | null
  lastClose: number | null
  paper: PerformanceStats
  shadow: PerformanceStats
  daily: PerformanceGroup[]
  byTf: PerformanceGroup[]
  byScanner: PerformanceGroup[]
  bySymbol: PerformanceGroup[]
  byExit: PerformanceGroup[]
  byGroup: PerformanceGroup[]
  bySector: PerformanceGroup[]
}
