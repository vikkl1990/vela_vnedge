import {useResearchFilters} from '../lib/useResearchFilters'
import {choice} from '../lib/researchNavigation'
import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Link} from 'react-router-dom'
import {api} from '../api/client'
import {ErrorState,Pill} from './ui'
import {timeAgo} from '../lib/format'
import {filterReadiness,ROLE_LABELS} from '../lib/scannerReadiness'
import type {ReadinessRow} from '../../../shared/scannerContracts'

export function ScannerReadinessMatrix(){
  const q=useQuery({queryKey:['scanner-readiness'],queryFn:api.scannerReadiness,staleTime:60_000,refetchInterval:60_000})
  const {params,set}=useResearchFilters()
  const search=params.get('readinessQ')??''
  const scope=choice(params.get('readinessScope'),['all','paper','shadow','research','review','held'],'all')
  const [page,setPage]=useState(0),[selected,setSelected]=useState<ReadinessRow|null>(null)
  const detail=useQuery({queryKey:['scanner-contract',selected?.scannerId,selected?.planId],queryFn:()=>api.scannerContract(selected!.scannerId,selected?.planId),enabled:!!selected,staleTime:60_000})
  if(!q.data)return q.isError?<ErrorState error={q.error} onRetry={()=>q.refetch()}/>:<p aria-busy="true">Loading contracts and current scan coverage…</p>
  const d=q.data,rows=filterReadiness(d.rows,search,scope),pageNo=Math.min(page,Math.max(0,Math.ceil(rows.length/15)-1)),visible=rows.slice(pageNo*15,pageNo*15+15)
  const current=d.rows.find(r=>r.key===selected?.key)
  return <section className="contribution-panel" aria-label="Scanner contract readiness">
    <div className="contribution-heading"><div><h2>Intent, implementation and evidence.</h2><p className="muted">Read-only registry · updated {timeAgo(d.at)} · activity over 24 hours</p></div><button className="btn" onClick={()=>{void q.refetch();if(selected)void detail.refetch()}} disabled={q.isFetching}>Refresh readiness</button></div>
    {q.isError&&<ErrorState error={q.error} onRetry={()=>q.refetch()}/>}
    <div className="contribution-kpis"><div><strong>{d.summary.scanners}</strong><span>Enabled / shadow scanners</span></div><div><strong>{d.summary.plans}</strong><span>Independent research profiles</span></div><div><strong>{d.summary.sourceMatched}</strong><span>Source-matched reviews</span></div><div><strong>{d.summary.reviewNeeded}</strong><span>Have review gaps</span></div></div>
    <p className="contribution-note">A review gap is not automatically a trading block. “Collecting” means a recent scan on at least one cell. Eligibility remains with the existing evidence rules.</p>
    <div className="contribution-controls"><label>Scope<select className="input" value={scope} onChange={e=>{set({readinessScope:e.target.value});setPage(0)}}><option value="all">All active profiles</option><option value="paper">Enabled for paper</option><option value="shadow">Shadow / trackers</option><option value="research">Research plans</option><option value="review">Review gaps</option><option value="held">Runtime holds</option></select></label><label className="contribution-search">Find scanner or pair<input className="input" placeholder="Name, family or symbol…" value={search} onChange={e=>{set({readinessQ:e.target.value},true);setPage(0)}}/></label></div>
    <div className="contribution-table-wrap"><table className="contribution-table"><thead><tr><th>Scanner / intent</th><th>Contract & reader</th><th>Scan coverage</th><th>Activity · 24h</th><th>Review / runtime gaps</th></tr></thead><tbody>{visible.map(r=><tr key={r.key} className={selected?.key===r.key?'selected':''}>
      <td><button className="contribution-name" onClick={()=>setSelected(selected?.key===r.key?null:r)} aria-expanded={selected?.key===r.key}>{r.name}</button><span className="contribution-sub">{r.author} · {ROLE_LABELS[r.contract.role]}</span><Pill tone={r.planId?'accent':'muted'}>{r.planId?'Research only':r.enabled?'Paper enabled':'Shadow / tracker'}</Pill></td>
      <td>{r.contract.adapter}<span className="contribution-sub">Source review: {r.contract.sourceStatus} · reader {r.contract.reader}</span><span className="contribution-sub">{r.profiles.matching} matching cell probes</span><code>{r.contract.contractVersion.slice(0,10)}</code></td>
      <td><Pill tone={r.runtime==='held'?'danger':r.runtime==='collecting'?'ok':'muted'}>{r.runtime}</Pill><span className="contribution-sub">{r.cells.filter(c=>c.state==='scanned').length} / {r.cells.length} cells scanned recently</span><span className="contribution-sub">{[...new Set(r.cells.map(c=>c.tf))].join(' · ')||'No allocated pairs'}</span></td>
      <td>{r.activity.signals} signals · {r.activity.fills} filled positions<span className="contribution-sub">{r.activity.pending} pending from this window</span><span className="contribution-sub">{r.planId?'Exact current cohort':'Mixed historical readings'}</span></td>
      <td>{r.runtimeReasons.length>0&&<span className="contribution-sub negative">{r.runtimeReasons.join('; ')}</span>}{r.contract.gaps.slice(0,2).map(g=><span className="contribution-sub" key={g}>{g}</span>)}<button className="btn btn-xs" onClick={()=>setSelected(r)}>Inspect contract{r.contract.gaps.length>2?` · ${r.contract.gaps.length} gaps`:''}</button></td>
    </tr>)}</tbody></table></div>
    {!rows.length&&<p>No profiles match this filter.</p>}
    <div className="contribution-pagination"><button className="btn btn-xs" disabled={pageNo===0} onClick={()=>setPage(pageNo-1)}>Previous</button><span>{rows.length?`${pageNo*15+1}–${Math.min(rows.length,pageNo*15+15)} of ${rows.length}`:'0 results'}</span><button className="btn btn-xs" disabled={(pageNo+1)*15>=rows.length} onClick={()=>setPage(pageNo+1)}>Next</button></div>
    {selected&&<div className="contribution-detail"><div className="contribution-heading"><h3>{selected.name}</h3><button className="btn btn-xs" onClick={()=>setSelected(null)}>Close contract</button></div>
      <div className="contribution-links"><Link className="btn btn-xs" to={`/scanners/${selected.scannerId}`}>Scanner settings & source</Link><Link className="btn btn-xs" to={`/incubator?q=${encodeURIComponent(selected.scannerId)}`}>Evidence & promotion</Link></div>
      {!current&&<p>This allocation is no longer in the current matrix.</p>}
      {current&&<><p>{current.policy.promotion}</p><p className="muted">{current.activity.scope}</p><details open><summary>Every allocated cell ({current.cells.length})</summary><div className="contribution-observations">{current.cells.map(c=><div key={`${c.book}:${c.symbol}:${c.tf}`}><strong>{c.symbol} · {c.tf} · {c.book}</strong><span>{c.state} · {c.lastAt?timeAgo(c.lastAt):'No recorded scan'}</span>{c.reason&&<span>{c.reason}</span>}</div>)}</div></details>
      {Object.keys(current.activity.reasons).length>0&&<details open><summary>Recorded entry decisions</summary><ul>{Object.entries(current.activity.reasons).sort((a,b)=>b[1]-a[1]).map(([reason,n])=><li key={reason}>{n} × {reason}</li>)}</ul></details>}
      {current.policy.signature&&<p className="mono small">Policy {current.policy.signature} · execution v{current.policy.executionVersion??'unknown'} · partial exits v{current.policy.partialExitVersion??'not selected'} · reversal v{current.policy.reversalEntryVersion??'not selected'}</p>}</>}
      {detail.isError&&<ErrorState error={detail.error} onRetry={()=>detail.refetch()}/>}{detail.isPending&&<p>Loading source-pinned contract…</p>}
      {detail.data&&<><p>{detail.data.summary.intent}</p><p className="muted">Source reviewed {detail.data.sourceReviewedAt??'not reviewed'} · publication reviewed {detail.data.publicationReviewedAt??'not reviewed'}</p><p>Implemented: {detail.data.summary.capabilities.join(' · ')||'No verified adapter listed'}</p>
        {!!detail.data.summary.gaps.length&&<ul>{detail.data.summary.gaps.map(g=><li key={g}>{g}</li>)}</ul>}
        {detail.data.variant&&<p>Separate reading of {detail.data.variant.base}: {detail.data.variant.reason}</p>}
        {detail.data.url&&<a className="link" href={detail.data.url} target="_blank" rel="noreferrer">Author publication</a>}
        <details><summary>Author conditions, stops, targets and timing</summary><pre>{JSON.stringify(detail.data.author,null,2)}</pre></details>
        <details><summary>Effective reader and execution policy</summary><pre>{JSON.stringify({reading:detail.data.reading,policy:detail.data.policy},null,2)}</pre></details>
        <details><summary>Source versions and data dependencies</summary><pre>{JSON.stringify({source:detail.data.summary.sourceHash,runtime:detail.data.summary.runtimeHash,contract:detail.data.summary.contractVersion,dependencies:detail.data.dependencies,cautions:detail.data.cautions},null,2)}</pre></details>
        {!!detail.data.historicalNotes.length&&<details><summary>Historical audit notes (may predate current adapter)</summary>{detail.data.historicalNotes.map(n=><p key={n}>{n}</p>)}</details>}
      </>}
    </div>}
    <details className="contribution-method"><summary>How readiness is measured</summary>{d.notes.map(n=><p key={n}>{n}</p>)}</details>
  </section>
}
