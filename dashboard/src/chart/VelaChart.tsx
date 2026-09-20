import { useEffect, useRef, useState } from 'react'
import type { IndicatorHandle, Vela as VelaType } from '@luxalgo/vela'
import { deltaProvider } from './deltaProvider'
import { FallbackChart } from './FallbackChart'
import { deltaToVelaTf } from '../lib/timeframes'
import { toastExternal } from '../lib/toast'
import { useTheme } from '../lib/theme'

export interface ChartScript {
  /** Stable id, e.g. scanner id. */
  id: string
  title: string
  /** Executable Pine source (the `patched` field from /api/scanners/:id/source). */
  source: string
  overlay?: boolean
}

interface Props {
  symbol: string
  /** Delta timeframe string, e.g. `15m`. */
  tf: string
  height?: number | string
  scripts?: ChartScript[]
  /** Called when a script fails to compile/run (also toasts). */
  onScriptError?: (id: string, err: Error) => void
  onScriptReady?: (id: string) => void
  /** Market tick size — used by the fallback chart's price axis. */
  tickSize?: number
}

type VelaModule = typeof import('@luxalgo/vela')
type PineModule = typeof import('@luxalgo/vela-pinets')

let libsPromise: Promise<{ vela: VelaModule; pine: PineModule }> | null = null
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([import('@luxalgo/vela'), import('@luxalgo/vela-pinets')]).then(([vela, pine]) => ({
      vela,
      pine,
    }))
    libsPromise.catch(() => {
      libsPromise = null
    })
  }
  return libsPromise
}

/**
 * Vela chart wrapper. Every call into Vela is guarded; on an unrecoverable
 * failure the component swaps to `FallbackChart` so the page never breaks.
 */
