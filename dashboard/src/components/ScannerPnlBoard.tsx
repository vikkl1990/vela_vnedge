import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fmtPnl, fmtR } from '../lib/format'

export interface ScannerPnlRow {
  id: string
  name: string
  /** Net USD after fees. */
  pnl: number
  trades: number
  winRatePct: number
  /** Average R per trade; the R view shows avgR × trades. */
  avgR: number
}

type Metric = 'usd' | 'r'

/**
 * PnL by scanner as a ranked board: one readable row per scanner, a bar diverging from a zero line, the best and worst
 * shown and the near-zero middle folded into one line. Replaces the vertical bar chart whose 80 rotated labels could not
 * be read. The R view sums R per scanner, so sizing (decision 144) cannot hide which signals pay.
 */
export function ScannerPnlBoard({ rows, show = 8 }: { rows: ScannerPnlRow[]; show?: number }) {
  const [metric, setMetric] = useState<Metric>('usd')
  const [all, setAll] = useState(false)
  const fmt = (v: number) => (metric === 'usd' ? fmtPnl(v, 0) : fmtR(v))

  const view = useMemo(() => {
    const sorted = [...rows].map((r) => ({ ...r, v: metric === 'usd' ? r.pnl : r.avgR * r.trades })).sort((a, b) => b.v - a.v)
    const up = sorted.filter((r) => r.v > 0), down = sorted.filter((r) => r.v < 0)
    const net = sorted.reduce((s, r) => s + r.v, 0)
    const gains = up.reduce((s, r) => s + r.v, 0)
    const top3 = up.slice(0, 3).reduce((s, r) => s + r.v, 0)
    const maxAbs = Math.max(1e-9, ...sorted.map((r) => Math.abs(r.v)))
    const fold = !all && sorted.length > show * 2 + 1
    const head = fold ? sorted.slice(0, show) : sorted
    const tail = fold ? sorted.slice(-show) : []
    const middle = fold ? sorted.slice(show, sorted.length - show) : []
    return { sorted, up: up.length, down: down.length, net, top3Share: gains > 0 ? top3 / gains : null, maxAbs, head, middle, tail }
  }, [rows, metric, all, show])

  if (!rows.length) return <div className="state muted">No scanner PnL yet.</div>

  const row = (r: ScannerPnlRow & { v: number }, rank: number) => {
    const w = `${(Math.abs(r.v) / view.maxAbs) * 100}%`
    const tone = r.v > 0 ? 'gain' : r.v < 0 ? 'loss' : 'muted'
    return (
      <Link key={r.id} to={`/scanners/${r.id}`} className="pnlb-row" title={`${r.name}: ${fmtPnl(r.pnl)} · ${fmtR(r.avgR * r.trades)} over ${r.trades} trades, ${Math.round(r.winRatePct)}% won`}>
        <span className="pnlb-rank mono muted">{rank}</span>
        <span className="pnlb-name">{r.name}</span>
        <span className="pnlb-track" aria-hidden="true">
          <span className="pnlb-half pnlb-neg">{r.v < 0 && <span className="pnlb-bar pnlb-bar-loss" style={{ width: w }} />}</span>
          <span className="pnlb-half pnlb-pos">{r.v > 0 && <span className="pnlb-bar pnlb-bar-gain" style={{ width: w }} />}</span>
        </span>
        <span className={`pnlb-val mono ${tone}`}>{fmt(r.v)}</span>
        <span className="pnlb-meta mono muted">{r.trades} tr · {Math.round(r.winRatePct)}%</span>
      </Link>
    )
  }

  const mid = view.middle
  const midNet = mid.reduce((s, r) => s + r.v, 0)
  return (
    <div className="pnlb">
      <div className="pnlb-head">
        <span className="small">
          <b className="gain">{view.up}</b> <span className="muted">up</span> · <b className="loss">{view.down}</b> <span className="muted">down</span> · net{' '}
          <b className={`mono ${view.net >= 0 ? 'gain' : 'loss'}`}>{fmt(view.net)}</b>
          {view.top3Share !== null && <span className="muted"> · top 3 carry {Math.round(view.top3Share * 100)}% of the gains</span>}
        </span>
        <span className="segmented" role="group" aria-label="Measure">
          <button type="button" className={`seg ${metric === 'usd' ? 'seg-on' : ''}`} aria-pressed={metric === 'usd'} onClick={() => setMetric('usd')} title="Net dollars after fees">$</button>
          <button type="button" className={`seg ${metric === 'r' ? 'seg-on' : ''}`} aria-pressed={metric === 'r'} onClick={() => setMetric('r')} title="Sum of R: every trade counted at its own risk, so sizing does not tilt the ranking">R</button>
        </span>
      </div>
      <div className="pnlb-list" role="list">
        {view.head.map((r, i) => row(r, i + 1))}
        {mid.length > 0 && (
          <button type="button" className="pnlb-fold" onClick={() => setAll(true)}>
            +{mid.length} more between {fmt(mid[mid.length - 1].v)} and {fmt(mid[0].v)} · net <span className={`mono ${midNet >= 0 ? 'gain' : 'loss'}`}>{fmt(midNet)}</span> · show all
          </button>
        )}
        {view.tail.map((r, i) => row(r, view.sorted.length - view.tail.length + i + 1))}
        {all && view.sorted.length > show * 2 + 1 && (
          <button type="button" className="pnlb-fold" onClick={() => setAll(false)}>Show the best and worst {show} only</button>
        )}
      </div>
    </div>
  )
}
