export interface MonitorPair {
  symbol: string
  active: boolean
  change24hPct: number | null
  volume24h: number | null
  depthAt: number | null
  depthFresh: boolean
  priceAt: number | null
  flow: { covered: boolean; imbalance: number | null; throughAt: number | null; minutes: number } | null
  paper: { trades: number; stops: number; net: number; r: number }
  shadow: { trades: number; stops: number; net: null; r: number }
  paperOpen: number
  shadowOpen: number
  researchOpen: number
  worstOpenR: number | null
}
export interface MonitorPosition {
  id: number
  entryAt: number
  book: number
  scope: string
  symbol: string
  scanner: string
  tf: string
  side: string
  firstAt: number
  lastAt: number
  r: number | null
  peak: number
  worst: number
  complete: boolean
  state: string
  reason: string
  policyId: string | null
}
export interface MonitorTrial {
  id: number
  position_id: number
  entry_at: number
  book: number
  scope: string
  symbol: string
  rule: string
  trigger_at: number
  ready_at: number
  status: string
  market_qty: number
  market_filled: number
  net: number | null
  actual_net: number | null
  delta: number | null
  error: string | null
  risk: number
}
export interface TradeMonitorView {
  intrabarStudy?: {
    rule: string
    startedAt: number
    mode: 'shadow-advisory'
    promotionEligible: false
    description: string
    groups: Array<{
      key: string
      scanner: string
      symbol: string
      tf: string
      policyId: string
      enrolled: number
      closed: number
      covered: number
      unavailable: number
      triggered: number
      samples: number
      usable: number
      quiet: number
      dataUnavailable: number
      baselineNet: number
      candidateNet: number
      baselineR: number
      candidateR: number
      stressDeltaR: number
      stopsBefore: number
      stopsAfter: number
      losersBefore: number
      losersAfter: number
      stressLosers: number
      winnersCut: number
      winnersLost: number
      stressWinnersCut: number
      winnerGivebackR: number
    }>
    recent: Array<{ positionId: number; symbol: string; status: string; reason: string | null }>
  }
  scannerExitStudy?: {
    rule: string
    startedAt: number
    mode: 'shadow-advisory'
    promotionEligible: false
    description: string
    groups: Array<{
      key: string
      scanner: string
      symbol: string
      tf: string
      book: number
      policyId: string
      enrolled: number
      closed: number
      covered: number
      unavailable: number
      missingActual: number
      baselineNet: number | null
      candidateNet: number | null
      baselineR: number
      candidateR: number
      stressDeltaR: number
      stopsBefore: number
      stopsAfter: number
      losersBefore: number
      losersAfter: number
      winnersCut: number
      winnersLost: number
      winnerGivebackR: number
    }>
  }
  invalidationStudy?: {
    rule: string
    startedAt: number
    mode: 'shadow-advisory'
    promotionEligible: false
    description: string
    groups: Array<{
      policyId: string
      enrolled: number
      closed: number
      covered: number
      unavailable: number
      triggered: number
      deltaR: number
      stressDeltaR: number
      stopsBefore: number
      stopsAfter: number
      losersBefore: number
      losersAfter: number
      winnersCut: number
    }>
  }
  replay?: {
    entryInvalidationStudy?: {
      ready: boolean
      symbols: string[]
      bytes: number
      lastSyncAt: number | null
      lastError: string | null
      failures: number
      dropped: number
    }
  }
  mode: 'advisory'
  version: string
  at: number
  generatedAt: number
  marketError: string | null
  retention: string
  rules: Array<{ id: string; name: string; description: string }>
  positions: MonitorPosition[]
  pairs: MonitorPair[]
  trials: MonitorTrial[]
  connections: { symbols: number; connections: number; connected: number }
  summary: Array<{
    book: number
    scope: string
    rule: string
    trials: number
    resolved: number
    deltaUsd: number
    deltaR: number
    unavailable: number
    winnersLost: number
  }>
}
