import { NavLink, useLocation } from 'react-router-dom'
import { canonicalPath, HUBS } from '../../lib/routeHubs'

export function HubNav() {
  const { pathname } = useLocation()
  const hub = HUBS.find((h) => pathname === h.root || pathname.startsWith(`${h.root}/`))
  if (!hub) return null
  return (
    <nav className="hub-nav" aria-label={`${hub.label} views`}>
      {hub.tabs.map(([path, label]) => (
        <NavLink className="hub-link" end key={path} to={canonicalPath(path)}>
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
