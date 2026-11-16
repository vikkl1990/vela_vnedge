import type { SignalKind } from './common.ts'
import type { Trade } from './trading.ts'

// ---------- Query params ----------

export interface SignalQuery {
  tf?: string
  positionId?: number
  limit?: number
  scanner?: string
  symbol?: string
  side?: string
  kind?: SignalKind
  since?: number
}
export interface TradeQuery {
  limit?: number
  offset?: number
  scanner?: string
  symbol?: string
  reason?: string
  tf?: string
  side?: string
  from?: number
  to?: number
  /** Asset class of the market (majors, large_alts, alts, meme, tradfi, other) and its sector. */
  group?: string
  sector?: string
}
/** Decision 190: one page of the journal; `total`, `pnl` and `fees` cover every matching trade, not only this page. */
export interface TradePage {
  total: number
  offset: number
  limit: number
  pnl: number
  fees: number
  accountingPending?: number
  from: number | null
  to: number | null
  trades: Trade[]
}
export interface CandleQuery {
  symbol: string
  tf: string
  limit?: number
  from?: number
  to?: number
}
