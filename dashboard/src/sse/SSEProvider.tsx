import { useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { qk } from '../api/queries'
import type {
  Health,
  LogEntry,
  Position,
  PositionEvent,
  Scanner,
  ScannerEvent,
  Signal,
  SSEEventMap,
  SSEEventName,
  Stats,
  TickEvent,
} from '../api/types'
import { sseBus } from './bus'
import './prices'

export type SSEStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface SSEState {
  status: SSEStatus
  attempts: number
  /** Throttled (≤ 1 update / 2 s). Use `getLastEventAt()` for an exact value. */
  lastEventAt: number | null
  lastTickAt: number | null
  /** Throttled snapshot (≤ 4 updates / s). Prefer `useLivePrice(symbol)` in cells. */
  lastPrice: Record<string, TickEvent>
  liveSignal: Signal | null
  getLastEventAt: () => number | null
}

const Ctx = createContext<SSEState | null>(null)

const EVENTS: SSEEventName[] = [
  'hello',
  'tick',
  'candle',
  'signal',
  'position',
  'trade',
  'order',
  'scanner',
  'stats',
  'health',
  'log',
]

const MAX_BACKOFF = 15_000
const PRICE_FLUSH_MS = 250
const EVENT_AT_FLUSH_MS = 2000
const INVALIDATE_DEBOUNCE_MS = 400

export function SSEProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<SSEStatus>('connecting')
  const [attempts, setAttempts] = useState(0)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [lastTickAt, setLastTickAt] = useState<number | null>(null)
  const [lastPrice, setLastPrice] = useState<Record<string, TickEvent>>({})
  const [liveSignal, setLiveSignal] = useState<Signal | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const timerRef = useRef<number | null>(null)
  const attemptsRef = useRef(0)
  const closedRef = useRef(false)
  const lastEventAtRef = useRef<number | null>(null)
  const getLastEventAt = useCallback(() => lastEventAtRef.current, [])

  useEffect(() => {
    closedRef.current = false

    // ---- throttled state flushes ------------------------------------------
    const pendingPrices = new Map<string, TickEvent>()
    let priceTimer: number | null = null
    const flushPrices = () => {
      priceTimer = null
      if (!pendingPrices.size) return
      const batch = Object.fromEntries(pendingPrices)
      pendingPrices.clear()
      setLastPrice((p) => ({ ...p, ...batch }))
    }
    let eventAtTimer: number | null = null
    const noteEvent = () => {
      const now = Date.now()
      lastEventAtRef.current = now
      if (eventAtTimer == null) {
        eventAtTimer = window.setTimeout(() => {
          eventAtTimer = null
          setLastEventAt(lastEventAtRef.current)
        }, EVENT_AT_FLUSH_MS)
      }
    }

    // ---- debounced invalidation (coalesce SSE bursts into one refetch) -----
    const invTimers = new Map<string, number>()
    const invalidate = (key: readonly unknown[]) => {
      const k = JSON.stringify(key)
      const prev = invTimers.get(k)
      if (prev) window.clearTimeout(prev)
      invTimers.set(
        k,
        window.setTimeout(() => {
          invTimers.delete(k)
          void qc.invalidateQueries({ queryKey: key })
        }, INVALIDATE_DEBOUNCE_MS),
      )
    }
    const bumpStats = () => invalidate(qk.stats)

    // ---- query-cache integration -----------------------------------------
    const offs: (() => void)[] = []
    offs.push(
      sseBus.on('hello', (d) => {
        qc.setQueryData(qk.health, d.health)
      }),
      sseBus.on('health', (h: Health) => qc.setQueryData(qk.health, h)),
      sseBus.on('stats', (s: Stats) => qc.setQueryData(qk.stats, s)),
      sseBus.on('tick', (t: TickEvent) => {
        pendingPrices.set(t.symbol, t)
        if (priceTimer == null) {
          priceTimer = window.setTimeout(() => {
            setLastTickAt(Date.now())
            flushPrices()
          }, PRICE_FLUSH_MS)
        }
      }),
      sseBus.on('signal', (s: Signal) => {
        setLiveSignal(s)
        invalidate(['signals'])
        invalidate(qk.scanners)
      }),
      sseBus.on('position', (e: PositionEvent) => {
        qc.setQueryData<Position[]>(qk.positions, (prev) => {
          const list = prev ?? []
          if (e.type === 'closed') return list.filter((p) => p.id !== e.position.id)
          const idx = list.findIndex((p) => p.id === e.position.id)
          if (idx === -1) return [e.position, ...list]
          // Replace only the changed row so memoized rows keep their identity.
          const next = list.slice()
          next[idx] = e.position
          return next
        })
        if (e.type !== 'updated') bumpStats()
      }),
      sseBus.on('trade', () => {
        invalidate(['trades'])
        invalidate(qk.orders)
        invalidate(['equity'])
        invalidate(qk.scanners)
        invalidate(qk.analytics)
        bumpStats()
      }),
      sseBus.on('order', () => invalidate(qk.orders)),
      sseBus.on('scanner', (e: ScannerEvent) => {
        qc.setQueryData<Scanner[]>(qk.scanners, (prev) =>
          prev ? prev.map((s) => (s.id === e.id ? { ...s, lastRun: e.lastRun, stats: e.stats } : s)) : prev,
        )
      }),
      sseBus.on('log', (l: LogEntry) => {
        // append to every cached level list whose threshold this entry meets
        const sev: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }
        for (const q of qc.getQueryCache().findAll({ queryKey: ['logs'] })) {
          const lvl = q.queryKey[1] as string
          if (lvl !== 'all' && (sev[l.level] ?? 0) < (sev[lvl] ?? 0)) continue
          qc.setQueryData<LogEntry[]>(q.queryKey, (prev) => (prev ? [...prev.slice(-999), l] : prev))
        }
      }),
    )

    // ---- connection ---------------------------------------------------------
    const connect = () => {
      if (closedRef.current) return
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
      setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting')
      let es: EventSource
      try {
        es = new EventSource('/api/events')
      } catch (e) {
        console.warn('[sse] EventSource failed', e)
        scheduleReconnect()
        return
      }
      esRef.current = es

      es.onopen = () => {
        const wasReconnect = attemptsRef.current > 0
        attemptsRef.current = 0
        setAttempts(0)
        setStatus('connected')
        noteEvent()
        // resync anything we may have missed while disconnected
        if (wasReconnect) void qc.invalidateQueries()
      }
      es.onerror = () => {
        // EventSource auto-retries, but we manage backoff ourselves for control.
        es.close()
        if (esRef.current === es) esRef.current = null
        scheduleReconnect()
      }
      for (const name of EVENTS) {
        es.addEventListener(name, (ev) => {
          const me = ev as MessageEvent<string>
          let data: unknown
          try {
            data = JSON.parse(me.data)
          } catch {
            return
          }
          noteEvent()
          sseBus.emit(name, data as SSEEventMap[typeof name])
        })
      }
    }

    const scheduleReconnect = () => {
      if (closedRef.current) return
      attemptsRef.current += 1
      setAttempts(attemptsRef.current)
      setStatus(attemptsRef.current > 3 ? 'offline' : 'reconnecting')
      const delay = Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(6, attemptsRef.current - 1)) + Math.random() * 500
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(connect, delay)
    }

    connect()
    const onVis = () => {
      if (document.visibilityState === 'visible' && !esRef.current) {
        attemptsRef.current = 0
        connect()
      }
    }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      closedRef.current = true
      document.removeEventListener('visibilitychange', onVis)
      if (timerRef.current) window.clearTimeout(timerRef.current)
      if (priceTimer != null) window.clearTimeout(priceTimer)
      if (eventAtTimer != null) window.clearTimeout(eventAtTimer)
      for (const t of invTimers.values()) window.clearTimeout(t)
      esRef.current?.close()
      esRef.current = null
      offs.forEach((f) => f())
    }
  }, [qc])

  const value = useMemo<SSEState>(
    () => ({ status, attempts, lastEventAt, lastTickAt, lastPrice, liveSignal, getLastEventAt }),
    [status, attempts, lastEventAt, lastTickAt, lastPrice, liveSignal, getLastEventAt],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSSE(): SSEState {
  const c = useContext(Ctx)
  if (!c) throw new Error('useSSE outside SSEProvider')
  return c
}

/** Subscribe to one SSE event inside a component. Handler ref is kept fresh. */
export function useSSEEvent<K extends SSEEventName>(event: K, handler: (d: SSEEventMap[K]) => void) {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => sseBus.on(event, (d) => ref.current(d)), [event])
}
