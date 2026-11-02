import type { ScriptSnapshot } from './scriptSnapshot'
import { fmtDateTime } from '../lib/format'

export function ScriptReadout({ runs }: {runs: ScriptSnapshot[]}) {
  if (!runs.length) return null
  return <details className="panel" style={{padding: 12}}><summary>Scanner calculations · {runs.length} chart runs</summary>
    <p className="muted small">Values from the chart engine. Forming bars are provisional. Entries and refusals remain in the journal beside the chart.</p>
    <div style={{overflowX: 'auto'}}><table className="table"><thead><tr><th>Scanner / frame</th><th>Bar</th><th>State</th><th>Latest plots</th></tr></thead><tbody>
      {runs.map(r => <tr key={`${r.tf}:${r.id}`}><td>{r.title} · {r.tf}</td><td>{fmtDateTime(r.time)}</td>
        <td>{!r.complete ? 'History loading' : r.forming ? 'Forming' : 'Settled'} · {r.cause}{r.warnings ? ` · ${r.warnings} warnings` : ''}</td>
        <td>{Object.entries(r.plots).slice(0, 6).map(([k,v]) => `${k}: ${v == null ? 'missing' : v.toLocaleString(undefined,{maximumFractionDigits:5})}`).join(' · ')}</td></tr>)}
    </tbody></table></div>
  </details>
}
