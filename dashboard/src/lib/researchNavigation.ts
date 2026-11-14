/** URL state is shared by links, filters and Back/Forward; defaults stay out of the URL. */
export function choice<const T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback
}

export function patchSearch(current: URLSearchParams, changes: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** Old bookmarked disclosure anchors continue to select the corresponding view. */
export function sectionFromUrl<T extends string>(search: URLSearchParams, hash: string, sections: readonly T[], fallback: T, aliases: Record<string, T> = {}): T {
  return aliases[hash] ?? choice(search.get('section'), sections, fallback)
}

export function researchHref(path: string, changes: Record<string, string | null>): string {
  const search = patchSearch(new URLSearchParams(), changes).toString()
  return search ? `${path}?${search}` : path
}

/** Tab changes clear legacy anchors so an old bookmark cannot override the selection. */
export function sectionLocation(pathname: string, search: URLSearchParams, section: string | null) {
  const query = patchSearch(search, { section }).toString()
  return { pathname, search: query ? `?${query}` : '', hash: '' }
}

export function signalSectionFromUrl(search: URLSearchParams, hash: string) {
  const sections = ['signals', 'outcomes', 'recovery', 'trace', 'costs'] as const
  const legacy = search.get('section') === 'diagnostics' ? 'trace' : 'signals'
  return sectionFromUrl(search, hash, sections, legacy, { '#signal-diagnostics': 'trace', '#execution-costs': 'costs' })
}

export function scannerSectionFromUrl(search: URLSearchParams, hash: string) {
  const sections = ['trading', 'catalogue', 'quarantined', 'readiness', 'contributions'] as const
  // Filtered directory links must also reach disabled/unallocated scanners.
  const filtered = ['book', 'activity', 'q', 'author', 'category', 'removed'].some(key => search.has(key))
  const fallback = filtered || search.get('section') === 'directory' ? 'catalogue' : 'trading'
  return sectionFromUrl(search, hash, sections, fallback, { '#readiness': 'readiness', '#contributions': 'contributions', '#contribution-ledger': 'contributions' })
}
