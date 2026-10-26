import { useAllocationAudit } from '../api/queries'
import { Panel, ErrorState, Loading, Time } from './ui'
import { fmtMoney } from '../lib/format'
const r = (v: number) => `${v>=0?'+':''}${v.toFixed(2)}R`
const n = (v: number | null, suffix='') => v==null?'–':`${v.toFixed(1)}${suffix}`
export function AllocationAuditPanel() {
 const q=useAllocationAudit(),d=q.data
 return <>
 <Panel title="Current 1h allocations · entry audit">
 <p className="small muted">Exact currently scheduled scanner + pair + timeframe. Recent seven days versus the preceding seven, grouped by entry date. Account and shadow are separate. Historical settings may differ; small samples do not justify disabling a scanner. Gross R includes recorded funding before fees.</p>
 {q.isLoading&&!d&&<Loading rows={3}/>}{q.isError&&<ErrorState error={q.error} onRetry={()=>q.refetch()}/>}
 {d&&<div className="table-scroll"><table><thead><tr><th>Scanner / pair</th><th>Account recent / prior</th><th>Account gross / fees</th><th>SL / within 1 bar</th><th>Shadow recent / prior</th><th>Historical cohorts</th><th>Assessment</th></tr></thead><tbody>{d.rows.map(x=><tr key={`${x.scannerId}:${x.symbol}:${x.tf}`}><td>{x.scannerName}<div className="mono muted">{x.symbol} · {x.tf}</div></td><td>{r(x.account.recent.netR)} ({x.account.recent.n}) / {r(x.account.prior.netR)} ({x.account.prior.n})</td><td>{r(x.account.recent.grossR)} / {r(x.account.recent.feeR)}</td><td>{x.account.recent.stops} / {x.account.recent.firstBarStops}</td><td>{r(x.shadow.recent.netR)} ({x.shadow.recent.n}) / {r(x.shadow.prior.netR)} ({x.shadow.prior.n})</td><td>{x.account.recent.cohorts} account · {x.shadow.recent.cohorts} shadow</td><td>{x.verdict}</td></tr>)}</tbody></table>{!d.rows.length&&<p className="muted">No active 1h allocations.</p>}</div>}
 </Panel>
 <Panel title="Entry execution observations · prospective">
 <p className="small muted">Quotes and fees are recorded at paper entry. Expected exit fee assumes a taker exit at entry notional, without a promotion. Depth is requested after entry; its lag is shown and it was not available to that entry decision. Incomplete coverage is not a full-size fill estimate.</p>
 {d&&<div className="table-scroll"><table><thead><tr><th>Entry</th><th>Market / book</th><th>Source</th><th>Quote spread</th><th>Entry / expected exit fee</th><th>Signal delay</th><th>Depth state / lag</th><th>Coverage</th><th>Depth impact</th></tr></thead><tbody>{d.execution.map(x=><tr key={x.position_id}><td>#{x.position_id}<div><Time t={x.entry_at}/></div></td><td>{x.symbol} {x.tf}<div className="muted">{x.book===0?'account':'shadow'}</div></td><td>{x.source??'unknown'}</td><td>{n(x.spread_bps,' bps')}<div className="muted">{x.quote_at==null?'quote age unknown':`${Math.max(0,x.entry_at-x.quote_at)} ms old`}</div></td><td>{fmtMoney(x.entry_fee)} / {fmtMoney(x.expected_exit_fee)}</td><td>{n(x.signal_delay_ms,' ms')}</td><td>{x.depth_state}<div>{n(x.depth_lag_ms,' ms')}</div></td><td>{x.depth_coverage==null?'–':`${(x.depth_coverage*100).toFixed(0)}%`}</td><td>{x.depth_coverage===1?n(x.depth_impact_bps,' bps'):'–'}</td></tr>)}</tbody></table>{!d.execution.length&&<p className="muted">Collecting new entries from deployment onward. Historical snapshots are not reconstructed.</p>}</div>}
 </Panel>
 </>
}
