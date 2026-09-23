import { useCallback, useSyncExternalStore } from 'react'
import type { TickEvent } from '../api/types'
import { sseBus } from './bus'

/**
 * Per-symbol last price store fed by SSE `tick` events. Components subscribe to
 * a single symbol via `useLivePrice`, so a tick for BTCUSD re-renders only the
 * cells that show BTCUSD — never the whole table.
 *
 * Every tick carries the moment it arrived. A price whose tick is older than
 * `STALE_MS` is no longer treated as live: the value the server last sent wins, and the
 * display says so. Without that, a symbol whose feed quietly stopped kept showing its last
 * tick as a live price, and the P&L beside it looked current.
 */
const prices = new Map<string, { price: number; at: number }>()

/** A tick older than this is not a live price any more (three 15m-feed heartbeats of slack). */
export const STALE_MS = 90_000

sseBus.on('tick', (t: TickEvent) => {
  if (t && typeof t.symbol === 'string' && Number.isFinite(t.price)) prices.set(t.symbol, { price: t.price, at: Date.now() })
})

export function getLivePrice(symbol: string, now = Date.now()): number | undefined {
  const p = prices.get(symbol)
  return p && now - p.at <= STALE_MS ? p.price : undefined
}

export interface LivePrice {
  /** The price to display: the live tick, or the server's value when no fresh tick exists. */
  price: number | undefined
  /** Age of the tick in ms, or null when no tick has arrived for this symbol. */
  ageMs: number | null
  /** True when the displayed price comes from a tick older than `STALE_MS` or from the server. */
  stale: boolean
}

function read(symbol: string, fallback?: number | null): LivePrice {
  const p = prices.get(symbol)
  const ageMs = p ? Date.now() - p.at : null
  const fresh = p !== undefined && ageMs !== null && ageMs <= STALE_MS
  return { price: fresh ? p!.price : fallback ?? p?.price ?? undefined, ageMs, stale: !fresh }
}

/** Latest tick price for `symbol` with its freshness (falls back to the server's value). */
export function useLiveTick(symbol: string, fallback?: number | null): LivePrice {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const off = sseBus.on('tick', (t: TickEvent) => { if (t.symbol === symbol) onChange() })
      // re-read on a slow clock as well, so a feed that simply stops still turns stale on screen
      const timer = setInterval(onChange, 15_000)
      return () => { off(); clearInterval(timer) }
    },
    [symbol],
  )
  const snapshot = useCallback(() => {
    const p = prices.get(symbol)
    // useSyncExternalStore compares by reference: key the snapshot on what the UI shows
    return `${p?.price ?? ''}:${p ? Math.floor((Date.now() - p.at) / 15_000) : ''}:${fallback ?? ''}`
  }, [symbol, fallback])
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return read(symbol, fallback)
}

/** Latest tick price for `symbol` (or `fallback` when no fresh tick exists). */
export function useLivePrice(symbol: string, fallback?: number | null): number | undefined {
  return useLiveTick(symbol, fallback).price
}
