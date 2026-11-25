import './verification.css'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { ParityScanner } from '../../../shared/chartVerification'
import { fmtDateTime } from '../lib/format'

const VERDICT: Record<ParityScanner['verdict'], { label: string; className: string }> = {
  diverges: { label: 'Diverges', className: 'loss' },
  agrees: { label: 'Agrees', className: 'gain' },
  unverified: { label: 'Unverified', className: 'muted' },
}

/**
 * Chart versus bot, per scanner. Built from closed-bar checks recorded whenever a chart runs a
 * scanner; the server recomputes each verdict against its own scan of the same bar. Diagnostic only.
 */
export function ParityReport() {
  const [days, setDays] = useState(7)
  const q = useQuery({
    queryKey: ['parity', days],
    queryFn: () => api.parityReport(days),
    refetchInterval: 60_000,
  })
  const rows = q.data?.scanners ?? []
  return (
    <section
      className="panel chart-section"
      style={{ padding: 12 }}
      aria-label="Chart versus bot parity report"
    >
      <h3>Chart versus bot · parity by scanner</h3>
      <p className="small muted">
        Each row counts closed bars where a chart ran the scanner and the bot scanned the same bar. Only bars
        with the same source, inputs, timezone and candle history are comparable; the rest are listed by
        reason. Checks accumulate while charts are open. Advisory only: no evidence or admission setting
        changes.
      </p>
      <label className="small">
        Window{' '}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30].map((d) => (
            <option key={d} value={d}>
              {d === 1 ? 'last day' : `last ${d} days`}
            </option>
          ))}
        </select>
      </label>
      {q.isError ? (
        <p className="loss">Parity report unavailable.</p>
      ) : q.isLoading ? (
        <p>Loading…</p>
      ) : !rows.length ? (
        <p>
          No checks recorded yet. Open a scanner on the Chart page and wait for a closed bar the bot has
          scanned.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table evidence-table">
            <thead>
              <tr>
                <th>Scanner</th>
                <th>Verdict</th>
                <th>Comparable · agreed · differed</th>
                <th>Not comparable</th>
                <th>Last difference</th>
                <th>Last check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.scannerId}>
                  <td data-label="Scanner">
                    <Link to={`/scanners/${s.scannerId}`} className="link strong">
                      {s.scannerId}
                    </Link>
                    <div className="muted small">
                      {s.cells} cell{s.cells === 1 ? '' : 's'} · {s.checks} check{s.checks === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td data-label="Verdict" className={VERDICT[s.verdict].className}>
                    {VERDICT[s.verdict].label}
                  </td>
                  <td data-label="Comparable · agreed · differed" className="mono">
                    {s.comparable} · {s.agreed} ·{' '}
                    <span className={s.differed ? 'loss' : ''}>{s.differed}</span>
                  </td>
                  <td data-label="Not comparable" className="small">
                    {Object.entries(s.notComparable)
                      .map(([reason, n]) => `${n} ${reason}`)
                      .join('; ') || '—'}
                  </td>
                  <td data-label="Last difference" className="small">
                    {s.lastDifference ? (
                      <>
                        {s.lastDifference.symbol} {s.lastDifference.tf} ·{' '}
                        {fmtDateTime(s.lastDifference.barTime)}
                        <div className="loss">{s.lastDifference.outputs.join(', ')}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Last check" className="small">
                    {fmtDateTime(s.lastAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
