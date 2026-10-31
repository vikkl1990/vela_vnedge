import { Link, useLocation } from 'react-router-dom'

const modules = [
  {path:'/library',name:'Library',role:'Find and inspect script sources.',authority:'Catalog and favorites; importing a script does not allocate it to the account.'},
  {path:'/scanners',name:'Scanners',role:'Configure how a script is read and run.',authority:'Inputs, signal reading and explicit operator allocations. Backtest reviews are advisory while Incubator manages the fleet.'},
  {path:'/incubator',name:'Incubator',role:'Screen candidates and collect forward evidence.',authority:'Owns candidate stages and promotion rules. Versioned TP/stop experiments are separate evidence.'},
  {path:'/decisions',name:'Decisions',role:'Act on Incubator proposals and faults.',authority:'Uses the same approval service as Incubator; it is not another strategy selector.'},
  {path:'/trackers',name:'Trackers',role:'Watch named groups in the shared shadow book.',authority:'A watch list does not place a second trade or promote a cell. Overlapping lists share the same cell.'},
  {path:'/radar',name:'Radar',role:'See coverage, signals and filled activity.',authority:'Read-only view of account and ordinary shadow activity. TP experiments and unfilled orders are excluded from its trade counts.'},
  {path:'/analytics',name:'Performance',role:'Measure results after costs.',authority:'Reads closed account and ordinary shadow trades. Watch-only and experimental results have their own views; totals are not additive.'},
  {path:'/learn',name:'Learn',role:'Evaluate model scores and recorded trade outcomes.',authority:'Studies recorded outcomes, including watch-only trades. Scores affect entries only through configured ML settings. It cannot promote scanners. The older parallel ML ledger is archived.'},
]

/** One explanation of ownership across the research pages, rather than another control surface. */
export function WorkflowGuide() {
  const {pathname}=useLocation()
  const current=modules.find(m=>pathname===m.path||pathname.startsWith(`${m.path}/`))
  if(!current)return null
  return <details className="panel small" style={{padding:'10px 14px',marginBottom:12}}>
    <summary><strong>{current.name}</strong> · {current.role} <span className="muted">How the modules connect</span></summary>
    <p>{current.authority}</p>
    <p className="muted">Script source → scanner event → account admission → order/fill journal. Research shares market data and the execution engine; its results remain separate from account performance.</p>
    <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Module</th><th>Responsibility and control</th></tr></thead><tbody>{modules.map(m=><tr key={m.path}><td><Link to={m.path}>{m.name}</Link></td><td>{m.authority}</td></tr>)}</tbody></table></div>
  </details>
}
