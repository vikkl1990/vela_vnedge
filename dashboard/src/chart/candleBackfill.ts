import type { Candle } from '../api/types'
import { CandleStream } from './candleStream.ts'

/** Deliver missing closed bars before advancing Vela's monotonic live stream. */
export class CandleBackfill {
  private stream: CandleStream
  private lastTime = -Infinity
  private lastClosed = false
  private stopped = false
  private abort = new AbortController()
  private filling = false
  private queued = new Map<number, { bar: Candle; closed: boolean }>()
  private latestTick: { price: number; time: number } | null = null
  private interval: number
  private load: (from: number, to: number, limit: number, signal: AbortSignal) => Promise<Candle[]>
  private report: (error: unknown) => void

  constructor(
    interval: number,
    emit: (bar: Candle) => void,
    load: (from: number, to: number, limit: number, signal: AbortSignal) => Promise<Candle[]>,
    report: (error: unknown) => void,
  ) {
    if (!(interval > 0) || !Number.isFinite(interval)) throw new Error('Invalid candle interval')
    this.interval = interval
    this.stream = new CandleStream(interval, emit)
    this.load = load
    this.report = report
  }

  candle(bar: Candle, closed: boolean) {
    if (this.stopped || !Number.isFinite(bar.time) || bar.time < this.lastTime) return
    if (this.filling || (this.lastTime >= 0 && bar.time > this.lastTime + this.interval)) {
      const previous = this.queued.get(bar.time)
      if (!previous?.closed || closed) this.queued.set(bar.time, { bar, closed })
      if (!this.filling) void this.drain()
      return
    }
    this.deliver(bar, closed)
  }

  tick(price: number, time: number) {
    if (this.stopped) return
    if (this.filling) {
      if (Number.isFinite(time) && price > 0 && time >= (this.latestTick?.time ?? -Infinity))
        this.latestTick = { price, time }
    } else this.stream.tick(price, time)
  }

  stop() {
    this.stopped = true
    this.abort.abort()
    this.queued.clear()
    this.latestTick = null
  }

  private deliver(bar: Candle, closed: boolean) {
    if (this.stream.candle(bar, closed)) {
      this.lastTime = Math.max(this.lastTime, bar.time)
      this.lastClosed = closed
    }
  }

  private async drain() {
    this.filling = true
    try {
      while (!this.stopped && this.queued.size) {
        const nextTime = Math.min(...this.queued.keys())
        // Bound each range, rather than asking for a long gap and silently keeping only its tail.
        for (let from = this.lastTime + (this.lastClosed ? this.interval : 0); from < nextTime;) {
          const to = Math.min(nextTime, from + 499 * this.interval)
          try {
            const rows = await this.load(
              from,
              to,
              500,
              AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
            )
            if (this.stopped) return
            if (!Array.isArray(rows)) throw new Error('Invalid candle backfill response')
            for (const row of rows) {
              if (row.time >= from && row.time < nextTime && row.time <= to && !this.queued.has(row.time))
                this.queued.set(row.time, { bar: row, closed: true })
            }
          } catch (error) {
            if (this.stopped) return
            this.report(error) // Missing history is visible; it is never synthesized.
            break
          }
          from = to
        }
        // Include live updates received during the fetch. Coalesce repeated forming updates,
        // retaining closed bars; never emit the newer candle ahead of its recovered history.
        const ready = [...this.queued.values()].filter((x) => x.bar.time <= nextTime)
        ready.sort((a, b) => a.bar.time - b.bar.time)
        for (const item of ready) {
          this.queued.delete(item.bar.time)
          this.deliver(item.bar, item.closed)
        }
      }
    } finally {
      this.filling = false
      const tick = this.latestTick
      this.latestTick = null
      if (!this.stopped && tick) this.stream.tick(tick.price, tick.time)
    }
  }
}
