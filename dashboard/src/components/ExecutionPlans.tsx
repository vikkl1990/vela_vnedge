import {useQuery} from '@tanstack/react-query'
import {Link} from 'react-router-dom'
import {api} from '../api/client'
import {Panel, QueryState, Pill} from './ui'
const money=(v:number|null|undefined)=>v==null?'—':`$${v.toFixed(2)}`

export function ExecutionPlans() {
  const q=useQuery({queryKey:['execution-plans'],queryFn:api.executionPlans,refetchInterval:30000})
  return <Panel title="Execution plan comparisons" right={<Pill>Shadow research</Pill>}>
    <p className="small muted">One scanner signal, separate current / native / ATR plans. Fixed reference equity, account margin sizing and full fees. These are independent experiments; totals are not a portfolio return. Account promotion remains separate.</p>
    <QueryState {...q} data={q.data} onRetry={()=>q.refetch()} empty="Plan comparisons unavailable.">{d=><>
      {d.configured.length===0&&<p>No comparison plans configured.</p>}
      <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Market / plan</th><th>Signals → placed → filled → closed</th><th>Open / pending</th><th>Net / fees</th><th>Average R / stops</th><th>Realized drawdown</th><th>Evidence / blockers</th></tr></thead><tbody>
        {d.configured.filter(p=>!d.cohorts.some(c=>c.id===p.id&&c.signature===p.signature)).map(p=><tr key={p.id}><td>{p.symbol} {p.tf}<div>{p.variant} · v{p.revision}</div></td><td>0 → 0 → 0 → 0</td><td>0 / 0</td><td>—</td><td>—</td><td>—</td><td>{!p.enabled?'Disabled':p.sourceStatus!=='ok'?`Source ${p.sourceStatus}`:'Waiting for a fresh source signal'}<div className="small muted">{p.lastSourceBar?`Source bar: ${new Date(p.lastSourceBar).toISOString().replace('T',' ').slice(0,16)} UTC`:'No completed source scan recorded'}</div><div className="small muted">Reference equity {money(p.referenceEquity)}</div></td></tr>)}
        {d.cohorts.map(c=><tr key={`${c.id}:${c.signature}`}><td>{c.symbol} {c.tf}<div>{c.variant} · v{c.revision}</div><div className="small muted" title={c.signature}>{c.signature.slice(0,8)}{!d.configured.some(p=>p.enabled&&p.id===c.id&&p.signature===c.signature)&&' · previous cohort'}</div></td>
          <td>{c.signals} → {c.placed} → {c.filled} → {c.closed}</td><td>{c.open} / {c.pending}</td><td className={c.net<0?'neg':c.net>0?'pos':''}>{money(c.net)} / {money(c.fees)}</td><td>{c.avgR==null?'—':`${c.avgR.toFixed(2)}R`} / {c.stops}</td><td>{money(c.drawdown)}</td>
          <td className="small"><div>{money(c.margin)} target margin · {c.leverage}× base · {money(c.referenceEquity)} reference equity</div><div>Collecting evidence · no automatic promotion</div><details><summary>{Object.values(c.reasons).reduce((n,v)=>n+v,0)} recorded decision reasons</summary>{Object.entries(c.reasons).map(([r,n])=><div key={r}>{n} × {r}</div>)}</details><div>{c.positionIds.map(id=><Link key={id} to={`/trades/${id}/replay`} className="link" style={{marginRight:8}}>#{id} replay</Link>)}</div></td></tr>)}
      </tbody></table></div>
      <p className="small muted">Net and fees include closed trades only. Open positions are shown separately. Historical depth and funding coverage still limit backtests; prospective orders use the live feeds.</p>
    </>}</QueryState>
  </Panel>
}

export function CostAudit() {
  const q=useQuery({queryKey:['execution-plans'],queryFn:api.executionPlans,refetchInterval:30000})
  return <Panel title="Paper execution costs">
    <QueryState {...q} data={q.data} onRetry={()=>q.refetch()} empty="Cost audit unavailable.">{({costs:d})=><>
      <p className="small muted">{d.offer==='unverified-full-fees'?'Fee waiver enrollment is unverified: new closes pay full fees.':d.offer==='enrollment-recorded'?'Fee offer enrollment is recorded; each closing fill still checks its timing and exclusions.':'Fee waiver is off: full fees apply.'} Historical booked results are preserved.</p>
      <p className="small muted">Latest 30 account positions. Break-even is the original full quantity plus standard exit commission; it excludes future funding and exit impact. Funding below is recorded funding. Price shortfall is already included in trade P&amp;L—do not subtract it again.</p>
      <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Position</th><th>Entry / notional</th><th>Entry fee</th><th>Exit fee estimate / paid</th><th>Funding cost</th><th>Initial break-even</th><th>Observed price shortfall</th></tr></thead><tbody>{d.rows.map(r=><tr key={r.id}>
        <td><Link to={`/trades/${r.id}/replay`}>#{r.id} · {r.symbol} {r.tf}</Link><div className="small muted">{r.status} · {r.scannerId}</div></td><td>{r.entryLiquidity}<div>{money(r.notional)}</div></td><td>{money(r.entryFee)}</td><td>{money(r.estimatedExitFee)} / {money(r.exitFees)}{r.waivedCloses>0&&<div className="small muted">{r.waivedCloses} eligible waived fills</div>}</td><td>{money(r.fundingCost)}</td><td>{r.breakEvenPrice?.toLocaleString(undefined,{maximumFractionDigits:6})??'Not recorded'}</td><td>{money(r.priceShortfall)}<div className="small muted">{Math.round(r.priceCoverage*100)}% of fills have a reference</div></td>
      </tr>)}</tbody></table></div>
    </>}</QueryState>
  </Panel>
}
