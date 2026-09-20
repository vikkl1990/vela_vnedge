import type { DataProvider } from '@luxalgo/vela'
import { api } from '../api/client'
import type { Candle, Market } from '../api/types'
import { velaToDeltaTf } from '../lib/timeframes'
import { sseBus } from '../sse/bus'

/**
 * Vela `DataProvider` backed by the VNEdge server:
 *   - history  → GET /api/candles (Delta tf strings; Vela passes TradingView-style)
 *   - live     → SSE `candle` (authoritative forming bar) + `tick` (intra-bar close nudge)
 *   - symbols  → GET /api/markets
 *
 * Registered under the name `delta`, so charts use `delta:BTCUSD`; the provider
 * receives the bare `BTCUSD`.
 */

let marketsCache: Market[] | null = null
let marketsPromise: Promise<Market[]> | null = null

async function loadMarkets(): Promise<Market[]> {
  if (marketsCache) return marketsCache
  if (!marketsPromise) {
    marketsPromise = api
      .markets()
      .then((m) => {
        marketsCache = m
        return m
      })
      .catch((e) => {
        marketsPromise = null
        console.warn('[delta-provider] markets unavailable', e)
        return []
      })
  }
  return marketsPromise
}

/** Allow the app to pre-seed the market list (e.g. from the React Query cache). */
export function seedMarkets(m: Market[]) {
  if (m.length) marketsCache = m
}

function toOHLCV(c: Candle) {
  return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
}

export const deltaProvider: DataProvider = {
  info: () => ({
    name: 'delta',
    displayName: 'Delta India',
    supportedTimeframes: ['1', '3', '5', '15', '30', '60', '120', '240', '360', 'D'],
    capabilities: { enumerate: true, stream: true, symbolInfo: true },
  }),

  async listSymbols() {
    try {
      const m = await loadMarkets()
      return m.map((x) => ({ ticker: x.symbol, description: x.description, type: 'crypto' }))
    } catch {
      return []
    }
  },

  /**
   * Pine `syminfo.*` for the engine. vela-pinets forwards this object verbatim, so it
   * must carry the pinets `ISymbolInfo` keys scripts rely on — in particular
   * `tickerid`: without it `request.security(syminfo.tickerid, "60", close)` receives
   * an undefined first argument, pinets shifts the positional args and the call
   * fails with "Invalid timeframe".
   */
  async getSymbolInfo(ticker: string) {
    const m = (await loadMarkets()).find((x) => x.symbol === ticker)
    const tick = m?.tickSize && m.tickSize > 0 ? m.tickSize : 0.5
    const pricescale = Math.round(1 / tick)
    const tickerid = `DELTA:${ticker}`
    return {
      ticker,
      tickerid,
      main_tickerid: tickerid,
      root: ticker,
      prefix: 'DELTA',
      exchange: 'DELTA',
      description: m?.description ?? ticker,
      type: 'crypto',
      currency: 'USD',
      basecurrency: ticker.replace(/USD.*$/i, ''),
      country: 'IN',
      timezone: 'UTC',
      session: '24x7',
      volumetype: 'base',
      current_contract: ticker,
      mintick: tick,
      minmove: 1,
      mincontract: 1,
      pricescale: Number.isFinite(pricescale) && pricescale > 0 ? pricescale : 2,
      pointvalue: m?.contractValue ?? 1,
    }
  },

  async getBars(ticker, timeframe, range) {
    const tf = velaToDeltaTf(timeframe)
    const limit = Math.min(4000, Math.max(1, range.limit ?? 1000))
    const bars = await api.candles({ symbol: ticker, tf, limit, from: range.from, to: range.to })
    if (!Array.isArray(bars)) return []
    const out = bars
      .filter((b) => b && Number.isFinite(b.time) && Number.isFinite(b.close))
      .map(toOHLCV)
      .sort((a, b) => a.time - b.time)
    // de-dupe by open time (keep last)
    const dedup: typeof out = []
    for (const b of out) {
      const last = dedup[dedup.length - 1]
      if (last && last.time === b.time) dedup[dedup.length - 1] = b
      else dedup.push(b)
    }
    return dedup
  },

  subscribe(ticker, timeframe, onBar) {
    const tf = velaToDeltaTf(timeframe)
    let forming: ReturnType<typeof toOHLCV> | null = null

    const offCandle = sseBus.on('candle', (e) => {
      if (e.symbol !== ticker || e.tf !== tf || !e.bar) return
      forming = toOHLCV(e.bar)
      onBar(forming)
    })
    const offTick = sseBus.on('tick', (t) => {
      if (t.symbol !== ticker || !forming || !Number.isFinite(t.price)) return
      // nudge the forming bar's close between candle events
      const next = {
        ...forming,
        close: t.price,
        high: Math.max(forming.high, t.price),
        low: Math.min(forming.low, t.price),
      }
      forming = next
      onBar(next)
    })
    return () => {
      offCandle()
      offTick()
    }
  },
}
