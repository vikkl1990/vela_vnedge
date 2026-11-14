import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseScope, type BookScope } from './books'
import { useLocation, useNavigate } from 'react-router-dom'
import { scopeFromLocation, scopeLocation, rememberScopeLocation } from './bookNavigation'

const SCOPE_KEY = 'vnedge.book'
const LENS_KEY = 'vnedge.mllens'

interface BookApi {
  /** which book the whole dashboard is looking at; "all" shows every book */
  scope: BookScope
  setScope: (s: BookScope) => void
  /** adds a model score wherever a number has one; changes nothing about trading */
  mlLens: boolean
  toggleMlLens: () => void
}
const Ctx = createContext<BookApi | null>(null)

function readInitial(): BookScope {
  try {
    return parseScope(localStorage.getItem(SCOPE_KEY))
  } catch {
    return 'all'
  }
}
function readLens(): boolean {
  try {
    return localStorage.getItem(LENS_KEY) === 'on'
  } catch {
    return false
  }
}

/** The book scope and the ML lens: dashboard-wide, remembered, and settable from a link with ?book=paper. */
export function BookProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [remembered, setRemembered] = useState<BookScope>(readInitial)
  const scope = scopeFromLocation(location.pathname, location.search, remembered)
  // Derive from each route synchronously, including client links and browser history.
  if (scope !== remembered) setRemembered(scope)
  useEffect(() => {
    const pinned = rememberScopeLocation(location.pathname, location.search, location.hash, scope)
    if (pinned) navigate(pinned, { replace: true })
  }, [navigate, location.pathname, location.search, location.hash, scope])
  const [mlLens, setLens] = useState<boolean>(readLens)
  useEffect(() => {
    try { localStorage.setItem(SCOPE_KEY, scope) } catch { /* ignore */ }
  }, [scope])
  useEffect(() => {
    try { localStorage.setItem(LENS_KEY, mlLens ? 'on' : 'off') } catch { /* ignore */ }
  }, [mlLens])
  const setScope = useCallback((s: BookScope) => {
    navigate(scopeLocation(location.pathname, location.search, location.hash, s))
  }, [navigate, location.pathname, location.search, location.hash])
  const toggleMlLens = useCallback(() => setLens((v) => !v), [])
  const value = useMemo(() => ({ scope, setScope, mlLens, toggleMlLens }), [scope, setScope, mlLens, toggleMlLens])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useBook(): BookApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('useBook outside BookProvider')
  return c
}
