import { useEffect, useMemo, useRef } from 'react'
import { usePositionPath } from '../api/queries'
import type { PathLevels, PathPoint } from '../api/types'
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
  const lv: PathLevels | undefined = q.data?.position
  const chart = useMemo(() => {
    if (path.length < 2 || !lv) return null
    const w = 680, h = 260, padL = 44, padR = 74, padY = 26
    const t0 = path[0].at, t1 = path[path.length - 1].at || t0 + 1
    // every level in R, so the stop, break even and the targets share one axis with the result
    const risk = Math.abs(lv.entryPrice - (lv.slOriginal ?? lv.entryPrice))
    const rOf = (price: number) => (risk > 0 ? ((lv.side === 'long' ? price - lv.entryPrice : lv.entryPrice - price) / risk) : 0)
    const targets = lv.tp.map((p, i) => ({ i, price: p, r: rOf(p), hit: (lv.tpHit?.[i] ?? 0) > 0 }))
    const rs = path.map(p => p.r)
    const lo = Math.min(-1.25, ...rs)
    const hi = Math.max(1.25, ...rs, ...targets.filter(t => t.r <= 8).map(t => t.r))
    const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR)
    const y = (r: number) => h - padY - ((r - lo) / Math.max(0.01, hi - lo)) * (h - padY * 2)
    // the peak the position itself recorded, which sees intra-bar highs the minute samples miss —
    // otherwise the marker and the figure under the chart disagree
    const sampled = path.reduce((a, p) => (p.r > a.r ? p : a), path[0])
    const peak = lv.peakR != null && lv.peakR >= sampled.r
      ? { at: lv.peakAt ?? sampled.at, r: lv.peakR, fromSamples: false }
      : { at: sampled.at, r: sampled.r, fromSamples: true }
    // the stop as it actually stood, stepped: this is the floor and the trail ratcheting
    const stopLine = path.filter(p => p.sl != null).map(p => `${x(p.at)},${y(rOf(p.sl!))}`).join(' ')
    return { w, h, padL, padR, x, y, lo, hi, peak, targets, rOf, stopLine, line: path.map(p => `${x(p.at)},${y(p.r)}`).join(' ') }
  }, [path, lv])

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
            {/* break even and the stop it opened with */}
            <g>
              <line x1={chart.padL} x2={chart.w - chart.padR} y1={chart.y(0)} y2={chart.y(0)} className="axis-zero" />
              <text x={4} y={chart.y(0) + 4} className="axis-label">0R</text>
              <text x={chart.w - chart.padR + 6} y={chart.y(0) + 4} className="axis-label level-be">break even</text>
            </g>
            <g>
              <line x1={chart.padL} x2={chart.w - chart.padR} y1={chart.y(-1)} y2={chart.y(-1)} className="level-stop" />
              <text x={4} y={chart.y(-1) + 4} className="axis-label">−1R</text>
              <text x={chart.w - chart.padR + 6} y={chart.y(-1) + 4} className="axis-label level-stop-label">stop {lv?.slOriginal != null ? fmtPrice(lv.slOriginal) : ''}</text>
            </g>
            {/* the targets, in R, marked when they filled */}
            {chart.targets.filter(t => t.r >= chart.lo && t.r <= chart.hi).map(t => (
              <g key={t.i}>
                <line x1={chart.padL} x2={chart.w - chart.padR} y1={chart.y(t.r)} y2={chart.y(t.r)} className={`level-tp ${t.hit ? 'is-hit' : ''}`} />
                <text x={chart.w - chart.padR + 6} y={chart.y(t.r) + 4} className={`axis-label level-tp-label ${t.hit ? 'is-hit' : ''}`}>
                  TP{t.i + 1} +{t.r.toFixed(1)}R{t.hit ? ' ✓' : ''}
                </text>
              </g>
            ))}
            {chart.stopLine && <polyline points={chart.stopLine} className="path-stop" />}
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
          {!path.some(p => p.event) && <p className="muted small">No level event yet — the violet line is the result, the dashed one the stop as it stands.</p>}
          <p className="muted small">
            {path.length} samples · one a minute plus every level event
            {lv?.peakR != null && ` · peak ${lv.peakR.toFixed(2)}R`}{chart.peak.fromSamples && lv?.peakR != null && ' (intra-bar)'}
            {lv?.worstR != null && ` · worst ${lv.worstR.toFixed(2)}R`}
            {lv?.exitReason && ` · exited ${lv.exitReason}`}
          </p>
        </div>
      )}
      <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </dialog>
  )
}
