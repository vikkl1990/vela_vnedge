import type { JournalQuery } from '../api/journal'

export type JournalExportRange = 'filtered' | 'complete'
export type JournalExportKind = 'trades' | 'fills'

/** CSV exports cover all matching rows, independently of the table's current page. */
export function journalExportQuery(query: JournalQuery, range: JournalExportRange): JournalQuery {
  if (range === 'complete') return { book: query.book, status: 'closed', history: 'all', scope: 'all', dateBy: 'exit', sort: 'newest' }
  const result = { ...query }
  delete result.limit
  delete result.offset
  return result
}

/** Fetch first so an expired session or server error never navigates away or downloads as CSV. */
export async function fetchJournalCsv(query: JournalQuery, kind: JournalExportKind) {
  const params = new URLSearchParams({ kind })
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const response = await fetch(`/api/journal/export?${params}`, { credentials: 'include', headers: { Accept: 'text/csv' }, cache: 'no-store' })
  if (response.status === 401) throw new Error('Your session expired. Sign in again, then retry the export.')
  if (!response.ok) {
    let message = `Export failed (${response.status}). Please retry.`
    try { const body = await response.json(); if (typeof body.error === 'string') message = body.error } catch { /* keep the HTTP error */ }
    throw new Error(message)
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/csv')) throw new Error('The server did not return a CSV file. Refresh the page and retry.')
  const blob = await response.blob()
  if (!blob.size) throw new Error('The server returned an empty file. Please retry.')
  const supplied = response.headers.get('content-disposition')?.match(/filename="([a-z0-9._-]+\.csv)"/i)?.[1]
  return { blob, filename: supplied ?? `vn-edge-${query.book === 'shadow' ? 'shadow' : 'paper'}-${kind}-${new Date().toISOString().slice(0, 10)}.csv` }
}