export function VelaChart({ symbol, tf, height = 520, scripts = [], onScriptError, onScriptReady, tickSize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<VelaType | null>(null)
  const handlesRef = useRef(new Map<string, { handle: IndicatorHandle; source: string; offs: (() => void)[] }>())
  const [failed, setFailed] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const { theme } = useTheme()
  const cbRef = useRef({ onScriptError, onScriptReady })
  useEffect(() => {
    cbRef.current = { onScriptError, onScriptReady }
  })

  // ---- create / destroy the chart once -------------------------------------
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handles = handlesRef.current
    let cancelled = false
    let chart: VelaType | null = null

    loadLibs()
      .then(({ vela, pine }) => {
        if (cancelled) return
        try {
          chart = new vela.Vela(el, {
            symbol: `delta:${symbol}`,
            timeframe: deltaToVelaTf(tf),
            live: true,
            theme,
            height,
            volume: true,
            animations: { intro: false, liveBar: false },
          })
          try {
            chart.data.registerProvider('delta', deltaProvider)
          } catch (e) {
            throw new Error(`registerProvider failed: ${(e as Error).message}`)
          }
          try {
            chart.registerEngine('pine', new pine.PineEngine({ props: 'none' }))
          } catch (e) {
            console.warn('[vela] registerEngine failed', e)
            toastExternal('warn', 'Pine engine unavailable', (e as Error).message)
          }
          chartRef.current = chart
          if (import.meta.env.DEV) (window as unknown as { __vnChart?: VelaType }).__vnChart = chart
          const offStart = chart.on('load:start', () => setLoading(true))
          const offEnd = chart.on('load:end', () => setLoading(false))
          chart
            .ready()
            .then(() => {
              if (!cancelled) {
                setReady(true)
                setLoading(false)
              }
            })
            .catch((e: unknown) => {
              if (cancelled) return
              console.error('[vela] ready() rejected', e)
              setFailed((e as Error)?.message ?? 'chart failed to load')
            })
          // load safety valve: if nothing arrives in 20 s, drop the spinner but keep the chart
          const t = window.setTimeout(() => setLoading(false), 20_000)
          ;(chart as unknown as { __off?: () => void }).__off = () => {
            offStart()
            offEnd()
            window.clearTimeout(t)
          }
        } catch (e) {
          console.error('[vela] init failed', e)
          const msg = (e as Error)?.message ?? String(e)
          setFailed(msg)
          toastExternal('error', 'Chart failed to initialise — using fallback', msg)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        console.error('[vela] import failed', e)
        setFailed(`library load failed: ${(e as Error)?.message ?? e}`)
      })

    return () => {
      cancelled = true
      const c = chartRef.current ?? chart
      chartRef.current = null
      for (const { offs } of handles.values()) offs.forEach((f) => f())
      handles.clear()
      if (c) {
        try {
          ;(c as unknown as { __off?: () => void }).__off?.()
          c.destroy()
        } catch (e) {
          console.warn('[vela] destroy failed', e)
        }
      }
      try {
        el.innerHTML = ''
      } catch {
        /* ignore */
      }
    }
    // Chart is created once per mount; market/theme/scripts are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- market switch ---------------------------------------------------------
  const marketRef = useRef({ symbol, tf })
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !ready) return
    if (marketRef.current.symbol === symbol && marketRef.current.tf === tf) return
    marketRef.current = { symbol, tf }
    // `loading` is driven by Vela's own load:start / load:end events.
    try {
      chart.setMarket({ symbol: `delta:${symbol}`, timeframe: deltaToVelaTf(tf) }).catch((e: unknown) => {
        console.error('[vela] setMarket failed', e)
        toastExternal('error', 'Failed to switch market', (e as Error)?.message)
        setLoading(false)
      })
    } catch (e) {
      console.error('[vela] setMarket threw', e)
      toastExternal('error', 'Failed to switch market', (e as Error)?.message)
    }
  }, [symbol, tf, ready])

  // ---- theme ------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    try {
      chart.setTheme(theme)
    } catch (e) {
      console.warn('[vela] setTheme failed', e)
    }
  }, [theme, ready])

  // ---- scripts diff -------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !ready) return
    const want = new Map(scripts.map((s) => [s.id, s]))
    const have = handlesRef.current

    // remove
    for (const [id, entry] of Array.from(have.entries())) {
      if (!want.has(id)) {
        entry.offs.forEach((f) => f())
        try {
          if (typeof entry.handle.remove === 'function') entry.handle.remove()
          else entry.handle.setVisible(false)
        } catch (e) {
          console.warn('[vela] remove indicator failed', e)
        }
        have.delete(id)
      }
    }
    // add / update
    for (const s of want.values()) {
      const existing = have.get(s.id)
      if (existing) {
        if (existing.source !== s.source) {
          try {
            existing.handle.updateCode(s.source)
            existing.source = s.source
          } catch (e) {
            console.warn('[vela] updateCode failed', e)
            toastExternal('error', `Script update failed: ${s.title}`, (e as Error)?.message)
          }
        }
        continue
      }
      try {
        const handle = chart.addIndicator(s.source, {
          id: `vn:${s.id}`,
          language: 'pine',
          overlay: s.overlay ?? true,
          title: s.title,
        })
        const offs: (() => void)[] = []
        try {
          offs.push(
            handle.on('error', ({ error }) => {
              console.warn(`[pine] ${s.title}:`, error)
              toastExternal('error', `Script error: ${s.title}`, error?.message)
              cbRef.current.onScriptError?.(s.id, error)
            }),
          )
          offs.push(handle.on('ready', () => cbRef.current.onScriptReady?.(s.id)))
        } catch (e) {
          console.warn('[vela] handle.on failed', e)
        }
        have.set(s.id, { handle, source: s.source, offs })
      } catch (e) {
        console.error('[vela] addIndicator failed', e)
        const err = e instanceof Error ? e : new Error(String(e))
        toastExternal('error', `Cannot add script: ${s.title}`, err.message)
        cbRef.current.onScriptError?.(s.id, err)
      }
    }
  }, [scripts, ready])

  if (failed) return <FallbackChart symbol={symbol} tf={tf} height={height} reason={failed} tickSize={tickSize} />

  return (
    <div className="vela-wrap" style={{ height }}>
      <div ref={containerRef} className="vela-container" />
      {loading && (
        <div className="vela-loading" role="status">
          <span className="pulse-dot" aria-hidden /> loading {symbol} · {tf}
        </div>
      )}
    </div>
  )
}
