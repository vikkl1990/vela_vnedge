import {useQuery} from '@tanstack/react-query'
import {Link} from 'react-router-dom'
import {api} from '../api/client'
import {Panel, QueryState, Pill, Time} from './ui'
const money=(v:number|null|undefined)=>v==null?'—':`$${v.toFixed(2)}`
const pct=(v:number|null|undefined)=>v==null?'—':`${(v*100).toFixed(1)}%`

const stopLabel=(variant:string)=>variant==='native'?'Scanner stop; ATR fallback':variant==='atr'?'ATR stop':'Current stop policy'
export function ExecutionPlans() {
  const q=useQuery({queryKey:['execution-plans'],queryFn:api.executionPlans,refetchInterval:30000})
  return <Panel title="Execution plan comparisons" right={<Pill>Shadow research</Pill>}>
    <p className="small muted">One scanner signal, separate stop and take-profit plans. Fixed reference equity, account margin sizing and full fees. These are independent experiments; totals are not a portfolio return. Account promotion remains separate.</p>
    <QueryState {...q} data={q.data} onRetry={()=>q.refetch()} empty="Plan comparisons unavailable.">{d=><>
      {d.configured.length===0&&<p>No comparison plans configured.</p>}
      {(d.comparisons??[]).map(c=><div key={c.group} style={{marginBottom:20}}>
        <strong>{c.symbol} {c.tf} · Profit-capture comparison</strong> <Pill>{c.enabled?'Forward paper test':'Disabled'}</Pill>
        <p className="small">{c.controlLabel}: {money(c.controlNet)} · {c.candidateLabel}: {money(c.candidateNet)} <span className="muted">closed net, current policy versions</span></p>
        <p className="small">{c.sharedSignals} shared source signals · {c.unresolvedSignals} awaiting outcomes · {c.differentAdmissions} with different fill status · {c.controlOnly+c.candidateOnly} seen by only one policy.</p>
        <p className="small">Both trades closed on {c.matchedClosed} matched signals · candidate difference {money(c.matchedDeltaNet)}.</p>
        <p className="small muted">The matched subset excludes unfilled and unfinished trades. Assess it alongside each plan’s full net result, missed entries and drawdown. A historical improvement is not forward proof.</p>
      </div>)}
      <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Market / plan</th><th>Signals → placed → filled → closed</th><th>Open / pending</th><th>Net / fees</th><th>Average win / loss</th><th>Win rate / break-even rate</th><th>Average R / stops</th><th>Realized drawdown</th><th>Evidence / blockers</th></tr></thead><tbody>
        {d.configured.filter(p=>!d.cohorts.some(c=>c.id===p.id&&c.signature===p.signature)).map(p=><tr key={p.id}><td>{p.symbol} {p.tf}<div>{p.scannerName}</div>{p.label&&<strong>{p.label}</strong>}<div>{stopLabel(p.variant)} · v{p.revision}</div><div className="small muted" style={{maxWidth:320,whiteSpace:'normal'}}>{p.takeProfitLabel}</div></td><td>0 → 0 → 0 → 0</td><td>0 / 0</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>{!p.enabled?'Disabled':p.sourceStatus!=='ok'?`Source ${p.sourceStatus}`:'Waiting for a fresh source signal'}<div className="small muted">{p.lastSourceBar?`Source bar: ${new Date(p.lastSourceBar).toISOString().replace('T',' ').slice(0,16)} UTC`:'No completed source scan recorded'}</div><div className="small muted">Reference equity {money(p.referenceEquity)}{p.maxStopLossPct!==undefined&&` · at most ${p.maxStopLossPct}% modeled stop risk`}</div></td></tr>)}
        {d.cohorts.map(c=><tr key={`${c.id}:${c.signature}`}><td>{c.symbol} {c.tf}<div>{c.scannerName}</div>{c.label&&c.label!==c.id&&<strong>{c.label}</strong>}<div>{stopLabel(c.variant)} · v{c.revision}</div><div className="small muted" style={{maxWidth:320,whiteSpace:'normal'}}>{c.takeProfitLabel}</div><div className="small muted" title={c.signature}>{c.signature.slice(0,8)}{!d.configured.some(p=>p.enabled&&p.id===c.id&&p.signature===c.signature)&&' · previous cohort'}</div></td>
          <td>{c.signals} → {c.placed} → {c.filled} → {c.closed}</td><td>{c.open} / {c.pending}</td><td className={c.net<0?'neg':c.net>0?'pos':''}>{money(c.net)} / {money(c.fees)}</td><td>{money(c.avgWin)} / {money(c.avgLoss)}<div className="small muted">{c.payoffRatio==null?'Both wins and losses needed':`${c.payoffRatio.toFixed(2)}× payoff`}</div></td><td title="Break-even win rate uses observed average net wins and losses. It is descriptive, not a forecast.">{pct(c.winRate)} / {pct(c.breakEvenWinRate)}</td><td>{c.avgR==null?'—':`${c.avgR.toFixed(2)}R`} / {c.stops}</td><td>{money(c.drawdown)}</td>
          <td className="small"><div>{money(c.margin)} target margin · {c.leverage}× base · {money(c.referenceEquity)} reference equity</div>{c.maxStopLossPct>0&&<div>At most {c.maxStopLossPct}% modeled stop risk; gaps can exceed it</div>}<div>Collecting evidence · no automatic promotion</div><details><summary>{Object.values(c.reasons).reduce((n,v)=>n+v,0)} recorded decision reasons</summary>{Object.entries(c.reasons).map(([r,n])=><div key={r}>{n} × {r}</div>)}</details><div>{c.positionIds.map(id=><Link key={id} to={`/trades/${id}/replay`} className="link" style={{marginRight:8}}>#{id} replay</Link>)}</div></td></tr>)}
      </tbody></table></div>
      <p className="small muted">Net and fees include closed trades only. Open positions are shown separately. Historical depth and funding coverage still limit backtests; prospective orders use the live feeds.</p>
    </>}</QueryState>
  </Panel>
}

export function CostAudit() {
  const q=useQuery({queryKey:['execution-plans'],queryFn:api.executionPlans,refetchInterval:30000})
  return <Panel title="Paper execution costs">
    <QueryState {...q} data={q.data} onRetry={()=>q.refetch()} empty="Cost audit unavailable.">{({costs:d})=><>
      <p className="small muted">{d.offer==='unverified-full-fees'?'Fee waiver enrollment is unverified: new closes pay full fees.':d.offer==='exchange-verified'?'Delta API verified enrollment; eligible new closing fills receive the waiver.':d.offer==='enrollment-recorded'?'Fee offer enrollment is recorded; each closing fill still checks its timing and exclusions.':'Fee waiver is off: full fees apply.'} Historical booked results are preserved.</p>
      {d.effectiveFrom!==null&&<p className="small">Applies to entries from <Time t={d.effectiveFrom} mode="full" />. BTC/ETH: 30 minutes; other eligible futures: 15 minutes. Entry fees remain payable. BTC fee vouchers are separate credits and are not booked as profit.</p>}
      <p className="small muted">Latest 30 account positions. Break-even is the original full quantity plus standard exit commission; it excludes future funding and exit impact. Funding below is recorded funding. Price shortfall is already included in trade P&amp;L—do not subtract it again.</p>
      {!d.rows.length && <p className="muted small">No account positions are available for this fee audit yet.</p>}
      <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Position</th><th>Entry / notional</th><th>Entry fee</th><th>Exit fee estimate / paid</th><th>Funding cost</th><th>Initial break-even</th><th>Observed price shortfall</th></tr></thead><tbody>{d.rows.map(r=><tr key={r.id}>
        <td><Link to={`/trades/${r.id}/replay`}>#{r.id} · {r.symbol} {r.tf}</Link><div className="small muted">{r.status} · {r.scannerId}</div></td><td>{r.entryLiquidity}<div>{money(r.notional)}</div></td><td>{money(r.entryFee)}</td><td>{money(r.estimatedExitFee)} / {money(r.exitFees)}{r.waivedCloses>0&&<div className="small muted">{r.waivedCloses} eligible waived fills · {money(r.waivedFees)} saved</div>}</td><td>{money(r.fundingCost)}</td><td>{r.breakEvenPrice?.toLocaleString(undefined,{maximumFractionDigits:6})??'Not recorded'}</td><td>{money(r.priceShortfall)}<div className="small muted">{Math.round(r.priceCoverage*100)}% of fills have a reference</div></td>
      </tr>)}</tbody></table></div>
    </>}</QueryState>
  </Panel>
}
