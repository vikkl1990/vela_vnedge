import { fmtDateTime, fmtPrice } from '../lib/format'
import { useFillComparison } from './fillEvidence'
const bps = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} bps`)
export function FillComparisons({ id }: { id: number }) {
  const q = useFillComparison(id)
  return (
    <section className="panel" style={{ padding: 12 }} aria-label="Tick and depth fill comparison">
      <h3>Recorded fills versus tick and depth evidence</h3>
      <p className="small muted">
        Depth is reconstructed from the saved execution book. Public prints are a price benchmark, not a fill
        guarantee. Positive difference means the benchmark price is worse than the recorded fill. Missing
        observations remain unverified.
      </p>
      {q.isError ? (
        <p role="alert">
          Fill comparison unavailable.{' '}
          <button className="btn" onClick={() => void q.refetch()}>
            Retry
          </button>
        </p>
      ) : q.isLoading ? (
        <p>Loading fill evidence…</p>
      ) : !q.data?.fills?.length ? (
        <p>No recorded fills for this trade.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Fill</th>
                <th>Recorded</th>
                <th>Saved depth</th>
                <th>Public tape</th>
              </tr>
            </thead>
            <tbody>
              {q.data.fills.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.reason} · {f.side} · {f.qty}
                    <br />
                    {fmtDateTime(f.at)}
                    <br />
                    <span className="small muted">
                      {f.source ?? 'Source unknown'}
                      {f.maker && ` · ${f.maker}`}
                    </span>
                  </td>
                  <td>{fmtPrice(f.price)}</td>
                  <td>
                    {f.depth.price === null ? '—' : fmtPrice(f.depth.price)} · {bps(f.depth.deltaBps)}
                    <br />
                    {f.depth.status}
                    {f.depth.receivedAt !== null && (
                      <div className="small muted">Observed {fmtDateTime(f.depth.receivedAt)}</div>
                    )}
                  </td>
                  <td>
                    First {f.tape.first === null ? '—' : fmtPrice(f.tape.first)} · VWAP{' '}
                    {f.tape.vwap === null ? '—' : fmtPrice(f.tape.vwap)}
                    <br />
                    {bps(f.tape.deltaBps)} · {f.tape.status}
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
