import type { ExecutionStatus } from '../api/types'
import { Panel, Pill } from './ui'
import { fmtInt, fmtMoney, fmtPrice } from '../lib/format'

export function AccountingBadge({pending}:{pending?:boolean}) {
  return pending ? <Pill tone="warn" title="Exchange quantity, price or commission is incomplete. This P&L is provisional.">Accounting pending</Pill> : null
}

export function ExecutionAccountingPanel({data,dryRun}:{data?:ExecutionStatus['accounting'];dryRun?:boolean}) {
  if(!data)return null
  return <Panel title={dryRun?'Simulated fill accounting':'Exchange fill accounting'}>
    <p className="small muted">{data.total} journal fills · {data.incomplete} incomplete. Split fills use their quantity-weighted price and total commission. Until quantities and costs are confirmed, the journal keeps a provisional result.{dryRun?' Dry-run figures are simulated.':''}</p>
    {data.rows.length>0 && <div className="table-wrap"><table className="table"><thead><tr><th>Journal fill</th><th>Market / reason</th><th>Confirmed qty</th><th>Average price</th><th>Commission</th><th>Status</th></tr></thead><tbody>
      {data.rows.map(r=><tr key={r.sourceOrderId}><td className="mono">#{r.sourceOrderId} · position {r.positionId}</td><td>{r.symbol} · {r.reason}</td><td className="mono">{fmtInt(r.confirmedQty)} / {fmtInt(r.expectedQty)}</td><td className="mono">{r.price===null?'Unavailable':fmtPrice(r.price)}</td><td className="mono">{r.fee===null?'Unavailable':fmtMoney(r.fee)}</td><td><Pill tone={r.state==='complete'?'ok':'warn'}>{r.state.replaceAll('-',' ')}</Pill></td></tr>)}
    </tbody></table></div>}
    {data.rows.length>0 && <p className="small muted">Up to 50 fills shown; incomplete first. A complete cash record confirms accounting, not exchange protection.</p>}
  </Panel>
}
