import { useCallback, useSyncExternalStore } from 'react'
import type { TickEvent } from '../api/types'
import { sseBus } from './bus'

/**
 * Per-symbol last price store fed by SSE `tick` events. Components subscribe to
 * a single symbol via `useLivePrice`, so a tick for BTCUSD re-renders only the
 * cells that show BTCUSD — never the whole table.
 */
const prices = new Map<string, TickEvent>()

sseBus.on('tick', (t) => {
  if (t && typeof t.symbol === 'string' && Number.isFinite(t.price)) prices.set(t.symbol, t)
})

export function getLivePrice(symbol: string): number | undefined {
  return prices.get(symbol)?.price
}

/** Latest tick price for `symbol` (or `fallback` until one arrives). */
export function useLivePrice(symbol: string, fallback?: number | null): number | undefined {
  const subscribe = useCallback(
    (onChange: () => void) =>
      sseBus.on('tick', (t) => {
        if (t.symbol === symbol) onChange()
      }),
    [symbol],
  )
  const get = useCallback(() => prices.get(symbol)?.price, [symbol])
  const live = useSyncExternalStore(subscribe, get, get)
  return live ?? fallback ?? undefined
}
