import { useEffect, useState } from 'react'

/*
 * One shared timer per interval length: 200 table rows asking for a 5 s clock
 * share a single setInterval instead of creating 200.
 */
const tickers = new Map<number, { id: number; subs: Set<(t: number) => void> }>()

function subscribe(intervalMs: number, fn: (t: number) => void): () => void {
  let t = tickers.get(intervalMs)
  if (!t) {
    const subs = new Set<(t: number) => void>()
    const id = window.setInterval(() => {
      const now = Date.now()
      for (const s of Array.from(subs)) s(now)
    }, intervalMs)
    t = { id, subs }
    tickers.set(intervalMs, t)
  }
  t.subs.add(fn)
  return () => {
    t!.subs.delete(fn)
    if (t!.subs.size === 0) {
      window.clearInterval(t!.id)
      tickers.delete(intervalMs)
    }
  }
}

/** A ticking `Date.now()` for relative-time displays. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribe(intervalMs, setNow), [intervalMs])
  return now
}
