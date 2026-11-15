import type { Health } from './config.ts'
import type { Candle } from './market.ts'
import type { LastRun, ScannerStats } from './scanner.ts'
import type { LogEntry, Order, Position, Signal, Stats, Trade } from './trading.ts'

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
  accounting: { at: number; reason: string; symbol?: string }
  hello: HelloEvent
  tick: TickEvent
  candle: CandleEvent
  signal: Signal
  position: PositionEvent
  trade: Trade
  pending: { type: string; id: number; reason?: string }
  order: Order
  scanner: ScannerEvent
  stats: Stats
  health: Health
  log: LogEntry
}
export type SSEEventName = keyof SSEEventMap
