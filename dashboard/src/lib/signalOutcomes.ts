import type { Signal } from '../api/types'

/** The fate of a batch of signals, in the operator's words: how many became trades, and what refused the rest. */
export function summarizeOutcomes(rows: Signal[]) {
  const defs: Array<{ key: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'muted' | 'accent'; hint: string; test: (a: string, s: Signal) => boolean }> = [
    { key: 'opened', label: 'opened', tone: 'ok', hint: 'became a position', test: (a, s) => s.kind === 'entry' && (a === 'opened' || a === 'reversed') },
    { key: 'pending', label: 'order pending', tone: 'accent', hint: 'An order is waiting for a fill; it is not an opened trade.', test: (a) => a === 'pending' || a.startsWith('pending:') },
    { key: 'market', label: 'market not suitable', tone: 'warn', hint: 'the markets-today gate: illiquid, too quiet to pay the round trip, or not paying recently (decision 56)', test: (a) => a.startsWith('rejected:market') || a.startsWith('rejected:risk market') },
    { key: 'fee', label: 'stop too tight for fees', tone: 'warn', hint: 'The modeled stop distance is below the configured multiple of round-trip costs. This is an admission rule, not a prediction of the trade outcome.', test: (a) => /stop too tight/.test(a) },
    { key: 'capacity', label: 'margin / position cap', tone: 'warn', hint: 'no room in the account: margin, position limits, or a scrap-sized fill refused (decision 53)', test: (a) => /margin|max positions|position cap|intended size|budget/.test(a) },
    { key: 'received', label: 'awaiting decision', tone: 'warn', hint: 'Saved receipt waiting for processing or recovery', test: (a) => a.startsWith('received:') },
    { key: 'stale', label: 'stale (scan too late)', tone: 'danger', hint: 'the scan finished after the signal aged out', test: (a) => /stale/.test(a) },
    { key: 'halted', label: 'halted / loss limit', tone: 'danger', hint: 'kill switch, daily or weekly loss limit, cooldown', test: (a) => /halt|loss limit|cooldown/.test(a) },
    { key: 'regime', label: 'regime', tone: 'muted', hint: 'weekend or ATR floor', test: (a) => /regime/.test(a) },
    { key: 'exitnopos', label: 'exit, no position', tone: 'muted', hint: 'an exit signal with nothing open to close', test: (a) => /no position/.test(a) },
    { key: 'inpos', label: 'already in position', tone: 'muted', hint: 'the scanner already holds this market', test: (a) => /already in position/.test(a) },
    { key: 'reset', label: 'before the last reset', tone: 'muted', hint: 'the paper account was reset after this signal; whatever it did is no longer in the journal', test: (a) => a === 'reset' },
    { key: 'exit', label: 'exit executed', tone: 'accent', hint: 'An exit or partial reduction, not a new entry.', test: (a, s) => s.kind === 'exit' && (a === 'closed' || a === 'reduced') },
    { key: 'info', label: 'info only', tone: 'muted', hint: 'a marker or note the script drew, not a trade call', test: (a, s) => a === 'info' || s.kind === 'info' },
  ]
  const counts = new Map<string, number>()
  let entries = 0
  for (const s of rows) {
    const a = String(s.action ?? '')
    if (s.kind === 'entry') entries++
    const d = defs.find((x) => x.test(a, s))
    const k = d ? d.key : a.startsWith('rejected') ? 'other-rejected' : 'other'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const buckets = defs.filter((d) => counts.get(d.key)).map((d) => ({ ...d, n: counts.get(d.key)! }))
  if (counts.get('other-rejected')) buckets.push({ key: 'other-rejected', label: 'rejected (other)', tone: 'warn', hint: 'see the Action column', n: counts.get('other-rejected')!, test: () => false })
  if (counts.get('other')) buckets.push({ key: 'other', label: 'other', tone: 'muted', hint: '', n: counts.get('other')!, test: () => false })
  return { total: rows.length, entries, opened: counts.get('opened') ?? 0, buckets }
}


/** The gate an action names, in the operator's words, with where to read about it (decision 120). */
export function gateOf(action: string | null | undefined): { key: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'muted' | 'accent'; href?: string } {
  const a = String(action ?? '')
  if (a === 'opened' || a === 'reversed') return { key: 'opened', label: 'opened', tone: 'ok' }
  if (a === 'pending' || a.startsWith('pending:')) return { key: 'pending', label: 'order pending', tone: 'accent' }
  if (a.startsWith('received:')) return { key: 'received', label: 'awaiting decision', tone: 'warn' }
  if (a.startsWith('rejected:risk regime')) return { key: 'regime', label: 'regime gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:stop too tight')) return { key: 'cost', label: 'cost rule', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:risk market') || a.startsWith('rejected:market')) return { key: 'market', label: 'market gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:unpriceable')) return { key: 'quote', label: 'no quote', tone: 'warn', href: '/gates' }
  if (/rejected:(risk )?(max |margin|budget)/.test(a) || /positions on|position budget/.test(a)) return { key: 'capacity', label: 'capacity', tone: 'warn', href: '/gates' }
  if (/rejected:risk (burst|re-entry|cooldown)/.test(a)) return { key: 'guard', label: 'guard', tone: 'muted', href: '/gates' }
  if (/halt|loss limit/.test(a)) return { key: 'halt', label: 'halted', tone: 'danger', href: '/gates' }
  if (/stale/.test(a)) return { key: 'stale', label: 'stale', tone: 'danger' }
  if (/rejected:ml/.test(a)) return { key: 'model', label: 'model gate', tone: 'warn', href: '/learn' }
  if (/trend/.test(a)) return { key: 'trend', label: 'trend gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('ignored')) return { key: 'ignored', label: 'ignored', tone: 'muted' }
  if (a === 'reset') return { key: 'reset', label: 'before reset', tone: 'muted' }
  if (a === 'closed' || a === 'reduced') return { key: 'exit', label: a, tone: 'accent' }
  if (a === 'info') return { key: 'info', label: 'info', tone: 'muted' }
  return { key: 'other', label: a.replace(/^rejected:/, '').slice(0, 24) || '—', tone: 'muted' }
}

