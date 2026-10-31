import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Link} from 'react-router-dom'
import {api} from '../api/client'
import type {ContributionRow} from '../api/contributions'
import {timeAgo} from '../lib/format'
import {ErrorState, Pill} from './ui'

const topReasons=(r:ContributionRow)=>Object.entries(r.paper.reasons).sort((a,b)=>b[1]-a[1]).slice(0,3)
export function ScannerContributions({compact=false}:{compact?:boolean}){
  const q=useQuery({queryKey:['scanner-contributions'],queryFn:api.scannerContributions,staleTime:60_000,refetchInterval:60_000})
  const [author,setAuthor]=useState('All'),[search,setSearch]=useState(''),[filter,setFilter]=useState('working'),[selected,setSelected]=useState<string|null>(null),[more,setMore]=useState(false),[page,setPage]=useState(0)
  const detail=useQuery({queryKey:['scanner-contribution',selected],queryFn:()=>api.scannerContribution(selected!),enabled:!!selected,staleTime:60_000})
  if(q.isError&&!q.data)return <ErrorState error={q.error} onRetry={()=>q.refetch()}/>
  if(!q.data)return <section className="contribution-panel" aria-busy="true">Loading scanner contribution evidence…</section>
  const d=q.data,term=search.toLowerCase().trim()
  const rows=d.rows.filter(r=>(author==='All'||r.author===author)&&(!term||`${r.name} ${r.id} ${r.author}`.toLowerCase().includes(term))&&(filter==='all'||filter==='working'&&(r.cells.paper+r.cells.shadow+r.cells.candidate+r.cells.tracked>0)||filter==='unverified'&&!r.profiles.matching&&!r.aliasOf&&r.status==='ok'||filter==='context'&&r.entryDisabled||filter==='blocked'&&r.status!=='ok'||filter==='duplicates'&&!!r.aliasOf)).sort((a,b)=>b.cells.paper-a.cells.paper||b.paper.signals-a.paper.signals||b.cells.shadow-a.cells.shadow||a.name.localeCompare(b.name))
  const pageNo=Math.min(page,Math.max(0,Math.ceil(rows.length/20)-1)),visible=rows.slice(pageNo*20,pageNo*20+20),chosen=d.rows.find(r=>r.id===selected)
  const changeAuthor=(value:string)=>{setAuthor(value);setPage(0)}
  return <section className="contribution-panel" id="contributions" aria-label="Scanner contribution ledger">
    <div className="contribution-heading"><div><span className="eyebrow">SCANNER INTELLIGENCE</span><h2>Know what each scanner contributes.</h2><p className="muted">Source → observed output → shadow evidence → paper execution. Updated {timeAgo(d.at)}.</p></div>{compact?<Link className="btn" to="/scanners#contributions">Open contribution ledger</Link>:<button className="btn" onClick={()=>q.refetch()} disabled={q.isFetching}>Refresh evidence</button>}</div>
    <div className="contribution-kpis">
      <div><strong>{d.summary.matching}<small> / {d.summary.total}</small></strong><span>Current behavior evidence</span></div>
      <div><strong>{d.summary.paper}</strong><span>Scanners scheduled in paper</span></div>
      <div><strong>{d.summary.shadow}</strong><span>Scanners allocated to shadow</span></div>
      <div><strong>{d.summary.unverified}</strong><span>Runnable, needs current probe</span></div>
    </div>
    <p className="contribution-note">{d.summary.specified} have explicit reading specifications · {d.summary.aliases} duplicate aliases · {d.summary.held} source or runtime holds. “Current” matches code and settings; it is not a profitability verdict.</p>
    <div className="contribution-families">{d.authors.filter(a=>a.major||more).map(a=><button key={a.author} className={`contribution-family ${author===a.author?'selected':''}`} aria-pressed={!compact&&author===a.author} onClick={()=>{if(!compact)changeAuthor(author===a.author?'All':a.author)}} disabled={compact}>
      <strong>{a.author}</strong><span>{a.matching} / {a.total} with matching profiles</span><span><b>{a.paper}</b> paper · <b>{a.shadow}</b> shadow · {a.specified} specified</span><progress value={a.matching} max={Math.max(1,a.total)} aria-label={`${a.author} profile coverage`}/>
    </button>)}</div>
    {!compact&&<>
      <div className="contribution-controls"><label>Family<select className="input" value={author} onChange={e=>changeAuthor(e.target.value)}><option>All</option>{d.authors.map(a=><option key={a.author}>{a.author}</option>)}</select></label>
        <label>Contribution<select className="input" value={filter} onChange={e=>{setFilter(e.target.value);setPage(0)}}><option value="working">Allocated / candidates</option><option value="all">Entire library</option><option value="unverified">Needs current probe</option><option value="context">Context / entries disabled</option><option value="blocked">Source / runtime holds</option><option value="duplicates">Duplicate aliases</option></select></label>
        <label className="contribution-search">Find a scanner<input className="input" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}} placeholder="Name, ID or author…"/></label><button className="btn" onClick={()=>setMore(!more)}>{more?'Major families':'All family cards'}</button>
      </div>
      <p className="muted">{rows.length} scanners · activity and closed trades: last 7 days · shadow decisions are a bounded retained sample</p>
      <div className="contribution-table-wrap"><table className="contribution-table"><thead><tr><th>Scanner / observed role</th><th>Code-matched evidence</th><th>Allocated cells</th><th>Paper decisions · 7d</th><th>Shadow decisions · 7d</th><th>Next action</th></tr></thead><tbody>{visible.map(r=><tr key={r.id} className={selected===r.id?'selected':''}>
        <td><button className="contribution-name" onClick={()=>setSelected(selected===r.id?null:r.id)} aria-expanded={selected===r.id}>{r.name}</button><span className="contribution-sub">{r.author} · {r.role}</span>{r.status!=='ok'&&<Pill tone="warn">{r.status}</Pill>}</td>
        <td><b>{r.profiles.matching}</b> observations<span className="contribution-sub">{r.profiles.tfs.join(' · ')||'No current timeframe evidence'}</span>{r.profiles.legacy+r.profiles.changed>0&&<span className="contribution-sub">{r.profiles.legacy} unversioned · {r.profiles.changed} changed</span>}<span className="contribution-sub">{r.profiles.lastAt?timeAgo(r.profiles.lastAt):'Never profiled'}</span></td>
        <td>{r.cells.paper} paper · {r.cells.shadow} shadow<span className="contribution-sub">{r.cells.candidate} candidates · {r.cells.tracked} trackers</span></td>
        <td>{r.paper.signals} signals<span className="contribution-sub">{r.paper.opened} opened · {r.paper.pending} pending · {r.paper.blocked} other</span><span className="contribution-sub">{r.closes.paper} closed trades</span></td>
        <td>{r.shadow.signals} retained signals<span className="contribution-sub">{r.shadow.opened} opened · {r.shadow.pending} pending · {r.shadow.blocked} other</span><span className="contribution-sub">{r.closes.shadow} closed trades</span></td>
        <td><button className="btn btn-xs" onClick={()=>setSelected(r.id)}>{r.next}</button><span className="contribution-sub">{r.readingSpecified?'Repository specification':'Inspect effective reading'}{r.cautions?` · ${r.cautions} source checks`:''}</span></td>
      </tr>)}</tbody></table></div>
      {!rows.length&&<p className="muted">No scanners match these filters.</p>}
      <div className="contribution-pagination"><button className="btn btn-xs" disabled={pageNo===0} onClick={()=>setPage(pageNo-1)}>Previous</button><span>{rows.length?`${pageNo*20+1}–${Math.min(rows.length,(pageNo+1)*20)} of ${rows.length}`:'0 results'}</span><button className="btn btn-xs" disabled={(pageNo+1)*20>=rows.length} onClick={()=>setPage(pageNo+1)}>Next</button></div>
      {chosen&&<div className="contribution-detail"><div className="contribution-heading"><div><h3>{chosen.name}</h3><p>{chosen.next}{chosen.reason?` · ${chosen.reason}`:''}</p></div><button className="btn btn-xs" onClick={()=>setSelected(null)}>Close detail</button></div>
        <div className="contribution-links"><Link className="btn btn-xs" to={`/scanners/${chosen.id}`}>Source & settings</Link><Link className="btn btn-xs" to={`/analytics?period=7d&scanner=${encodeURIComponent(chosen.id)}`}>Performance</Link>{chosen.aliasOf&&<Link className="btn btn-xs" to={`/scanners/${chosen.aliasOf}`}>Canonical scanner</Link>}</div>
        {topReasons(chosen).length>0&&<div><h4>Top paper decision blockers</h4><ul>{topReasons(chosen).map(([reason,n])=><li key={reason}>{n} × {reason}</li>)}</ul></div>}
        {detail.isError&&<ErrorState error={detail.error} onRetry={()=>detail.refetch()}/>}
        {detail.isFetching&&!detail.data&&<p>Loading source evidence…</p>}
        {detail.data&&<>
          <p className="muted">{detail.data.facts.lines} source lines · {detail.data.facts.inputs} inputs · source {detail.data.hash} · channels: {detail.data.reading.sources===null?'automatic':detail.data.reading.sources.join(', ')||'entries disabled'} · timezone {detail.data.reading.timezone}</p>
          {!!detail.data.facts.cautions.length&&<ul>{detail.data.facts.cautions.map(c=><li key={c}>{c}</li>)}</ul>}
          {!!detail.data.facts.dependencies.length&&<details><summary>Requested data dependencies</summary><pre>{detail.data.facts.dependencies.join('\n')}</pre></details>}
          <details><summary>Reading contract and input overrides</summary><pre>{JSON.stringify(detail.data.reading,null,2)}</pre></details>
          <details><summary>Source signal conditions ({detail.data.facts.totalCalls} calls; first 60 shown)</summary><p className="muted">Static call inventory. Conditions may reference variables or surrounding branches; open the source for full logic.</p>{detail.data.facts.calls.map((c,i)=><div className="contribution-call" key={i}><b>Line {c.line} · {c.name} · {c.title}</b><pre>{c.code}</pre></div>)}</details>
          <details open><summary>Runtime observations ({detail.data.profiles.length})</summary><div className="contribution-observations">{detail.data.profiles.slice(0,80).map(p=><div key={`${p.market}|${p.tf}`}><strong>{p.market} · {p.tf} · {p.kind}</strong><span>{p.entries} entries · {p.exits} exits · {p.bars??'?'} bars</span><span>{p.evidence} · {timeAgo(p.at)}</span>{p.windowStart&&p.windowEnd&&<span>{new Date(p.windowStart).toISOString().slice(0,16)} → {new Date(p.windowEnd).toISOString().slice(0,16)} UTC</span>}{p.error&&<span className="negative">{p.error}</span>}</div>)}</div>{detail.data.profiles.length>80&&<p>Showing first 80 observations; source & settings contains the complete profile.</p>}{!detail.data.profiles.length&&<p className="muted">No saved behavior probe yet. Nightly screening now records these automatically.</p>}</details>
        </>}
      </div>}
    </>}
    <details className="contribution-method"><summary>How to read this evidence</summary>{d.notes.map(n=><p key={n}>{n}</p>)}{d.lastScreen&&<p>Last screen: {d.lastScreen.runs??0} runs · {d.lastScreen.silentSkipped??0} market checks deferred after quiet probes. A skipped market has no new verdict.</p>}</details>
  </section>
}
