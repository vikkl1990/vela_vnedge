import { Link, useLocation } from 'react-router-dom'
import { patchSearch } from '../lib/researchNavigation'

/** Real links support keyboard navigation, history and opening a view in another tab. */
export function ResearchSections({ label, value, options }: {
  label: string
  value: string
  options: readonly { value: string; label: string; count?: number }[]
}) {
  const location = useLocation()
  return <nav className="research-sections" aria-label={label}>
    {options.map(option => <Link key={option.value}
      to={{ pathname: location.pathname, search: `?${patchSearch(new URLSearchParams(location.search), { section: option.value })}`, hash: '' }}
      preventScrollReset aria-current={value === option.value ? 'page' : undefined}
      className={value === option.value ? 'is-current' : ''}>
      {option.label}{option.count !== undefined && <span className="research-count">{option.count}</span>}
    </Link>)}
  </nav>
}
