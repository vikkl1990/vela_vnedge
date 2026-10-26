import {useScannerPipeline} from '../api/queries'
import {Panel,Time,ErrorState,Loading} from './ui'
export function ScannerPipelinePanel(){
 const q=useScannerPipeline(),d=q.data
 return <Panel title="Scanner pipeline · current allocations">
 <p className="small muted">A historical chart arrow is not a fresh entry. This view separates successful scans, generated entry events and admission decisions over 24 hours. Filters and gate refusals remain visible in the decision journal.</p>
 {q.isLoading&&<Loading rows={2}/>}{q.isError&&<ErrorState error={q.error} onRetry={()=>q.refetch()}/>}
 {d&&<><p className="small">Worker queue: {d.queue.queuedLive} account · {d.queue.queuedMirror} priority shadow · {d.queue.queuedShadow} fresh shadow · {Math.max(0,d.queue.queued-d.queue.queuedLive-d.queue.queuedMirror-d.queue.queuedShadow)} research</p>
 {d.shadowDispatch&&<p className="small muted">Shadow scheduler since restart: {d.shadowDispatch.pending} waiting · {d.shadowDispatch.inFlight} submitted · {d.shadowDispatch.finished} dispatches finished · {d.shadowDispatch.expired} missed deadline · {d.shadowDispatch.replaced} older pending bars replaced. Peak scheduling wait {(d.shadowDispatch.maxWaitMs/1000).toFixed(1)}s. Finished dispatches include no-event and superseded runs; these are not trade counts.</p>}
 {d.unallocated?.length>0&&<p className="small loss">Enabled without assigned pairs: {d.unallocated.map(s=>s.name).join(', ')}. These scanners schedule no account jobs.</p>}
 <div className="table-wrap" style={{maxHeight:420,overflow:'auto'}}><table className="table table-dense"><thead><tr><th>Scanner / allocation</th><th>Last scan</th><th>Runs / failed · 24h</th><th>Entry events · 24h</th><th>Last entry / decision</th></tr></thead><tbody>{d.cells.map(c=><tr key={`${c.scannerId}:${c.symbol}:${c.tf}`}><td>{c.scannerId}<div>{c.symbol} · {c.tf}</div></td><td>{c.lastRun?<Time t={c.lastRun} mode="datetime"/>:'Never scanned'}{c.error&&<div className="loss">{c.error}</div>}</td><td>{c.runs} / {c.failures}</td><td>{c.entries24h}<div className="small muted">{c.actions.map(a=>`${a.action} ×${a.n}`).join(' · ')||'No fresh entry event in this window'}</div></td><td>{c.latest?<><Time t={c.latest.at} mode="datetime"/><div>{c.latest.label}</div><div className="small">{c.latest.action}</div></>:'No recorded entry'}</td></tr>)}</tbody></table></div></>}
 </Panel>
}
