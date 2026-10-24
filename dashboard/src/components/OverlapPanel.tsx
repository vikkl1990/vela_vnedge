import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Empty, Panel } from './ui'

/**
 * Decision 194: where the shadow book's evidence is less independent than it looks — library copies of one script
 * (screened once, under the canonical id) and shadow pairs whose entries land within seconds of each other.
 */
export function OverlapPanel() {
  const [days, setDays] = useState(30)
  const overlap = useQuery({ queryKey: ['incubator', 'overlap', days], queryFn: () => api.incubatorOverlap(days), refetchInterval: 5 * 60_000 })
  const dups = useQuery({ queryKey: ['scanners', 'duplicates'], queryFn: api.scannerDuplicates, staleTime: 10 * 60_000 })
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return (
    <Panel
      title="Overlapping evidence"
      right={
        <select className="select select-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {[7, 30, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
        </select>
      }
    >
      <p className="muted small">Shadow pairs whose entries on the same market, timeframe and side land within 5 seconds of each other, at least 5 times and in half the smaller pair's trades. Each cluster is closer to one exposure than to several.</p>
      {!overlap.data ? <p className="muted small">{overlap.isError ? 'The server did not answer.' : 'Loading…'}</p> : overlap.data.length === 0 ? <Empty label="No overlapping shadow pairs." /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Cluster</th><th className="num">Trades</th><th className="num">Shared entries</th><th>Strongest link</th></tr></thead>
            <tbody>
              {overlap.data.slice(0, 40).map((c) => {
                const top = [...c.links].sort((a, b) => b.shared - a.shared)[0]
                return (
                  <tr key={c.members.join(',')}>
                    <td className="mono small">{c.members.map((m) => m.replace(/\|/g, ' ')).join(' · ')}</td>
                    <td className="num mono">{c.trades}</td>
                    <td className="num mono">{c.sharedTrades}</td>
                    <td className="small">{top.shared} of {Math.min(top.aTrades, top.bTrades)} ({pct(top.share)})</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary className="small">Library copies screened once ({dups.data?.reduce((a, g) => a + g.aliases.length, 0) ?? '…'})</summary>
        {dups.data && dups.data.length > 0 ? (
          <ul className="plain-list small">
            {dups.data.map((g) => (
              <li key={g.identity}><span className="mono">{g.canonical}</span> <span className="muted">also as</span> <span className="mono">{g.aliases.join(', ')}</span></li>
            ))}
          </ul>
        ) : <p className="muted small">{dups.data ? 'No copies in the library.' : 'Loading…'}</p>}
      </details>
    </Panel>
  )
}
