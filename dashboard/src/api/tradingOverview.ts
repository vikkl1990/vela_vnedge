/** GET /api/trading/overview: the account, the entry funnel, each scanner live beside its backtest, and the policy. */
export type FunnelStage = 'opened' | 'cost' | 'trend' | 'burst' | 'cooldown' | 'caps' | 'regime' | 'risk' | 'ignored' | 'other'

export interface TradeRecord {
  trades: number
  wins: number
  pnl: number
  fees: number
  grossProfit: number
  grossLoss: number
  avgR: number | null
  /** null when there is no losing trade yet */
  profitFactor: number | null
}

export interface ScannerOverview {
  id: string
  name: string
  markets: number
  timeframes: string[]
  fired: number
  opened: number
  open: number
  live: TradeRecord & { perDay: number }
  backtest: {
    cells: number
    trades: number
    pnl: number
    profitFactor: number | null
    avgR: number | null
    perDay: number | null
    spanDays: number
  } | null
}

export interface TradingOverview {
  at: number
  since: number
  days: number
  account: {
    equity: number
    initialEquity: number
    closedPnl: number
    openPnl: number
    peakEquity: number
    drawdownPct: number
    maxDrawdownPct: number
    mode: string
    openPositions: number
  }
  window: TradeRecord & { opened: number; perDay: number }
  funnel: { fired: number; stages: Array<{ stage: FunnelStage; label: string; n: number; example: string | null }> }
  scanners: ScannerOverview[]
  policy: {
    costRatio: number
    trendGate: { emaLen: number; mode: string; tf: string | null; tfs: string[] | null } | null
    allowReversal: boolean
    sizing: string
    riskPerTradePct: number
    maxStopLossPct: number
    breakEvenAfterTp1: boolean
    tpSplit: number[]
    fallbackAtrSl: number
    timeframes: string[]
    markets: number
    scanners: number
    risk: {
      maxPositionsTotal: number
      maxPositionsPerSymbol: number
      perScannerMaxPositions: number
      reentryCooldownMinutes: number
      burstWindowSec: number
      maxDailyLossPct: number
      maxWeeklyLossPct: number
      noWeekend: boolean
      minAtrPct: number
    }
  }
}
