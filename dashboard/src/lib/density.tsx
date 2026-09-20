import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Density = 'comfortable' | 'compact'
const KEY = 'vnedge.density'

interface DensityApi {
  density: Density
  toggle: () => void
  set: (d: Density) => void
}
const Ctx = createContext<DensityApi | null>(null)

function readInitial(): Density {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'compact' || v === 'comfortable') return v
  } catch {
    /* ignore */
  }
  return 'comfortable'
}

/** Comfortable / compact spacing, persisted in localStorage and applied as `data-density` on <html>. */
export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<Density>(readInitial)
  useEffect(() => {
    document.documentElement.dataset.density = density
    try {
      localStorage.setItem(KEY, density)
    } catch {
      /* ignore */
    }
  }, [density])
  const toggle = useCallback(() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact')), [])
  const value = useMemo(() => ({ density, toggle, set: setDensity }), [density, toggle])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDensity(): DensityApi {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDensity outside DensityProvider')
  return c
}
