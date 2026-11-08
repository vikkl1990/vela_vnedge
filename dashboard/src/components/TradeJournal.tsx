import { useSearchParams } from 'react-router-dom'
import { useJournal, useMarkets, useScannerIndex } from '../api/queries'
import type { JournalQuery, JournalRow } from '../api/journal'
import { DataTable, type Column } from './DataTable'
import { JournalDetailPanel } from './JournalDetail'
import { JournalExport } from './JournalExport'
import { Panel, Pill, Pnl, QueryState, Time } from './ui'
import { fmtMoney, fmtRecordedPrice as price, fmtR } from '../lib/format'
import { JOURNAL_PAGE_SIZE, JOURNAL_PERIODS, journalFilters, updateJournalFilters } from '../lib/journalFilters'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useNow } from '../lib/useNow'

const money = (n: number | null) => n === null ? 'Unknown' : fmtMoney(n)
export function TradeJournal() {
  const [params, setParams] = useSearchParams(), f = journalFilters(params, useNow(60_000))
  const book = params.get('book') ?? 'paper', status = params.get('status') ?? 'closed', scope = params.get('scope') ?? 'all'
  const history = params.get('history') ?? 'current'
  const dateBy = params.get('dateBy') ?? 'exit', sort = params.get('sort') ?? 'newest'
  const query: JournalQuery = { ...f.query, book, status, scope, history, dateBy, sort }
  const q = useJournal(query, !f.error), scanners = useScannerIndex(), markets = useMarkets()
  const update = (values: Record<string, string>) => { const next = updateJournalFilters(params, values); next.delete('trade'); setParams(next) }
  const selected = Number(params.get('trade')), id = Number.isSafeInteger(selected) && selected > 0 ? selected : null
  const show = (r: JournalRow) => { const next = new URLSearchParams(params); next.set('trade', String(r.id)); setParams(next) }
  const symbols = [...new Set([...(markets.data ?? []).map(m => m.symbol), ...(q.data?.rows ?? []).map(r => r.symbol), ...(f.symbol ? [f.symbol] : [])])].sort()
  const cols: Column<JournalRow>[] = [
    {key:'id',header:'Trade',render:r=><button className="btn btn-xs" onClick={()=>show(r)}>#{r.id} · detail</button>},
    {key:'symbol',header:'Market / scanner',render:r=><span><b>{r.symbol} · {r.tf}</b><div className="small muted">{r.scannerName}</div><span className="small">{r.evidenceScope}</span></span>},
    {key:'status',header:'Status / side',render:r=><span><Pill>{r.status}</Pill>{r.archived&&<Pill tone="warn">archived</Pill>}<div>{r.side ?? 'Unknown'}</div></span>},
    {key:'entry',header:'Entry / placement',render:r=>r.entryAt===null?'Unknown':<span><Time t={r.entryAt} mode="datetime" /><div>{price(r.entryPrice)}</div></span>},
    {key:'exit',header:'Exit / cancellation',render:r=>r.exitAt===null?'—':<span><Time t={r.exitAt} mode="datetime" /><div>{price(r.exitPrice)}</div></span>},
    {key:'risk',header:'Risk / margin · USD',numeric:true,render:r=><span>{money(r.risk)}<div className="small muted">{money(r.margin)}</div></span>},
    {key:'sl',header:'Original SL / targets',render:r=><span>{price(r.slOriginal)}<div className="small muted">{r.targets?.length?r.targets.map(price).join(' / '):'No targets recorded'}</div></span>},
    {key:'net',header:'Closed net · USD',numeric:true,render:r=><span>{r.net===null?'—':<Pnl value={r.net}/>} {r.accountingPending&&<Pill tone="warn">provisional</Pill>}</span>},
    {key:'cost',header:'Commission / funding',numeric:true,render:r=><span>{money(r.commission)}<div className="small muted">{money(r.funding)}</div></span>},
    {key:'r',header:'Net R / peak R',numeric:true,render:r=><span>{r.r===null?'—':fmtR(r.r)}<div className="small muted">{r.peakR===null?'Unknown':fmtR(r.peakR)}</div></span>},
    {key:'exitReason',header:'Exit / ML',render:r=><span>{r.exitReason??'—'}<div className="small muted">ML {r.mlProbability===null?'not recorded':`${(r.mlProbability*100).toFixed(1)}%`}</div></span>},
  ]
  return <>
    <div className="row gap" aria-label="Journal books">
      <button className={`btn ${book==='paper'?'btn-cta':''}`} aria-pressed={book==='paper'} onClick={()=>update({book:'paper'})}>Paper journal</button>
      <button className={`btn ${book==='shadow'?'btn-cta':''}`} aria-pressed={book==='shadow'} onClick={()=>update({book:'shadow'})}>Shadow journal</button>
    </div>
    <JournalExport key={book} query={query} total={q.data?.total} filterError={f.error} />
    <Panel className="trade-journal" title={`${book === 'shadow' ? 'Shadow' : 'Paper'} journal`} pad={false} right={<div className="page-actions">
      <button className="btn btn-sm" onClick={()=>update({period:'today',status:'closed',reason:'sl',dateBy:'exit'})}>Today's stops</button>
      <button className="btn btn-sm" onClick={()=>setParams({book})}>Clear filters</button>
    </div>}>
      <div className="journal-filters">
        <label>History<select className="select" aria-label="Journal history" value={history} onChange={e=>update({history:e.target.value})}><option value="current">Current account period</option><option value="archived">Before account resets</option><option value="all">Current + archived</option></select></label>
        <label>Status<select className="select" aria-label="Journal status" value={status} onChange={e=>update({status:e.target.value,dateBy:['open','pending','all'].includes(e.target.value)?'entry':'exit'})}>{['closed','all','open','pending','cancelled','voided'].map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Market<select className="select" aria-label="Journal market" value={f.symbol} onChange={e=>update({symbol:e.target.value})}><option value="">All markets</option>{symbols.map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Timeframe<select className="select" aria-label="Journal timeframe" value={f.tf} onChange={e=>update({tf:e.target.value})}><option value="">All timeframes</option>{[...new Set([...DELTA_TIMEFRAMES,...(f.tf?[f.tf]:[])])].map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Direction<select className="select" aria-label="Journal direction" value={f.side} onChange={e=>update({side:e.target.value})}><option value="">All directions</option><option value="long">Long</option><option value="short">Short</option></select></label>
        <label>Exit reason<select className="select" aria-label="Journal exit reason" value={f.reason} onChange={e=>update({reason:e.target.value})}><option value="">All reasons</option>{[...new Set(['sl','trail','be','tp1','tp2','tp3','script_exit','script_flip','reversal','manual','liquidation','funding',...(f.reason?[f.reason]:[])])].map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Evidence<select className="select" aria-label="Journal evidence scope" value={scope} onChange={e=>update({scope:e.target.value})}><option value="all">All retained records</option><option value="evidence">Performance / incubator evidence</option><option value="watch">Watch-only</option><option value="plans">Plan comparisons</option></select></label>
        <label>Date basis<select className="select" aria-label="Journal date basis" value={dateBy} onChange={e=>update({dateBy:e.target.value})}><option value="exit">Exit / cancellation</option><option value="entry">Entry / placement</option></select></label>
        <label>Period<select className="select" aria-label="Closing period" value={f.period} onChange={e=>update({period:e.target.value})}>{JOURNAL_PERIODS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label>Sort all matches<select className="select" aria-label="Journal sort" value={sort} onChange={e=>update({sort:e.target.value})}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="worst">Largest losses first</option><option value="best">Largest profits first</option></select></label>
        <label>Scanner<input className="input" aria-label="Journal scanner" list="journal-scanners" value={f.scanner} onChange={e=>update({scanner:e.target.value})} placeholder="All scanners; search name / ID"/><datalist id="journal-scanners">{scanners.data?.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</datalist></label>
        {f.period==='custom'&&<><label>From (UTC)<input className="input" type="date" value={f.start} onChange={e=>update({start:e.target.value})}/></label><label>Through (UTC)<input className="input" type="date" value={f.end} onChange={e=>update({end:e.target.value})}/></label></>}
      </div>
      <p className="journal-scope small muted">Every retained record in the selected history is available across pages. Archived open / pending records describe the pre-reset state, not current exposure. Date ranges use UTC; displayed timestamps use your local zone. {book==='shadow'?'Shadow dollars are synthetic and do not represent account profit. All-record totals include watch-only and plan comparisons; choose Performance / incubator evidence to match performance scope.':'Paper and shadow totals are kept separate.'} Open and pending records do not count as closed profit.</p>
      {f.error?<p className="banner banner-warn" role="alert">{f.error}</p>:<QueryState {...q} data={q.data} onRetry={()=>q.refetch()}>{d=>{
        const s=d.summary, pages=Math.max(1,Math.ceil(d.total/JOURNAL_PAGE_SIZE))
        return <>
          <div className="journal-totals" aria-label="Filtered journal totals">
            <div><span>Matching records / archived</span><strong>{d.total} / {s.archived}</strong></div><div><span>Closed / open / pending</span><strong>{s.closed} / {s.open} / {s.pending}</strong></div>
            <div><span>Closed net · {book==='shadow'?'synthetic ':''}USD</span><strong><Pnl value={s.net}/></strong></div><div><span>Commission · closed</span><strong>{money(s.commission)}</strong></div>
            <div><span>Recorded funding · closed</span><strong>{s.unknownFunding?'Incomplete':money(s.funding)}</strong></div>
            <div><span>Win rate / profit factor</span><strong>{s.winRate===null?'—':`${s.winRate.toFixed(1)}%`} / {s.profitFactor===null?s.noLosses?'No losses':'—':s.profitFactor.toFixed(2)}</strong></div>
            <div><span>Sum R / average R</span><strong>{s.sumR===null?'—':fmtR(s.sumR)} / {s.avgR===null?'—':fmtR(s.avgR)}</strong></div>
          </div>
          <p className="journal-scope small muted">Totals and sorting cover all matching records, not just this page. Gross trading − commission + recorded funding = realized net. Missing risk: {s.unknownRisk}; missing funding detail: {s.unknownFunding}; missing net: {s.unknownNet}; provisional exchange accounting: {s.accountingPending}. Exports include all matches.</p>
          <div className="journal-pagination"><span>{d.total?`${Math.min(d.offset+1,d.total)}–${Math.min(d.offset+d.rows.length,d.total)} of ${d.total}`:'No matching records'} · Page {f.page+1} / {pages}</span><div className="row gap"><button className="btn btn-sm" disabled={f.page===0} onClick={()=>update({page:String(f.page-1)})}>Previous</button><button className="btn btn-sm" disabled={f.page>=pages-1} onClick={()=>update({page:String(f.page+1)})}>Next</button>{f.page>=pages&&<button className="btn btn-sm" onClick={()=>update({page:''})}>First page</button>}</div></div>
          <DataTable columns={cols} rows={d.rows} rowKey={r=>r.id} onRowClick={show} emptyLabel="No records match these filters." caption={`${book} journal`} />
        </>
      }}</QueryState>}
    </Panel>
    {id!==null&&<JournalDetailPanel book={book} id={id} onClose={()=>{const next=new URLSearchParams(params);next.delete('trade');setParams(next)}}/>}
  </>
}
