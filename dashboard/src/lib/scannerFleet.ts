import type { Scanner } from '../api/types'
import { scannerActivity } from './scannerPresentation'

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
      ['stops', w.protection ?? 0],
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

/** Scanners that are on (or held back) and need a look, worst first. */
export function worthActingOn(
  all: Scanner[],
): Array<{ s: Scanner; tone: 'danger' | 'warn'; text: string; release?: boolean }> {
  const out: Array<{ s: Scanner; tone: 'danger' | 'warn'; text: string; release?: boolean }> = []
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
    else if (a.key === 'unallocated')
      out.push({
        s,
        tone: 'warn',
        text: 'is on but has no paper cells scheduled. Assign pairs for it to run.',
      })
    else if (a.key === 'context')
      out.push({
        s,
        tone: 'warn',
        text: 'is on but its reader has no entry channels, so it cannot open trades.',
      })
    else if (s.week && s.week.entries >= 3 && s.week.opened === 0) {
      const top = weekBlockers(s.week)[0]
      out.push({
        s,
        tone: 'warn',
        text: `gave ${s.week.entries} entry signals in 7 days and none opened${top ? `. Most were held by ${top[0]}.` : '.'}`,
      })
    }
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1))
}
