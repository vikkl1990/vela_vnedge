import type { ExecutionHandoff } from '../api/types'
import { Panel, Pill, Time } from './ui'

const labels = { pending: 'Waiting', dispatching: 'Dispatching', delivered: 'Reconciled / ledger', cancelled: 'Cancelled', blocked: 'Rejected' } as const

export function ExecutionHandoffPanel({ handoff }: { handoff?: ExecutionHandoff }) {
  if (!handoff) return null
  return <Panel title="Execution handoff" right={<span className="muted small">{handoff.scope}</span>}>
    <p className="small">{handoff.pending} waiting · {handoff.delivered} reconciled or handed to the order ledger · {handoff.cancelled} cancelled · {handoff.blocked} rejected</p>
    <p className="muted small">Waiting commands survive a restart. A ledger handoff does not confirm a fill; check the order ledger and exchange protection below.</p>
    {handoff.oldest !== null && <p className="small">Oldest waiting command: <Time t={handoff.oldest} mode="ago" />. Unsent entries expire after their configured dispatch window; exits keep waiting for reconciliation.</p>}
    {!handoff.recent.length ? <p className="muted small">No exchange commands recorded in this environment.</p> : <div className="table-wrap"><table className="table">
      <thead><tr><th>when</th><th>position</th><th>market</th><th>intent</th><th className="num">contracts</th><th>handoff</th><th>note</th></tr></thead>
      <tbody>{handoff.recent.map(c=><tr key={c.id}>
        <td><Time t={c.updatedAt} mode="ago" /></td><td className="mono">#{c.positionId}</td><td>{c.symbol}</td><td>{c.side} · {c.reason}</td>
        <td className="num mono">{c.qty}</td><td><Pill tone={c.state==='blocked'?'danger':c.state==='pending'||c.state==='dispatching'?'warn':'muted'}>{labels[c.state]}</Pill></td>
        <td className="small muted">{c.note ?? '—'}</td>
      </tr>)}</tbody>
    </table></div>}
  </Panel>
}
