import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Panel } from './ui'

/**
 * Decision 201: every account scanner run over the last day — ok, failed or skipped. The latest-run status hides the
 * failures before a recovery; this keeps them, so a live cell that lost bar-close scans to memory or a deep queue shows.
 */
export function RunHealthPanel() {
  const q = useQuery({ queryKey: ['scanners', 'run-health', 24], queryFn: () => api.runHealth(24), refetchInterval: 5 * 60_000 })
  const rows = q.data ?? []
  const bad = rows.filter((r) => r.failed + r.skipped > 0)
  const total = rows.reduce((a, r) => a + r.ok + r.failed + r.skipped, 0)
  return (
    <Panel title="Account scanner runs, last 24 h" right={<span className="muted small">{rows.length ? `${total} runs · ${rows.length} cells · ${bad.length} with failures or skips` : ''}</span>}>
      {q.isError ? <p className="muted small">The server did not answer /api/scanners/run-health.</p> : !q.data ? <p className="muted small">Loading…</p> : rows.length === 0 ? <p className="muted small">No runs recorded yet: the log starts with decision 201.</p> : bad.length === 0 ? <p className="muted small">Every account cell ran every bar it was due, with no failure or skip.</p> : (
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th>Scanner</th><th>Market</th><th className="num">OK</th><th className="num">Failed</th><th className="num">Skipped</th><th>Last problem</th></tr></thead>
            <tbody>
              {bad.map((r) => (
                <tr key={r.scannerId + r.symbol + r.tf}>
                  <td>{r.scannerId}</td><td className="mono">{r.symbol} · {r.tf}</td>
                  <td className="num mono">{r.ok}</td><td className={`num mono ${r.failed ? 'loss' : ''}`}>{r.failed}</td><td className={`num mono ${r.skipped ? 'loss' : ''}`}>{r.skipped}</td>
                  <td className="muted">{r.lastFailAt ? `${new Date(r.lastFailAt).toISOString().slice(11, 16)} UTC · ` : ''}{(r.lastError ?? '').slice(0, 90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
