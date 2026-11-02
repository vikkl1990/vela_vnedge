import type { ScriptSnapshot } from './scriptSnapshot'
import { fmtDateTime } from '../lib/format'

export function ScriptReadout({ runs, open, onOpenChange, selectedCount }: {runs: ScriptSnapshot[]; open: boolean; onOpenChange: (open: boolean) => void; selectedCount: number}) {
  return <details id="chart-values" className="panel chart-section" style={{padding: 12}} open={open} onToggle={e => onOpenChange(e.currentTarget.open)}><summary>Scanner calculations · {runs.length} chart runs</summary>
    <p className="muted small">Values from the chart engine. Forming bars are provisional. Entries and refusals remain in the journal beside the chart.</p>
    {!runs.length ? <p>{selectedCount ? 'Waiting for the selected scanners to finish. Any source or calculation errors appear beside the overlay selector.' : <>Select an <a href="#chart-price">overlay scanner above</a> to see its calculated values for each visible timeframe.</>}</p> : <div style={{overflowX: 'auto'}}><table className="table"><thead><tr><th>Scanner / frame</th><th>Bar</th><th>State</th><th>Latest plots</th></tr></thead><tbody>
      {runs.map(r => <tr key={`${r.tf}:${r.id}`}><td>{r.title} · {r.tf}</td><td>{fmtDateTime(r.time)}</td>
        <td>{!r.complete ? 'History loading' : r.forming ? 'Forming' : 'Settled'} · {r.cause}{r.warnings ? ` · ${r.warnings} warnings` : ''}</td>
        <td>{Object.entries(r.plots).slice(0, 6).map(([k,v]) => `${k}: ${v == null ? 'missing' : v.toLocaleString(undefined,{maximumFractionDigits:5})}`).join(' · ')}</td></tr>)}
    </tbody></table></div>}
  </details>
}
