import { useState } from 'react'
import { useScreenNow } from '../api/queries'
import { useAuth } from '../auth/AuthGate'
import { useToast } from '../lib/toast'

const TFS = ['15m', '1h', '4h'] as const

/**
 * Decision 174: "Screen now" — queue the nightly screen for one script, everything by an author, or a family, on one
 * timeframe. The job runs capped and never over the nightly; the Incubator page shows the queue, and the alert channel
 * says when it is done.
 */
export function ScreenNow({ ids, author, family, label, compact = false }: { ids?: string[]; author?: string; family?: string; label: string; compact?: boolean }) {
  const auth = useAuth()
  const toast = useToast()
  const [tf, setTf] = useState<(typeof TFS)[number]>('15m')
  const run = useScreenNow()
  if (!auth.canTrade) return null
  const submit = () =>
    run.mutate(
      { ids, author, family, tf },
      {
        onSuccess: (job) => {
          const fresh = Date.now() - job.requestedAt < 3000
          toast.success(fresh ? `Queued: ${job.label} on ${job.tf}` : `Already ${job.status}: ${job.label} on ${job.tf}`, `${job.ids.length} script${job.ids.length === 1 ? '' : 's'} · progress on the Incubator page`)
        },
        onError: (e) => toast.error('Screen not queued', e.message),
      },
    )
  return (
    <span className={`screen-now ${compact ? 'screen-now-compact' : ''}`}>
      <select className="select select-sm" value={tf} onChange={(e) => setTf(e.target.value as (typeof TFS)[number])} aria-label={`Timeframe for screening ${label}`}>
        {TFS.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <button className="btn btn-sm" onClick={submit} disabled={run.isPending} title={`Run the screen now for ${label} on the chosen timeframe. One job at a time, capped, never over the nightly screen.`}>
        {run.isPending ? 'Queuing…' : compact ? `Screen ${label}` : 'Screen now'}
      </button>
    </span>
  )
}
