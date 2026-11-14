import { useLocation, useNavigate } from 'react-router-dom'
import { patchSearch } from './researchNavigation'

export function useResearchFilters() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const set = (changes: Record<string, string | null>, replace = false) => {
    const search = patchSearch(params, changes).toString()
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace, preventScrollReset: true })
  }
  return { params, set, hash: location.hash }
}
