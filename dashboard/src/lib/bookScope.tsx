import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseScope, type BookScope } from './books'

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
    const fromUrl = new URLSearchParams(window.location.search).get('book')
    if (fromUrl) return parseScope(fromUrl)
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
  const [scope, setScopeState] = useState<BookScope>(readInitial)
  const [mlLens, setLens] = useState<boolean>(readLens)
  useEffect(() => {
    try { localStorage.setItem(SCOPE_KEY, scope) } catch { /* ignore */ }
  }, [scope])
  useEffect(() => {
    try { localStorage.setItem(LENS_KEY, mlLens ? 'on' : 'off') } catch { /* ignore */ }
  }, [mlLens])
  const setScope = useCallback((s: BookScope) => setScopeState(s), [])
  const toggleMlLens = useCallback(() => setLens((v) => !v), [])
  const value = useMemo(() => ({ scope, setScope, mlLens, toggleMlLens }), [scope, setScope, mlLens, toggleMlLens])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useBook(): BookApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('useBook outside BookProvider')
  return c
}
