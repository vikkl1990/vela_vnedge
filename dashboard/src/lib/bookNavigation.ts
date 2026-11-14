import { parseScope, SCOPES, type BookScope } from './books.ts'

/** Show controls only on pages that actually consume them. Other pages keep their own labelled filters. */
export function bookControlsForPath(pathname: string) {
  return {
    scope: ['/overview', '/strategies', '/trades'].includes(pathname),
    mlLens: pathname === '/strategies' || /^\/scanners\/[^/]+$/.test(pathname),
  }
}

/** Legacy book links belong to these pages only; /scanners?book=shadow is a catalogue filter. */
export function scopeFromLocation(path: string, search: string, fallback: BookScope): BookScope {
  const p = new URLSearchParams(search)
  if (p.has('bookScope')) return parseScope(p.get('bookScope'))
  if (['/trades', '/strategies', '/overview'].includes(path) && SCOPES.includes(p.get('book') as BookScope)) return parseScope(p.get('book'))
  return fallback
}

export function scopeLocation(pathname: string, search: string, hash: string, scope: BookScope) {
  const p = new URLSearchParams(search)
  p.set('bookScope', scope)
  if (pathname === '/trades') {
    if (scope === 'paper' || scope === 'shadow') p.set('book', scope)
    else if (!['paper', 'shadow'].includes(p.get('book') ?? '')) p.delete('book')
    p.delete('trade')
    p.delete('page')
  }
  return { pathname, search: `?${p}`, hash }
}

/** Pin an implicit selection into this history entry without discarding journal filters. */
export function rememberScopeLocation(pathname: string, search: string, hash: string, scope: BookScope) {
  const p = new URLSearchParams(search)
  if (p.has('bookScope')) return null
  p.set('bookScope', scope)
  return { pathname, search: `?${p}`, hash }
}
