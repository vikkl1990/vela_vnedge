import { useState } from 'react'
import type { Candle, Position } from '../api/types'
import { fmtDateTime, fmtPrice } from '../lib/format'

/** A scanner's entry signal on a bar: filled arrow when it opened a trade, hollow when a rule refused it. */
export interface CanvasMarker {
  time: number
  side: 'long' | 'short'
  opened: boolean
  title: string
}

/** Compact price workspace. Chart observations are never an execution simulator. */
export function MarketCanvas({
  bars,
  positions,
  symbol,
  tickSize,
  markers = [],
  height = 340,
  candles = 100,
  livePrice,
}: {
  bars: Candle[]
  positions: Position[]
  symbol: string
  tickSize?: number
  markers?: CanvasMarker[]
  /** viewBox height; the width stays 900 and the SVG scales to its box */
  height?: number
  candles?: number
  /** the live price, drawn as a tagged line on the axis */
  livePrice?: number | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const data = bars.filter((b) => [b.open, b.high, b.low, b.close, b.time].every(Number.isFinite)).slice(-candles)
  if (!data.length)
    return <div className="terminal-empty">No candles available for this market and timeframe.</div>
  const width = 900,
    left = 12,
    right = 78,
    top = 25,
    bottom = 34
  const lo = Math.min(...data.map((b) => b.low)),
    hi = Math.max(...data.map((b) => b.high))
  const pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * 0.0001, 0.0000001),
    min = lo - pad,
    max = hi + pad
  const dx = (width - left - right) / data.length
  const x = (i: number) => left + dx * (i + 0.5)
  const y = (v: number) => top + ((max - v) / (max - min)) * (height - top - bottom)
  const b = data[hover === null ? data.length - 1 : Math.min(hover, data.length - 1)]
  // each marker sits on the bar it was raised on: under the low for a long, over the high for a short
  const index = new Map(data.map((v, i) => [v.time, i]))
  const placed = markers
    .map((m) => ({ ...m, i: index.get(m.time) }))
    .filter((m): m is CanvasMarker & { i: number } => m.i !== undefined)
  const last = livePrice ?? data[data.length - 1].close
  const lastUp = last >= data[data.length - 1].open
  const levels = positions
    .flatMap((p) => [
      { value: p.entryPrice, text: `#${p.id} Entry`, color: 'var(--accent-2)' },
      ...(p.sl == null ? [] : [{ value: p.sl, text: `#${p.id} SL`, color: 'var(--loss)' }]),
      ...p.tp.flatMap((price, i) =>
        price != null && !p.tpHit[i] && (p.legs?.[i] ?? 0) > 0
          ? [{ value: price, text: `#${p.id} TP${i + 1}`, color: 'var(--gain)' }]
          : [],
      ),
    ])
    .filter((l) => l.value >= min && l.value <= max)
  return (
    <div className="market-canvas">
      <div className="candle-readout mono">
        <span>{fmtDateTime(b.time)}</span>
        <span>O {fmtPrice(b.open, tickSize)}</span>
        <span>H {fmtPrice(b.high, tickSize)}</span>
        <span>L {fmtPrice(b.low, tickSize)}</span>
        <b className={b.close >= b.open ? 'gain' : 'loss'}>C {fmtPrice(b.close, tickSize)}</b>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${symbol}, ${data.length} price candles. Open position levels in the visible range.`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setHover(
            Math.max(
              0,
              Math.min(
                data.length - 1,
                Math.floor((((e.clientX - rect.left) / rect.width) * width - left) / dx),
              ),
            ),
          )
        }}
      >
        <title>{symbol} price candles</title>
        {Array.from({ length: 5 }, (_, i) => {
          const v = min + ((max - min) * i) / 4
          return (
            <g key={i}>
              <line x1={left} x2={width - right} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text x={width - right + 10} y={y(v) + 4} className="canvas-axis">
                {fmtPrice(v, tickSize)}
              </text>
            </g>
          )
        })}
        {data.map((v, i) => (
          <g
            key={v.time}
            stroke={v.close >= v.open ? 'var(--gain)' : 'var(--loss)'}
            fill={v.close >= v.open ? 'var(--gain)' : 'var(--loss)'}
          >
            <line x1={x(i)} x2={x(i)} y1={y(v.high)} y2={y(v.low)} strokeWidth="1" />
            <rect
              x={x(i) - dx * 0.3}
              y={y(Math.max(v.open, v.close))}
              width={dx * 0.6}
              height={Math.max(1, Math.abs(y(v.open) - y(v.close)))}
              strokeWidth="0"
            />
          </g>
        ))}
        {levels.map((l, i) => (
          <g key={`${l.text}-${i}`}>
            <line
              x1={left}
              x2={width - right}
              y1={y(l.value)}
              y2={y(l.value)}
              stroke={l.color}
              strokeDasharray="5 5"
              opacity=".6"
            />
            <text x={left + 7} y={y(l.value) - 5} fill={l.color} fontSize="10">
              {l.text} · {fmtPrice(l.value, tickSize)}
            </text>
          </g>
        ))}
        {placed.map((m, k) => {
          const cx = x(m.i),
            long = m.side === 'long',
            yy = long ? y(data[m.i].low) + 12 : y(data[m.i].high) - 12,
            s = Math.max(4, Math.min(7, dx * 0.45)),
            color = long ? 'var(--gain)' : 'var(--loss)'
          const pts = long
            ? `${cx},${yy - s} ${cx - s},${yy + s} ${cx + s},${yy + s}`
            : `${cx},${yy + s} ${cx - s},${yy - s} ${cx + s},${yy - s}`
          return (
            <polygon
              key={`${m.time}-${k}`}
              points={pts}
              fill={m.opened ? color : 'none'}
              stroke={color}
              strokeWidth={1.2}
              opacity={m.opened ? 1 : 0.65}
              className="canvas-marker"
            >
              <title>{m.title}</title>
            </polygon>
          )
        })}
        {last >= min && last <= max && (
          <g className="canvas-last">
            <line
              x1={left}
              x2={width - right}
              y1={y(last)}
              y2={y(last)}
              stroke={lastUp ? 'var(--gain)' : 'var(--loss)'}
              strokeDasharray="2 3"
              opacity=".8"
            />
            <rect
              x={width - right + 2}
              y={y(last) - 9}
              width={right - 4}
              height={18}
              rx={3}
              fill={lastUp ? 'var(--gain)' : 'var(--loss)'}
            />
            <text x={width - right + 8} y={y(last) + 4} className="canvas-last-text">
              {fmtPrice(last, tickSize)}
            </text>
          </g>
        )}
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={top}
            y2={height - bottom}
            stroke="var(--muted)"
            strokeDasharray="3 4"
          />
        )}
        {[0, Math.floor(data.length / 2), data.length - 1].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 8}
            textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
            className="canvas-axis"
          >
            {fmtDateTime(data[i].time)}
          </text>
        ))}
      </svg>
    </div>
  )
}
