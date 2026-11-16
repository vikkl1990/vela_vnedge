import type { Scanner } from '../api/types.ts'

export function readerLabel(s: Pick<Scanner, 'reads'>): string {
  const sources = s.reads?.sources
  return sources == null ? 'Automatic reader' : sources.length ? sources.join(' + ') : 'Entries disabled'
}

/** Allocation, scheduler and signal history are different facts. Never infer a missing signal from a disabled reader alone. */
export function scannerActivity(s: Scanner): {
  key: string
  label: string
  detail: string
  tone: 'muted' | 'ok' | 'warn' | 'danger'
} {
  if (s.health?.quarantined)
    return {
      key: 'fault',
      label: 'Quarantined',
      detail: s.health.reason || s.health.lastError || 'Runtime hold; inspect the error before releasing.',
      tone: 'danger',
    }
  if (s.status !== 'ok')
    return { key: 'fault', label: 'Source unavailable', detail: s.reason || s.status, tone: 'danger' }
  if (!s.enabled && (s.books?.shadow.length ?? 0) + (s.books?.proposed.length ?? 0) > 0)
    return {
      key: 'shadow',
      label: 'Shadow allocated',
      tone: 'muted',
      detail:
        'No direct paper schedule. Shadow signals may enter paper through copying only after evidence and entry checks pass; the direct-paper switch does not control shadow copying.',
    }
  if (!s.enabled)
    return {
      key: 'off',
      label: 'Paper disabled',
      detail: 'No direct paper scans or current shadow allocations.',
      tone: 'muted',
    }
  if (s.scheduledCells == null)
    return {
      key: 'unknown',
      label: 'Schedule unknown',
      detail: 'Scheduling data has not been reported.',
      tone: 'muted',
    }
  if (s.scheduledCells === 0)
    return {
      key: 'unallocated',
      label: 'No paper cells scheduled',
      detail:
        'Check explicit pair assignments and availability. Enabling a scanner alone does not assign pairs.',
      tone: 'warn',
    }
  if (s.reads?.sources?.length === 0)
    return {
      key: 'context',
      label: 'Entries disabled',
      detail: `${s.scheduledCells} paper cells scheduled; the reader has no entry channels.`,
      tone: 'warn',
    }
  if (s.lastRun?.error)
    return { key: 'fault', label: 'Last run failed', detail: s.lastRun.error, tone: 'danger' }
  return {
    key: 'scheduled',
    label: 'Paper scheduled',
    detail: `${s.scheduledCells} cells · ${s.week ? `${s.week.entries} entry signals → ${s.week.opened} opened in 7d` : '7-day activity unavailable'}. A scheduled run does not guarantee a signal.`,
    tone: 'ok',
  }
}
