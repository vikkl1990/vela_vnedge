import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Link,useSearchParams} from 'react-router-dom'
import {api} from '../api/client'
import {PageTitle,Panel,QueryState} from '../components/ui'
import {Callout,EmptyState,Section,Stat,StatGrid,TabPanel,Tabs,Toolbar} from '../components/kit'
import '../styles/pages/monitor.css'
import {fmtAge,fmtPnl} from '../lib/format'
import {useNow} from '../lib/useNow'
import {heatValue,heatLabel,evidenceBook,type HeatMetric} from '../lib/monitorHeatmap'
import type {TradeMonitorView} from '../api/tradeMonitor'

const tone=(n:number|null)=>n===null?'':n<0?'loss':n>0?'gain':''
export function TradeMonitor(){
 const q=useQuery({queryKey:['trade-monitor'],queryFn:api.tradeMonitor,refetchInterval:10000})
 const [tab,setTab]=useState<'pairs'|'exits'>('pairs'),[metric,setMetric]=useState<HeatMetric>('paper'),[search,setSearch]=useState(''),[activeOnly,setActiveOnly]=useState(false)
 const [params,setParams]=useSearchParams();const selected=params.get('pair')??'';const now=useNow(1000)
 const select=(symbol:string)=>setParams(symbol?{pair:symbol}:{})
 return <div className="page monitor-page">
  <PageTitle sub="Trade health, observed order flow and what-if exits for every pair. Advisory only: this page never opens, closes or resizes a trade." actions={<Link className="btn btn-sm" to="/trades">Open journals</Link>}/>
  <QueryState {...q} data={q.data} onRetry={()=>q.refetch()}>{d=>{
   const pairs=d.pairs.filter(p=>(!activeOnly||p.active)&&p.symbol.toLowerCase().includes(search.toLowerCase()))
   const positions=d.positions.filter(p=>!selected||p.symbol===selected),trials=d.trials.filter(t=>!selected||t.symbol===selected)
   const stale=!d.at||now-d.at>20000
   const quick=(symbol:string)=>{setSearch('');select(symbol)}
   return <>
    {stale&&<Callout tone="warn" title={d.at?'Observations are delayed':'Collecting first observations'}>{d.at?'Treat the state shown here as stale.':'Complete flow needs five settled minutes.'}</Callout>}
    {d.marketError&&<Callout tone="danger" title="Market data problem">{d.marketError}</Callout>}
    <StatGrid min={150}>
     <Stat label="Pairs" value={d.pairs.length} sub="in the book"/>
     <Stat label="Observed" value={d.connections.symbols} tone="accent" sub="pairs the collector watches"/>
     <Stat label="Depth under 10 s" value={d.pairs.filter(p=>p.depthFresh).length} sub="fresh order book"/>
     <Stat label="Complete 5m flow" value={d.pairs.filter(p=>p.flow?.covered).length} sub="buy and sell balance"/>
     <Stat label="Last update" value={d.at?fmtAge(now-d.at):'warming up'} tone={stale?'warn':undefined} sub={d.at?'ago':'collector starting'}/>
    </StatGrid>
    <Tabs label="Trade monitor views" idPrefix="mon" value={tab} onChange={setTab} items={[{id:'pairs',label:'Pairs and open trades',count:positions.length},{id:'exits',label:'What-if exits',count:trials.length}]}/>
    <TabPanel id="pairs" value={tab} idPrefix="mon"><div className="mon-stack">
     <Section title="Pair heatmap" hint="Rolling 24 h results. Click a pair to inspect it; click again to clear.">
      <Toolbar end={<span className="muted small">Quick pick <button type="button" className="btn btn-xs" onClick={()=>quick('INITUSD')}>INIT</button> <button type="button" className="btn btn-xs" onClick={()=>quick('PARTIUSD')}>PARTI</button></span>}>
       <label className="mon-field">Colour by<select className="select select-sm" value={metric} onChange={e=>setMetric(e.target.value as HeatMetric)}><option value="paper">Paper closed net R · 24h</option><option value="shadow">Shadow closed net R · 24h</option><option value="open">Worst open trade · price R</option><option value="market">Market change · 24h</option><option value="flow">Buy/sell imbalance · 5m</option></select></label>
       <label className="mon-field">Find a pair<input className="input input-sm" type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="INIT, PARTI, BTC…"/></label>
       <label className="mon-field mon-check"><input type="checkbox" checked={activeOnly} onChange={e=>setActiveOnly(e.target.checked)}/> Observed pairs only</label>
      </Toolbar>
      <Panel>
       <div className="monitor-tiles" aria-label="Pair heatmap">{pairs.map(p=>{
        const v=heatValue(p,metric),fresh=!!p.depthFresh&&p.depthAt!==null&&now-p.depthAt<=10000&&!stale,flow=!!p.flow?.covered&&!stale
        return <button key={p.symbol} className={`monitor-tile ${tone(v)} ${selected===p.symbol?'selected':''}`} aria-pressed={selected===p.symbol} onClick={()=>select(selected===p.symbol?'':p.symbol)}>
         <span className="monitor-symbol">{p.symbol.replace(/USD$/,'')}<span className="small muted">USD</span></span>
         <strong>{v===null&&(metric==='paper'||metric==='shadow')?'No closes':heatLabel(v,metric)}</strong>
         <span className="small">{p.paperOpen||p.shadowOpen||p.researchOpen?`${p.paperOpen} paper · ${p.shadowOpen} shadow${p.researchOpen?` · ${p.researchOpen} research`:''}`:p.active?'Observed · no open trades':'Not observed'}</span>
         <span className="monitor-coverage"><span className={flow?'gain':'muted'}>Flow {flow?'✓':p.active?(p.flow&&p.flow.minutes>=5?'gap':'warming'):'—'}</span><span className={fresh?'gain':'muted'}>Depth {fresh?'✓':p.depthAt?fmtAge(now-p.depthAt):'—'}</span></span>
        </button>
       })}</div>
       {!pairs.length&&<EmptyState title="No matching pairs" hint="Clear the search box or untick Observed pairs only." action={<button type="button" className="btn btn-sm" onClick={()=>{setSearch('');setActiveOnly(false)}}>Clear filters</button>}/>}
       <p className="small muted mon-legend"><span className="gain">Green: positive</span> · <span className="loss">Red: negative</span> · Grey: no observations or closed trades. Flow is buy/sell balance, not a profit forecast. Shadow excludes tracker and experimental trades.</p>
      </Panel>
     </Section>
     <Section title={`${selected||'All pairs'} · open trades`} actions={selected?<button type="button" className="btn btn-sm" onClick={()=>select('')}>Show all pairs</button>:undefined}>
      <Panel pad={false}>
       {positions.length?<div className="table-wrap"><table className="table small"><thead><tr><th>Pair / scanner</th><th>Book</th><th>Side / TF</th><th>Price R</th><th>Observed peak</th><th>State</th><th>History</th></tr></thead><tbody>{positions.map(p=><tr key={`${p.id}:${p.entryAt}`}>
        <td><Link to={`/trades/${p.id}/replay`}>{p.symbol} #{p.id}</Link><div className="muted small">{p.scanner}</div></td><td>{evidenceBook(p.book,p.scope)}</td><td>{p.side} · {p.tf}</td><td className={`mono ${tone(p.r)}`}>{heatLabel(p.r,'open')}</td><td className="mono">{heatLabel(p.peak,'open')}</td><td title={p.reason}>{p.state.replaceAll('-',' ')}<div className="muted small">{p.reason}</div></td><td className="muted">{p.complete?'Since entry':'Partial coverage'}<div className="small">{fmtAge(now-p.lastAt)} ago</div></td>
       </tr>)}</tbody></table></div>:<EmptyState title="No open positions here" hint="Nothing is open in this selection. Collection continues for observed pairs."/>}
      </Panel>
     </Section>
    </div></TabPanel>
    <TabPanel id="exits" value={tab} idPrefix="mon"><div className="mon-stack">
     <Callout tone="warn" title="Unproven controls, no execution.">Two frozen controls record what an earlier exit would have done. A result is comparable only after both the what-if fill and the real trade have finished. More early exits do not mean better performance.</Callout>
     <Section title="Totals" hint="Cover all pairs, whatever pair is selected.">
      <Summary data={d}/>
      <details><summary>Control definitions and accounting</summary><ul>{d.rules.map(r=><li key={r.id}><b>{r.name}:</b> {r.description}</li>)}</ul><p className="small muted">Fresh executable depth after latency; partial fills and costs retained. Unpriced or interrupted trials have no claimed profit. Comparisons never count toward promotion. No recovery prediction model is active. {d.retention}</p></details>
     </Section>
     <Section title={`${selected||'All pairs'} · trials`} hint="The list follows your pair selection." actions={selected?<button type="button" className="btn btn-sm" onClick={()=>select('')}>Show all pairs</button>:undefined}>
      <Panel pad={false}>
       {trials.length?<div className="table-wrap"><table className="table small"><thead><tr><th>Trade</th><th>Book / control</th><th>Status</th><th>What-if</th><th>Actual</th><th>Difference</th></tr></thead><tbody>{trials.map(t=>{
        const cash=t.book===0,format=(n:number|null)=>n===null?'—':cash?`$${fmtPnl(n)}`:heatLabel(n/t.risk,'shadow')
        return <tr key={t.id}><td><Link to={`/trades/${t.position_id}/replay`}>{t.symbol} #{t.position_id}</Link><div className="small muted">{fmtAge(now-t.trigger_at)} ago</div></td><td>{evidenceBook(t.book,t.scope)}<div className="muted small">{d.rules.find(r=>r.id===t.rule)?.name??t.rule}</div></td><td>{t.status==='filled'&&t.actual_net===null?'Filled · awaiting actual close':t.status}<div className="small muted">{t.error??(t.market_filled<t.market_qty?`${t.market_filled}/${t.market_qty} observed contracts`:'')}</div></td><td className="mono">{format(t.net)}</td><td className="mono">{format(t.actual_net)}</td><td className={`mono ${tone(t.delta)}`}>{format(t.delta)}</td></tr>
       })}</tbody></table></div>:<EmptyState title="No what-if exits yet" hint="Observation starts at deployment; older outcomes are not backfilled as new evidence."/>}
      </Panel>
     </Section>
    </div></TabPanel>
   </>
  }}</QueryState>
 </div>
}
function Summary({data}:{data:TradeMonitorView}){
 return <div className="table-wrap"><table className="table small"><thead><tr><th>Book / control</th><th>Trials</th><th>Resolved</th><th>Unavailable</th><th>Δ net R</th><th>Δ cash</th><th>Winners lost</th></tr></thead><tbody>{data.summary.map(s=><tr key={`${s.book}:${s.scope}:${s.rule}`}><td>{evidenceBook(s.book,s.scope)} · {data.rules.find(r=>r.id===s.rule)?.name}<div className="small muted">{s.scope}</div></td><td>{s.trials}</td><td>{s.resolved}</td><td>{s.unavailable}</td><td className={tone(s.resolved?s.deltaR:null)}>{s.resolved?heatLabel(s.deltaR,'paper'):'—'}</td><td>{s.book===0&&s.resolved?`$${fmtPnl(s.deltaUsd)}`:'—'}</td><td>{s.winnersLost}</td></tr>)}</tbody></table></div>
}
