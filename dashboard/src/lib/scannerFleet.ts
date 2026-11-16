import type { Scanner } from '../api/types'
import { scannerActivity } from './scannerPresentation.ts'

/** On in the account, or allocated in the account, shadow or proposed books. */
export const isTrading = (s: Scanner) =>
  s.enabled || !!(s.books && (s.books.account.length || s.books.shadow.length || s.books.proposed.length))

export const isQuarantined = (s: Scanner) => !!s.health?.quarantined

export type Week = NonNullable<Scanner['week']>

/** What the entry signals of the last seven days ran into, largest first. */
export function weekBlockers(w: Week): Array<[string, number]> {
  return (
    [
      ['waiting', w.pending ?? 0],
      ['pilot cap', w.pilot ?? 0],
      ['native-stop policy', w.protection ?? 0],
      ['gate', w.gate],
      ['fee', w.fee],
      ['regime', w.regime],
      ['guard', w.guard],
      ['other', w.other],
    ] as Array<[string, number]>
  )
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
}

export const weekTitle = (w: Week) =>
  `filled ${w.opened} · pending ${w.pending ?? 0} · pilot cap ${w.pilot ?? 0} · protection ${w.protection ?? 0} · gate ${w.gate} · fee ${w.fee} · regime ${w.regime} · guards ${w.guard} · other ${w.other}`

export function fleetStats(all: Scanner[]) {
  let totalEntries = 0,
    opened = 0,
    lastRunAt = 0
  let top: { name: string; entries: number } | null = null
  let lastRunName: string | null = null
  for (const s of all) {
    if (s.hidden) continue
    const n = s.week?.entries ?? 0
    totalEntries += n
    opened += s.week?.opened ?? 0
    if (n > (top?.entries ?? 0)) top = { name: s.name, entries: n }
    if (s.lastRun && s.lastRun.at > lastRunAt) {
      lastRunAt = s.lastRun.at
      lastRunName = s.name
    }
  }
  return {
    totalEntries,
    opened,
    top: top && totalEntries ? { name: top.name, pct: (top.entries / totalEntries) * 100 } : null,
    lastRunAt: lastRunAt || null,
    lastRunName,
  }
}

export function paperEvidenceSummary(s: Scanner): string | undefined {
  const r = s.paperReadiness
  if (!r) return undefined
  if (r.shadow > 0)
    return `Now: ${r.eligible} of ${r.shadow} shadow cells pass paper-copy checks. ${r.copyEnabled ? (r.eligible > 0 ? 'Copying is on; a fresh signal and entry checks are still required.' : 'Copying is on; review the unmet requirements below.') : 'Copying is off.'}`
  if (r.tracked > 0)
    return `Now: ${r.tracked} watch-only cells; their observations do not count toward promotion. ${r.candidates} shadow admission candidate${r.candidates === 1 ? '' : 's'}.`
  return `Now: no shadow evidence cells; ${r.candidates} admission candidates.`
}

interface AttentionItem {
  s: Scanner
  tone: 'danger' | 'warn'
  text: string
  release?: boolean
  history?: boolean
  evidence?: string
  href?: string
  action?: string
}
/** Setup faults and historical entry reviews are distinct; neither authorizes admission. */
export function worthActingOn(all: Scanner[]): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const s of all) {
    if (s.hidden || !isTrading(s)) continue
    if (s.health?.quarantined) {
      out.push({
        s,
        tone: 'danger',
        text: `is quarantined: ${s.health.reason ?? s.health.lastError}`,
        release: true,
      })
      continue
    }
    const a = scannerActivity(s)
    if (a.key === 'fault') out.push({ s, tone: 'danger', text: `${a.label.toLowerCase()}: ${a.detail}` })
    else if (['unallocated', 'watch', 'shadow'].includes(a.key) && s.enabled && s.scheduledCells === 0)
      out.push({
        s,
        tone: 'warn',
        text:
          a.key === 'shadow'
            ? 'has shadow allocations and no direct paper schedule.'
            : a.key === 'watch'
              ? 'is tracking markets in watch-only mode.'
              : 'has no direct paper schedule or shadow allocations.',
        evidence: paperEvidenceSummary(s),
        href: `/incubator?q=${encodeURIComponent(s.id)}`,
        action: 'Review evidence',
      })
    else if (a.key === 'context')
      out.push({
        s,
        tone: 'warn',
        text: 'is on but its reader has no entry channels, so it cannot open trades.',
      })
    else if (s.week && s.week.entries >= 3 && s.week.opened === 0) {
      const blockers = weekBlockers(s.week)
        .slice(0, 3)
        .map(([label, n]) => `${n} ${label}`)
        .join(' · ')
      out.push({
        s,
        tone: 'warn',
        text: `7-day paper history: ${s.week.entries} entry attempts, 0 fills${s.week.pending ? `, ${s.week.pending} pending` : ''}. ${blockers}.`,
        history: true,
        evidence: paperEvidenceSummary(s),
        href: `/signals?scanner=${encodeURIComponent(s.id)}&kind=entry`,
        action: 'Review signals',
      })
    }
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1))
}
