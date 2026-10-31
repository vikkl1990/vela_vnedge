import { useExecutionQuality } from '../api/queries'
import { Panel, Pill, QueryState, Time } from './ui'
import { fmtInt } from '../lib/format'
export function ExecutionQualityPanel() {
  const q=useExecutionQuality();
  return <Panel title="Execution quality" right={q.data ? <span className="small muted">Updated <Time t={q.data.at} mode="ago" /></span> : null}>
    <QueryState {...q} data={q.data} onRetry={()=>q.refetch()}>{d=>{
      const pending=d.funding.counts.find(c=>c.status==='pending')?.n ?? 0;
      const unresolved=d.funding.counts.find(c=>c.status==='unresolved')?.n ?? 0;
      const applied=d.funding.counts.find(c=>c.status==='applied')?.n ?? 0;
      const missing=d.depth.books.filter(b=>!b.valid || !b.fresh).map(b=>b.symbol);
      const old=d.depth.stored.newest==null || d.at-d.depth.stored.newest>30_000;
      return <div className="quality-grid">
        <section><h3>Funding coverage</h3><p><Pill tone={unresolved ? 'warn':'muted'}>{applied} applied · {pending} pending · {unresolved} unresolved</Pill></p><p className="small muted">{d.funding.method} Pending records may be future settlements; overdue or unresolved records need reconciliation.</p>
          <details><summary>Recent settlements and evidence</summary><div className="table-wrap"><table className="table"><thead><tr><th>Market</th><th>Settlement</th><th>Status</th><th>Source</th><th>Note</th></tr></thead><tbody>{d.funding.recent.map(r=><tr key={`${r.symbol}:${r.at}`}><td>{r.symbol}</td><td><Time t={r.at} mode="datetime" /></td><td>{r.status==='pending' && r.at<d.at-10_000 ? 'pending · overdue' : r.status}</td><td>{r.source}</td><td>{r.error ?? '–'}</td></tr>)}</tbody></table></div></details>
        </section>
        <section><h3>Depth recording</h3><Pill tone={missing.length || old || d.depth.droppedPending ? 'warn':'ok'}>{missing.length ? `Missing or stale snapshot: ${missing.join(', ')}` : old ? 'Recording stale or unavailable' : 'Fresh snapshots available'}</Pill><p className="small">Scope: {d.depth.symbols.join(', ')} · {fmtInt(d.depth.stored.n)} retained events · {d.depth.failures} validation failures since restart · {d.depth.droppedPending} drops awaiting recording · {d.depth.queued} queued</p><p className="small">Retained gaps: {d.depth.gaps.length ? d.depth.gaps.map(g=>`${g.symbol} ${g.n}`).join(', ') : 'none in retained window'}</p><p className="small muted">{d.depth.retention}. A clean current snapshot does not establish complete historical coverage.</p>{d.depth.stored.newest && <p className="small">Last stored event <Time t={d.depth.stored.newest} mode="ago" /></p>}</section>
        <section><h3>Private account history</h3>{!d.account.cursors.length ? <p>{d.mode==='paper' ? 'Inactive in paper mode; no private exchange history imported.' : 'Unavailable: no completed history audit.'}</p> : d.account.cursors.map(c=><p key={c.host}>{c.host}: <Time t={c.from_at} mode="datetime" /> to <Time t={c.through_at} mode="datetime" /> {c.error && <span className="loss">{c.error}</span>}</p>)}<p className="small">{d.account.comparisons.filter(c=>c.complete && c.quantityMatches===false).length} quantity mismatches · {d.account.comparisons.filter(c=>!c.complete).length} orders with incomplete history</p><p className="small muted">Quantity agreement does not verify fees, tax or promotional rebates.</p></section>
      </div>
    }}</QueryState>
  </Panel>
}
