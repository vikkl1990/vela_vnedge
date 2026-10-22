import { useScreenCancel, useScreenQueue } from '../api/queries'
import { useAuth } from '../auth/AuthGate'
import type { ScreenJob } from '../api/types'
import { timeAgo } from '../lib/format'
import { Empty, Panel, Pill, QueryState } from './ui'

const tone = (s: ScreenJob['status']) => (s === 'done' ? 'ok' : s === 'failed' ? 'danger' : s === 'running' ? 'accent' : s === 'cancelled' ? 'warn' : 'muted') as 'ok' | 'danger' | 'accent' | 'warn' | 'muted'

/** Decision 174: what is being screened on demand, what waits, and what the last runs found. */
export function ScreenQueuePanel() {
  const q = useScreenQueue()
  const cancel = useScreenCancel()
  const auth = useAuth()
  return (
    <Panel title="Screens on demand" right={<span className="muted small">{q.data?.capped ? 'capped: 6 GB, two workers' : 'uncapped (no systemd here)'}</span>}>
      <QueryState {...q} data={q.data} empty="Queue unavailable." onRetry={() => q.refetch()}>
        {(v) => {
          const r = v.running
          const pct = r?.progress && r.progress.scripts > 0 ? Math.min(100, Math.round((r.progress.done / r.progress.scripts) * 100)) : null
          return (
            <div className="sq">
              {r ? (
                <div className="sq-run">
                  <div className="row gap">
                    <Pill tone="accent">RUNNING</Pill>
                    <b>{r.label}</b> <span className="muted">· {r.tf} · {r.ids.length} script{r.ids.length === 1 ? '' : 's'}{r.markets ? ` · ${r.markets.length} markets` : ''} · started {timeAgo(r.startedAt ?? r.requestedAt)} by {r.actor}</span>
                    <span className="grow" />
                    {auth.canTrade && <button className="btn btn-xs btn-danger-outline" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>Cancel</button>}
                  </div>
                  <div className="sq-bar" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Scripts screened">
                    <span className="sq-fill" style={{ width: `${pct ?? 0}%` }} />
                  </div>
                  <div className="small muted mono">
                    {r.progress ? `${r.progress.done}/${r.progress.scripts} scripts · ${r.progress.runs} runs · ${r.progress.passed} passed` : 'loading candles…'}
                    {r.tail.length > 0 && <> · {r.tail[r.tail.length - 1]}</>}
                  </div>
                </div>
              ) : v.queued.length > 0 && v.nightlyRunning ? (
                <p className="small muted">The nightly screen is running; the queue starts when it finishes.</p>
              ) : null}
              {v.queued.length > 0 && (
                <ul className="plain-list small sq-list">
                  {v.queued.map((j) => (
                    <li key={j.id} className="row gap">
                      <Pill tone="muted">QUEUED</Pill> <span>{j.label}</span> <span className="muted">· {j.tf} · {j.ids.length} script{j.ids.length === 1 ? '' : 's'} · {timeAgo(j.requestedAt)} by {j.actor}</span>
                      <span className="grow" />
                      {auth.canTrade && <button className="btn btn-xs" onClick={() => cancel.mutate(j.id)} disabled={cancel.isPending}>Remove</button>}
                    </li>
                  ))}
                </ul>
              )}
              {!r && v.queued.length === 0 && v.history.length === 0 && <Empty label="Nothing screened on demand yet." hint="Use “Screen now” on a script in the Library or on a scanner's page." />}
              {v.history.length > 0 && (
                <ul className="plain-list small sq-list">
                  {v.history.slice(0, 6).map((j) => (
                    <li key={j.id}>
                      <Pill tone={tone(j.status)}>{j.status.toUpperCase()}</Pill> <span>{j.label}</span> <span className="muted">· {j.tf} · {j.finishedAt ? timeAgo(j.finishedAt) : ''}</span>
                      {j.summary && <div className="muted mono sq-summary">{j.summary}</div>}
                      {j.error && <div className="loss sq-summary">{j.error}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        }}
      </QueryState>
    </Panel>
  )
}
