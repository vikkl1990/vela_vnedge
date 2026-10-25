import type { Candle } from '../api/types'

/** Candle events own OHLCV. Ticks may only nudge a currently forming bar in their own bucket. */
export class CandleStream {
  private forming: Candle | null = null
  private closed = false
  private lastTick = -Infinity
  private intervalMs: number
  private emit: (bar: Candle) => void
  constructor(intervalMs: number, emit: (bar: Candle) => void) { this.intervalMs = intervalMs; this.emit = emit }
  candle(bar: Candle, closed: boolean) {
    if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) || bar.low <= 0 || bar.high < bar.low) return
    if (this.forming && bar.time < this.forming.time) return
    if (this.forming?.time !== bar.time) { this.lastTick = -Infinity; this.closed = false }
    // A delayed forming event must not reopen a bar already confirmed closed.
    if (this.closed && !closed) return
    this.forming = { ...bar }; this.closed = closed; this.emit({ ...bar })
  }
  tick(price: number, time: number) {
    const b = this.forming
    if (!b || this.closed || !(price > 0) || !Number.isFinite(time) || time < this.lastTick || !(this.intervalMs > 0)) return
    if (Math.floor(time / this.intervalMs) * this.intervalMs !== b.time) return
    this.lastTick = time
    this.forming = { ...b, close: price, high: Math.max(b.high, price), low: Math.min(b.low, price) }
    this.emit({ ...this.forming })
  }
}
