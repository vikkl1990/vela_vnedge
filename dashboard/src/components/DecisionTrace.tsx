import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Panel, Time, Loading, ErrorState } from './ui'

export function DecisionTrace() {
  const q = useQuery({queryKey:['decision-trace'],queryFn:api.decisionTrace,refetchInterval:15000,retry:1})
  const dollars = (v: number | undefined) => v === undefined ? '—' : `$${v.toFixed(2)}`
  return <Panel title="Paper decision trace">
    <p className="small muted">Latest 100 events, newest first. Budgets are captured at fill; rejected entries have no filled budget. Exit fee estimates use standard taker fees. Funding and exit impact are not included. This panel is independent of the signal filters below.</p>
    {q.isLoading && <Loading rows={2}/>}
    {q.isError && <ErrorState error={q.error} onRetry={()=>q.refetch()}/>}
    {q.data && <div className="table-wrap" style={{maxHeight:360,overflow:'auto'}}><table className="table table-dense">
      <thead><tr><th>Time / market</th><th>Decision</th><th>Notional / risk</th><th>Entry / estimated exit fee</th></tr></thead>
      <tbody>{q.data.map(r=><tr key={r.id}>
        <td><Time t={r.at}/><div>{r.symbol} · {r.tf}</div><div className="small muted">{r.scanner_id}</div></td>
        <td>{r.stage}<div className="small">{r.reason}</div><div className="small muted">Signal {r.signal_id??'—'} · Position {r.position_id??'—'}</div></td>
        <td>{dollars(r.snapshot.notional)} / {dollars(r.snapshot.risk)}</td>
        <td>{dollars(r.snapshot.entryFee)} / {dollars(r.snapshot.standardExitFeeAtEntry)}{r.snapshot.offerConfigured&&<div className="small muted">{r.snapshot.offerEligibility==='enrollment-recorded'?'Enrollment recorded; timing checked per close':'Enrollment unverified · full fees apply'}</div>}</td>
      </tr>)}</tbody>
    </table>{q.data.length===0&&<p>No recorded events yet. Earlier trades are not backfilled.</p>}</div>}
  </Panel>
}
