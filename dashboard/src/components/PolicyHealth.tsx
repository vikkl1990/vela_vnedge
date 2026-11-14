import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Panel, ErrorState, Loading } from './ui'
import { fmtMoney } from '../lib/format'
import { Link } from 'react-router-dom'
import { useHealth } from '../api/queries'

/** Keep operational faults visible even while the full evidence table is collapsed. */
export function PolicyHealthStatus() {
  const health = useHealth()
  const q = useQuery({ queryKey: ['policy-health'], queryFn: api.policyHealth, refetchInterval: 60_000 })
  if (!q.data) return q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <p className="muted small">Loading execution reliability…</p>
  const d = q.data
  const quarantined = d.books.reduce((n, b) => n + b.quarantined, 0)
  return <div className={`banner small ${d.boundExits.failures || health.data?.attention?.length ? 'banner-warn' : ''}`} role="status">
    <b>Evidence quality</b> · {quarantined} historical trades quarantined from evidence in the last {d.windowDays} days.
    <span className={d.boundExits.failures ? 'loss' : 'muted'}> {d.boundExits.failures} held positions with archived-exit errors.</span>
    {(health.data?.attention ?? []).map(item => <span key={item.key} className="loss"> {item.text} · <Link to={item.href}>Inspect</Link></span>)}
    <span className="muted"> Policy versions and reserved margin: <Link to="/incubator?section=operations#incubator-evidence">evidence details</Link>.</span>
  </div>
}

export function PolicyHealthPanel() {
  const q = useQuery({ queryKey: ['policy-health'], queryFn: api.policyHealth, refetchInterval: 60_000 })
  return <Panel title="Evidence & execution reliability">
    {q.isPending && <Loading rows={2} />}
    {q.error && <ErrorState error={q.error} />}
    {q.data && <>
      {q.data.boundExits.failures > 0 && <p className="loss">{q.data.boundExits.failures} archived scanner exit runs failed. Price stops remain active; inspect scanner execution before changing its rules.</p>}
      <p className="small muted">Last {q.data.windowDays} days. Matching means the current scanner source and trade rules. Historical results remain in the journal; only matching evidence supports promotion and leverage.</p>
      <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr>
        <th>Book</th><th>Matching</th><th>Changed rules</th><th>Legacy / unknown</th><th>Quarantined</th><th>Resting orders</th><th>Reserved margin</th>
      </tr></thead><tbody>{q.data.books.map(b => <tr key={b.book}>
        <td>{b.book === 'paper' ? 'Paper account' : 'Shadow research'}</td><td>{b.matching}</td><td>{b.changed}</td><td>{b.legacy}</td><td>{b.quarantined}</td><td>{b.pending}</td><td>{b.book === 'paper' ? fmtMoney(b.reservedMargin) : 'Independent cells'}</td>
      </tr>)}</tbody></table></div>
      <p className="small muted">{q.data.books.reduce((n, b) => n + b.adoptedOpen, 0)} existing positions/orders adopted at migration; their original settings are unknown. {q.data.haltEvents} recorded loss-limit events in this window.</p>
      <p className="small muted">Paper entries ready in the same {q.data.allocation.widthMs} ms window are ordered consistently. Risk and available margin are checked at admission.</p>
      <p className="small">Live readiness still needs forward profitability and exchange lifecycle certification. Execution replay cannot reconstruct missing historical depth or order queues.</p>
    </>}
  </Panel>
}
