import { useState } from 'react'
import { useTapeAudit } from '../api/queries'
import { Empty, Panel, Time } from './ui'
import { fmtPrice } from '../lib/format'

const n1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '–' : v.toFixed(d))
const tone = (v: number | null | undefined) => (v === null || v === undefined ? '' : v > 0.5 ? 'loss' : v < -0.5 ? 'gain' : '')

/**
 * Decision 187: how far the paper's fills sit from Delta's real prints. Positive slippage means the tape was worse
 * than the paper assumed. Stops read the prints right after the first trade through the stop level; market fills read
 * the 3 s after the fill; resting limits record the volume traded at their price before price went through.
 */
export function TapeAuditPanel() {
  const [days, setDays] = useState(14)
  const q = useTapeAudit(days)
  const d = q.data
  return (
    <Panel
      title="Paper fills against the tape"
      right={
        <select className="select select-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {[1, 7, 14, 30, 90].map((x) => <option key={x} value={x}>{x === 1 ? 'last day' : `last ${x} days`}</option>)}
        </select>
      }
    >
      {!d ? (
        <p className="muted small">{q.isError ? 'The server did not answer /api/tape-audit.' : 'Loading…'}</p>
      ) : d.fills.length === 0 && d.limits.length === 0 ? (
        <Empty label="No fills audited yet." hint="Each paper fill is compared with the next few seconds of Delta trades; rows appear after the first fill." />
      ) : (
        <>
          <p className="muted small">Slippage in basis points of price and in R of each trade's stop; positive means the real prints were worse than the paper fill.</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Book</th><th>Fill</th><th className="num">Fills</th><th className="num">No prints</th><th className="num">Median bps</th><th className="num">Mean bps</th><th className="num">p90 bps</th><th className="num">Mean R</th></tr></thead>
              <tbody>
                {d.fills.map((f) => (
                  <tr key={f.book + f.kind}>
                    <td>{f.book}</td><td>{f.kind}</td><td className="num mono">{f.n}</td><td className="num mono">{f.noPrints}</td>
                    <td className={`num mono ${tone(f.medianBps)}`}>{n1(f.medianBps)}</td><td className={`num mono ${tone(f.meanBps)}`}>{n1(f.meanBps)}</td>
                    <td className="num mono">{n1(f.p90Bps)}</td><td className="num mono">{n1(f.meanR, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.limits.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Book</th><th className="num">Resting limits</th><th className="num">Filled on paper</th><th className="num">Price touched</th><th className="num">Price went through</th><th className="num">Median volume at the limit before through</th></tr></thead>
                <tbody>
                  {d.limits.map((l) => (
                    <tr key={l.book}>
                      <td>{l.book}</td><td className="num mono">{l.n}</td><td className="num mono">{l.filled}</td><td className="num mono">{l.touched}</td><td className="num mono">{l.through}</td><td className="num mono">{n1(l.medianVolBeforeThrough, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary className="small">Latest {d.recent.length} rows</summary>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>When</th><th>Book</th><th>Symbol</th><th>TF</th><th>Fill</th><th className="num">Paper</th><th className="num">Tape</th><th className="num">Worst</th><th className="num">Prints</th><th className="num">bps</th><th className="num">R</th></tr></thead>
                <tbody>
                  {d.recent.map((r) => (
                    <tr key={r.id}>
                      <td><Time t={r.at} mode="datetime" /></td><td>{r.book === 0 ? 'account' : 'shadow'}</td><td className="mono">{r.symbol}</td><td>{r.tf ?? ''}</td>
                      <td title={r.extra ? JSON.stringify(r.extra) : ''}>{r.kind}</td>
                      <td className="num mono">{fmtPrice(r.paper_price)}</td><td className="num mono">{fmtPrice(r.tape_price)}</td><td className="num mono">{fmtPrice(r.worst_print)}</td>
                      <td className="num mono">{r.prints ?? '–'}</td><td className={`num mono ${tone(r.slip_bps)}`}>{n1(r.slip_bps)}</td><td className="num mono">{n1(r.slip_r, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Panel>
  )
}
