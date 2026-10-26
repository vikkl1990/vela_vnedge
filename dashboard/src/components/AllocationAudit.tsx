import { useAllocationAudit, useFundingGuard } from '../api/queries'
import { Panel, ErrorState, Loading, Time } from './ui'
import { fmtMoney } from '../lib/format'
const r = (v: number) => `${v>=0?'+':''}${v.toFixed(2)}R`
const n = (v: number | null, suffix='') => v==null?'–':`${v.toFixed(1)}${suffix}`
export function AllocationAuditPanel() {
 const q=useAllocationAudit(),d=q.data
 const funding=useFundingGuard(),f=funding.data
 return <>
 <Panel title="Upcoming funding · paper protection">
 <p className="small muted">{f?.settings?.enabled?'Protection enabled':'Protection off · observation only'} · Budgets: scalp {f?.settings?.scalpMaxR??0.1}R, swing {f?.settings?.swingMaxR??0.2}R. Configure in Settings → Funding protection. Estimates use the current rate, not a guaranteed settlement rate. Receiving positions show zero payment. Exits require fresh quotes; protection cannot guarantee avoiding a charge during feed or execution failures.</p>
 {f&&!f.executionSupported&&<p className="loss">Automatic funding exits unavailable with exchange execution attached.</p>}
 {funding.isError&&<ErrorState error={funding.error} onRetry={()=>funding.refetch()}/>}
 {funding.isLoading&&<Loading rows={2}/>}
 {f&&<div className="table-wrap"><table className="table table-dense"><thead><tr><th>Position / book</th><th>Market</th><th>Settlement</th><th>Rate</th><th>Expected payment</th><th>Budget</th><th>Status</th></tr></thead><tbody>{f.positions.map(p=><tr key={`${p.book}:${p.id}`}><td>#{p.id} · {p.book}</td><td>{p.symbol} {p.tf} · {p.side}</td><td>{p.nextAt?<Time t={p.nextAt}/>: 'Unknown'}</td><td>{p.ratePct==null?'–':`${p.ratePct.toFixed(4)}%`}</td><td>{p.cost==null?'–':fmtMoney(p.cost)} / {p.costR==null?'–':r(p.costR)}</td><td>{r(p.limitR)}</td><td>{!p.fresh?'Funding missing / stale':!p.enabled?'Observe only':p.trigger?'Exit due · awaiting fresh quote / scheduler':p.near?'Within settlement window':'Monitoring'}</td></tr>)}</tbody></table>{!f.positions.length&&<p className="muted">No open paper positions.</p>}</div>}
 </Panel>
 <Panel title="Current 1h allocations · entry audit">
 <p className="small muted">Exact currently scheduled scanner + pair + timeframe. Recent seven days versus the preceding seven, grouped by entry date. Account and shadow are separate. Historical settings may differ; small samples do not justify disabling a scanner. Gross R includes recorded funding before fees.</p>
 {q.isLoading&&!d&&<Loading rows={3}/>}{q.isError&&<ErrorState error={q.error} onRetry={()=>q.refetch()}/>}
 {d&&<div className="table-wrap"><table className="table table-dense"><thead><tr><th>Scanner / pair</th><th>Account recent / prior</th><th>Account gross / fees</th><th>SL / within 1 bar</th><th>Shadow recent / prior</th><th>Historical cohorts</th><th>Assessment</th></tr></thead><tbody>{d.rows.map(x=><tr key={`${x.scannerId}:${x.symbol}:${x.tf}`}><td>{x.scannerName}<div className="mono muted">{x.symbol} · {x.tf}</div></td><td>{r(x.account.recent.netR)} ({x.account.recent.n}) / {r(x.account.prior.netR)} ({x.account.prior.n})</td><td>{r(x.account.recent.grossR)} / {r(x.account.recent.feeR)}</td><td>{x.account.recent.stops} / {x.account.recent.firstBarStops}</td><td>{r(x.shadow.recent.netR)} ({x.shadow.recent.n}) / {r(x.shadow.prior.netR)} ({x.shadow.prior.n})</td><td>{x.account.recent.cohorts} account · {x.shadow.recent.cohorts} shadow</td><td>{x.verdict}</td></tr>)}</tbody></table>{!d.rows.length&&<p className="muted">No active 1h allocations.</p>}</div>}
 </Panel>
 <Panel title="Entry execution observations · prospective">
 <p className="small muted">Quotes and fees are recorded at paper entry. Expected exit fee assumes a taker exit at entry notional, without a promotion. Depth is requested after entry; its lag is shown and it was not available to that entry decision. Incomplete coverage is not a full-size fill estimate.</p>
 {d&&<div className="table-wrap"><table className="table table-dense"><thead><tr><th>Entry</th><th>Market / book</th><th>Source</th><th>Quote spread</th><th>Entry / expected exit fee</th><th>Signal delay</th><th>Depth state / lag</th><th>Coverage</th><th>Depth impact</th></tr></thead><tbody>{d.execution.map(x=><tr key={x.position_id}><td>#{x.position_id}<div><Time t={x.entry_at}/></div></td><td>{x.symbol} {x.tf}<div className="muted">{x.book===0?'account':'shadow'}</div></td><td>{x.source??'unknown'}</td><td>{n(x.spread_bps,' bps')}<div className="muted">{x.quote_at==null?'quote age unknown':`${Math.max(0,x.entry_at-x.quote_at)} ms old`}</div></td><td>{fmtMoney(x.entry_fee)} / {fmtMoney(x.expected_exit_fee)}</td><td>{n(x.signal_delay_ms,' ms')}</td><td>{x.depth_state}<div>{n(x.depth_lag_ms,' ms')}</div></td><td>{x.depth_coverage==null?'–':`${(x.depth_coverage*100).toFixed(0)}%`}</td><td>{x.depth_coverage===1?n(x.depth_impact_bps,' bps'):'–'}</td></tr>)}</tbody></table>{!d.execution.length&&<p className="muted">Collecting new entries from deployment onward. Historical snapshots are not reconstructed.</p>}</div>}
 </Panel>
 </>
}
