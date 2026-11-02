import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { Panel } from './ui'
import { fmtDateTime } from '../lib/format'

export function PairAgentsPanel() {
  const q=useQuery({queryKey:['pair-agents'],queryFn:api.pairAgents,refetchInterval:30_000})
  const [search,setSearch]=useState(''),[eligibleOnly,setEligibleOnly]=useState(false)
  const v=q.data
  return <Panel title="Pair agents · market coverage" right={<span className="small">{!v?'Loading':v.enabled?'Running automatically':'Paused'}</span>}>
    {q.isError?<p role="alert">Could not load pair agents: {q.error.message}</p>:!v?<p>Loading market coverage…</p>:<>
      <div className="radar-strip">
        <div className="radar-tf"><b>Universe agent</b><div>{v.eligible} eligible / {v.markets.length} crypto pairs</div><p className="small muted">All listed crypto perpetuals are assessed. No BTC/ETH/SOL-only restriction.</p></div>
        <div className="radar-tf"><b>Scanner agent</b><div>{v.scannerCount} scanner policies · {v.tfs.join(' / ')}</div><p className="small muted">{v.dueCells} combinations ready for research · {v.usedToday}/{v.settings.maxJobsPerDay} jobs today</p></div>
        <div className="radar-tf"><b>Evidence agent</b><div>Screen → shadow → existing promotion rules</div><p className="small muted">Backtest passes earn research eligibility. Forward results determine paper admission.</p></div>
      </div>
      <p role="status"><strong>{v.status}</strong>{v.lastAt>0?` · checked ${fmtDateTime(v.lastAt)}`:''}</p>
      {v.running&&<p>Testing: {v.running.label}{v.running.progress?` · ${v.running.progress.runs} runs · ${v.running.progress.passed} passed`:''}</p>}
      <p className="small muted">Coverage below uses the healthy, enabled scanner pool. The nightly hunter continues exploring the wider library. Jobs share one research queue, with up to {v.settings.scannersPerJob} scanners × {v.settings.marketsPerJob} pairs per job. Fresh depth and sizing checks still apply at entry; watch-only cells do not allocate paper capital.</p>
      <details><summary>Inspect every pair · assignments, completed screens and gaps</summary>
        <div className="toolbar"><input className="input" aria-label="Find coverage pair" placeholder="Find a pair…" value={search} onChange={e=>setSearch(e.target.value)} /><label><input type="checkbox" checked={eligibleOnly} onChange={e=>setEligibleOnly(e.target.checked)} /> Eligible only</label></div>
        <div className="table-wrap" style={{maxHeight:480,overflow:'auto'}}><table className="table small"><thead><tr><th>Pair</th><th>Paper cells</th><th>Shadow</th><th>Watch only</th><th>Recent screens / passes</th><th>Research due</th><th>Market assessment</th></tr></thead><tbody>
          {v.markets.filter(m=>(!eligibleOnly||m.eligible)&&m.symbol.toLowerCase().includes(search.toLowerCase())).map(m=><tr key={m.symbol}>
            <td><Link to={`/incubator?symbol=${encodeURIComponent(m.symbol)}`}>{m.symbol}</Link><div className="muted">${(m.turnover/1e6).toFixed(2)}M / 24h</div></td><td>{m.account}</td><td>{m.shadow}</td><td>{m.tracked}</td><td>{m.screened} / {m.passed}</td><td>{m.due} / {m.cells}</td><td>{m.eligible?'Eligible for research':m.reasons.join('; ')}</td>
          </tr>)}
        </tbody></table></div>
        <p className="small muted">Screens are completed results under the current policy within {v.settings.refreshDays} days. A queued, skipped or failed job does not count as a completed screen. Research due can include pairs waiting for eligibility or retry cooldown.</p>
      </details>
      {!!v.history.length&&<details><summary>Recent agent jobs</summary>{v.history.map(j=><p key={j.id}><b>{j.status}</b> · {j.label}<br/><span className="small muted">{j.summary??j.error??'No completed summary'}</span></p>)}</details>}
    </>}
  </Panel>
}
