import './verification.css'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { compareChart, type ChartObservation } from '../../../shared/chartVerification'
import { fmtDateTime } from '../lib/format'

function Check({ observation: o }: { observation: ChartObservation }) {
  const q = useQuery({
    queryKey: ['chart-receipt', o.scannerId, o.symbol, o.tf, o.barTime],
    queryFn: () => api.chartReceipt(o.scannerId, o.symbol, o.tf),
    staleTime: 15000,
    refetchInterval: (query) =>
      query.state.data?.barTime === o.barTime ||
      (query.state.data?.barTime && query.state.data.barTime > o.barTime) ||
      query.state.dataUpdateCount >= 20
        ? false
        : 15000,
  })
  const result = compareChart(o, q.data ?? null)
  return (
    <tr>
      <td data-label="Scanner / closed bar">
        {o.scannerId} · {o.tf}
        <br />
        {fmtDateTime(o.barTime)}
      </td>
      <td data-label="Comparison">
        {q.isError ? 'Server comparison unavailable' : q.isLoading ? 'Loading server bar…' : result.status}
        {!!result.differences.length && <div className="loss">{result.differences.join(', ')}</div>}
      </td>
      <td data-label="Server signals">
        {q.data?.barTime === o.barTime
          ? q.data.signals.map((s) => `${s.kind} ${s.side ?? ''} · ${s.label}`).join('; ') ||
            'No entry or exit extracted on this bar'
          : 'Awaiting the matching scan'}
      </td>
    </tr>
  )
}
export function SignalChecks({ observations }: { observations: ChartObservation[] }) {
  return (
    <section
      className="panel chart-section"
      style={{ padding: 12 }}
      aria-label="Chart versus bot signal checks"
    >
      <h3>Chart versus bot · closed-bar checks</h3>
      <p className="small muted">
        Advisory only. Compares named plots and shapes with the existing server scan, using source, inputs,
        timezone and history checks. Alert-only, label and strategy-ledger channels are not fully exposed by
        this check and remain unverified. No evidence or admission settings change.
      </p>
      {!observations.length ? (
        <p>Select a scanner and wait for a complete chart run. Forming-bar ticks are excluded.</p>
      ) : (
        <div className="table-scroll">
          <table className="table evidence-table">
            <thead>
              <tr>
                <th>Scanner / closed bar</th>
                <th>Comparison</th>
                <th>Server signals before entry gates</th>
              </tr>
            </thead>
            <tbody>
              {observations.map((o) => (
                <Check key={`${o.scannerId}:${o.tf}`} observation={o} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
