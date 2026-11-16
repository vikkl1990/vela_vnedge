/**
 * Stepping through the trades on the page the journal is showing. The list is in the order on screen (newest first by
 * default), so "next" is the row below. Stepping stops at either end of the page instead of wrapping: the page is a slice
 * of a longer list, and wrapping would silently skip the rest.
 */
export interface JournalStep {
  /** 1-based position of the open trade on this page, or null when it is not on this page. */
  position: number | null
  total: number
  prev: number | null
  next: number | null
}

export function journalStep(ids: ReadonlyArray<number>, current: number | null): JournalStep {
  const total = ids.length
  const at = current === null ? -1 : ids.indexOf(current)
  if (at === -1)
    // an open trade that is not on this page (a link, or another page of results): stepping starts from the top
    return { position: null, total, prev: null, next: total ? ids[0] : null }
  return {
    position: at + 1,
    total,
    prev: at > 0 ? ids[at - 1] : null,
    next: at < total - 1 ? ids[at + 1] : null,
  }
}
