import { useEffect, useMemo, useRef, useState } from 'react'
import { useCandles } from '../api/queries'
import type { Candle } from '../api/types'
import { fmtPrice, fmtTime } from '../lib/format'
import { sseBus } from '../sse/bus'
import { useTheme } from '../lib/theme'

/**
 * Minimal canvas candlestick chart used when Vela cannot initialise (WebGL
 * missing, library error, …). Pulls candles from /api/candles and applies live
 * SSE `candle` events. Not interactive beyond a hover crosshair.
 */
export function FallbackChart({
  symbol,
  tf,
  height = 520,
  reason,
  tickSize,
}: {
  symbol: string
  tf: string
  height?: number | string
  reason?: string | null
  tickSize?: number
}) {
  const { data, isLoading, isError, error } = useCandles(symbol, tf, 300)
  // Live bars received over SSE for the current symbol/tf, merged on top of the query data.
  const [live, setLive] = useState<{ key: string; bars: Candle[] }>({ key: '', bars: [] })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Candle | null>(null)
  const { theme } = useTheme()
  const key = `${symbol}:${tf}`

  const bars = useMemo(() => {
    const base = data ?? []
    if (live.key !== key || !live.bars.length) return base
    const out = base.slice()
    for (const b of live.bars) {
      const last = out[out.length - 1]
      if (!last || b.time > last.time) out.push(b)
      else if (last.time === b.time) out[out.length - 1] = b
    }
    return out.slice(-600)
  }, [data, live, key])

  useEffect(() => {
    return sseBus.on('candle', (e) => {
      if (e.symbol !== symbol || e.tf !== tf) return
      setLive((prev) => {
        const list = prev.key === key ? prev.bars : []
        const last = list[list.length - 1]
        if (last && last.time === e.bar.time) return { key, bars: [...list.slice(0, -1), e.bar] }
        if (!last || e.bar.time > last.time) return { key, bars: [...list.slice(-200), e.bar] }
        return prev
      })
    })
  }, [symbol, tf, key])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const draw = () => {
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const dark = theme === 'dark'
      ctx.fillStyle = dark ? '#0b0b0f' : '#ffffff'
      ctx.fillRect(0, 0, w, h)
      if (!bars.length) return
      const padR = 64
      const padB = 22
      const padT = 8
      const plotW = w - padR
      const plotH = h - padB - padT
      const n = bars.length
      const cw = plotW / n
      let lo = Infinity
      let hi = -Infinity
      for (const b of bars) {
        if (b.low < lo) lo = b.low
        if (b.high > hi) hi = b.high
      }
      if (!(hi > lo)) {
        hi = lo + 1
      }
      const range = hi - lo
      const y = (p: number) => padT + (1 - (p - lo) / range) * plotH
      // grid
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'
      ctx.fillStyle = dark ? '#8b8b93' : '#666'
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.lineWidth = 1
      for (let i = 0; i <= 5; i++) {
        const p = lo + (range * i) / 5
        const yy = y(p)
        ctx.beginPath()
        ctx.moveTo(0, yy)
        ctx.lineTo(plotW, yy)
        ctx.stroke()
        ctx.fillText(fmtPrice(p, tickSize), plotW + 6, yy + 4)
      }
      // candles
      const up = 'hsl(136 39% 45%)'
      const dn = 'hsl(7 80% 55%)'
      for (let i = 0; i < n; i++) {
        const b = bars[i]
        const x = i * cw + cw / 2
        const c = b.close >= b.open ? up : dn
        ctx.strokeStyle = c
        ctx.fillStyle = c
        ctx.beginPath()
        ctx.moveTo(x, y(b.high))
        ctx.lineTo(x, y(b.low))
        ctx.stroke()
        const bw = Math.max(1, cw * 0.6)
        const top = y(Math.max(b.open, b.close))
        const bh = Math.max(1, Math.abs(y(b.open) - y(b.close)))
        ctx.fillRect(x - bw / 2, top, bw, bh)
      }
      // time labels
      ctx.fillStyle = dark ? '#8b8b93' : '#666'
      const step = Math.max(1, Math.floor(n / 6))
      for (let i = 0; i < n; i += step) {
        ctx.fillText(fmtTime(bars[i].time), i * cw, h - 6)
      }
      // hover
      if (hover) {
        const i = bars.indexOf(hover)
        if (i >= 0) {
          const x = i * cw + cw / 2
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.moveTo(x, padT)
          ctx.lineTo(x, padT + plotH)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [bars, hover, theme, tickSize])

  const onMove = (e: React.MouseEvent) => {
    const wrap = wrapRef.current
    if (!wrap || !bars.length) return
    const rect = wrap.getBoundingClientRect()
    const x = e.clientX - rect.left
    const plotW = rect.width - 64
    const i = Math.floor((x / plotW) * bars.length)
    setHover(bars[Math.max(0, Math.min(bars.length - 1, i))] ?? null)
  }

  return (
    <div className="fallback-chart" style={{ height }}>
      <div className="fallback-chart-bar">
        <span className="pill pill-warn">Fallback chart</span>
        <span className="muted mono small">
          {symbol} · {tf}
          {reason ? ` · Vela unavailable: ${reason}` : ''}
        </span>
        {hover && (
          <span className="mono small">
            O {fmtPrice(hover.open, tickSize)} H {fmtPrice(hover.high, tickSize)} L {fmtPrice(hover.low, tickSize)} C {fmtPrice(hover.close, tickSize)}
          </span>
        )}
      </div>
      <div ref={wrapRef} className="fallback-chart-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {isLoading && <div className="state-overlay">Loading candles…</div>}
        {isError && <div className="state-overlay error">Candles unavailable: {error?.message}</div>}
        {!isLoading && !isError && bars.length === 0 && <div className="state-overlay">No candles</div>}
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
