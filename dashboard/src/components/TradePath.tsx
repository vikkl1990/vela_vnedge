import { useEffect, useMemo, useRef } from 'react'
import { usePositionPath } from '../api/queries'
import type { PathPoint } from '../api/types'
import { Loading, Pill } from './ui'
import { fmtPrice } from '../lib/format'

/** Events worth a marker on the chart; everything else is a routine sample. */
const EVENT_COLOR: Record<string, string> = {
  tp1: 'var(--gain)', tp2: 'var(--gain)', tp3: 'var(--gain)',
  sl: 'var(--loss)', liquidation: 'var(--loss)', reversal: 'var(--warn)',
  be: 'var(--accent-3)', 'stop moved': 'var(--accent-3)', script_exit: 'var(--warn)', manual: 'var(--muted)',
}
const colorOf = (e: string | null) => (e ? EVENT_COLOR[e] ?? 'var(--muted)' : 'var(--muted)')
const mins = (a: number, b: number) => Math.round((b - a) / 60000)

/**
 * A trade's path from entry to exit: result in R over time, the stop as it moved, and every level
 * event. Answers the question a closed row cannot — was it in profit before it died, and when.
 */
export function TradePath({ id, title, onClose }: { id: number | null; title?: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const q = usePositionPath(id)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (id != null && !d.open) d.showModal()
    if (id == null && d.open) d.close()
  }, [id])

  const path: PathPoint[] = q.data?.path ?? []
  const chart = useMemo(() => {
    if (path.length < 2) return null
    const w = 640, h = 220, pad = 28
    const t0 = path[0].at, t1 = path[path.length - 1].at || t0 + 1
    const rs = path.map(p => p.r)
    const lo = Math.min(-1.2, ...rs), hi = Math.max(1.2, ...rs)
    const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2)
    const y = (r: number) => h - pad - ((r - lo) / Math.max(0.01, hi - lo)) * (h - pad * 2)
    const peak = path.reduce((a, p) => (p.r > a.r ? p : a), path[0])
    return { w, h, pad, x, y, lo, hi, peak, line: path.map(p => `${x(p.at)},${y(p.r)}`).join(' ') }
  }, [path])

  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} onCancel={onClose}>
      <h3>{title ?? `Position #${id}`} · path</h3>
      {q.isLoading && <Loading />}
      {!q.isLoading && path.length < 2 && (
        <div className="dialog-body muted">
          No path recorded for this trade. The engine started recording on 25 September; trades that closed
          before it only have their result.
        </div>
      )}
      {chart && (
        <div className="dialog-body">
          <svg viewBox={`0 0 ${chart.w} ${chart.h}`} className="path-chart" role="img" aria-label="result in R over time">
            {[0, 1, -1].filter(r => r >= chart.lo && r <= chart.hi).map(r => (
              <g key={r}>
                <line x1={chart.pad} x2={chart.w - chart.pad} y1={chart.y(r)} y2={chart.y(r)} className={r === 0 ? 'axis-zero' : 'axis-grid'} />
                <text x={4} y={chart.y(r) + 4} className="axis-label">{r > 0 ? `+${r}R` : `${r}R`}</text>
              </g>
            ))}
            <polyline points={chart.line} className="path-line" />
            {path.filter(p => p.event).map((p, i) => (
              <g key={i}>
                <circle cx={chart.x(p.at)} cy={chart.y(p.r)} r={4} fill={colorOf(p.event)} />
                <title>{`${p.event}${p.note ? ' · ' + p.note : ''} · ${p.r.toFixed(2)}R`}</title>
              </g>
            ))}
            <circle cx={chart.x(chart.peak.at)} cy={chart.y(chart.peak.r)} r={5} className="path-peak" />
            <text x={chart.x(chart.peak.at) + 8} y={chart.y(chart.peak.r) - 6} className="axis-label">
              peak {chart.peak.r.toFixed(2)}R · {mins(path[0].at, chart.peak.at)}m
            </text>
          </svg>

          <table className="mini-table">
            <thead><tr><th>+min</th><th>price</th><th>R</th><th>stop</th><th>event</th></tr></thead>
            <tbody>
              {path.filter(p => p.event).map((p, i) => (
                <tr key={i}>
                  <td className="mono">{mins(path[0].at, p.at)}m</td>
                  <td className="mono">{fmtPrice(p.price)}</td>
                  <td className="mono">{p.r >= 0 ? '+' : ''}{p.r.toFixed(2)}R</td>
                  <td className="mono muted">{p.sl == null ? '—' : fmtPrice(p.sl)}</td>
                  <td><Pill tone={p.event === 'sl' || p.event === 'liquidation' ? 'danger' : p.event?.startsWith('tp') ? 'ok' : 'muted'}>{p.event}</Pill>{p.note ? <span className="muted small"> {p.note}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{path.length} samples · one a minute plus every level event</p>
        </div>
      )}
      <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </dialog>
  )
}
