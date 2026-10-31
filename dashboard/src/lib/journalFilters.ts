import type { TradeQuery } from '../api/types'

const DAY = 86_400_000
export const JOURNAL_PAGE_SIZE = 50
export const JOURNAL_PERIODS = [
  ['all', 'All history'], ['today', 'Today (UTC)'], ['yesterday', 'Yesterday (UTC)'],
  ['7d', '7 UTC days'], ['30d', '30 UTC days'], ['custom', 'Date range (UTC)'],
] as const

function utcDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined
}

/** Closing dates use UTC, matching Daily. The selected end day is inclusive. */
export function journalFilters(params: URLSearchParams, now: number) {
  const scanner = params.get('scanner') ?? '', symbol = params.get('symbol') ?? ''
  const reason = params.get('reason') ?? '', tf = params.get('tf') ?? '', side = params.get('side') ?? ''
  const period = params.get('period') || 'all'
  const start = params.get('start') ?? '', end = params.get('end') ?? ''
  const pageValue = Number(params.get('page') ?? 0)
  const page = Number.isSafeInteger(pageValue) && pageValue >= 0 && pageValue <= 1_000_000 ? pageValue : 0
  const today = Math.floor(now / DAY) * DAY
  let from: number | undefined, to: number | undefined, error: string | null = null
  if (period === 'today') { from = today; to = today + DAY }
  else if (period === 'yesterday') { from = today - DAY; to = today }
  else if (period === '7d' || period === '30d') { from = today - (period === '7d' ? 6 : 29) * DAY; to = today + DAY }
  else if (period === 'custom') {
    from = utcDate(start)
    const endAt = utcDate(end)
    if (from === undefined || endAt === undefined) error = 'Choose a valid start and end date.'
    else if (from > endAt) error = 'End date must be on or after the start date.'
    else to = endAt + DAY
  } else if (period !== 'all') error = 'Choose a valid closing period.'
  if (side && side !== 'long' && side !== 'short') error = 'Choose Long, Short, or All directions.'
  const query: TradeQuery = { limit: JOURNAL_PAGE_SIZE, offset: page * JOURNAL_PAGE_SIZE,
    scanner: scanner || undefined, symbol: symbol || undefined, reason: reason || undefined,
    tf: tf || undefined, side: side || undefined, from, to }
  return { scanner, symbol, reason, tf, side, period, start, end, page, query, error }
}

export function updateJournalFilters(params: URLSearchParams, updates: Record<string, string>) {
  const next = new URLSearchParams(params)
  next.delete('page')
  for (const [key, value] of Object.entries(updates)) {
    if (value) next.set(key, value); else next.delete(key)
  }
  if (updates.period && updates.period !== 'custom') { next.delete('start'); next.delete('end') }
  return next
}
