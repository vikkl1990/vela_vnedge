import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query from React.
 *
 * Layout that only CSS can see cannot drop table columns, and a table with eighteen columns in a
 * thousand-pixel pane becomes a horizontal scroll two thirds of a screen wide. This lets the
 * component choose which columns exist rather than letting them overflow.
 *
 * Returns false during server-side or first paint when `matchMedia` is unavailable, so the widest
 * layout is the default and nothing is hidden by accident.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false))

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
