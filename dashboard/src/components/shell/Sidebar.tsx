import { NavLink } from 'react-router-dom'
import { fmtAge } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { BrandMark } from '../Brand'
import { IconKeyboard, IconMoon, IconPanelLeft, IconRows, IconSun } from '../Icons'
import { StatusDot } from '../kit'
import type { NavGroup } from './nav'

/** Age of the last price tick. Owns the 1 s clock so only this text re-renders. */
function TickAge({ lastTick }: { lastTick: number | null }) {
  const now = useNow(1000)
  return <span className="tick-age mono">{fmtAge(lastTick ? Math.max(0, now - lastTick) : null)}</span>
}

export type Connection = { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }

export function Sidebar({
  groups,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  onClose,
  badges,
  stream,
  feed,
  lastTick,
  density,
  onToggleDensity,
  theme,
  onToggleTheme,
  onShowKeys,
  sidebarRef,
  inert,
}: {
  groups: NavGroup[]
  collapsed: boolean
  onToggleCollapsed: () => void
  onNavigate: () => void
  onClose: () => void
  /** a small count on a nav item, e.g. proposals waiting on Decisions */
  badges: Record<string, { n: number; tone: 'warn' | 'danger' | 'accent'; title: string } | undefined>
  stream: Connection
  feed: Connection
  lastTick: number | null
  density: 'comfortable' | 'compact'
  onToggleDensity: () => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onShowKeys: () => void
  sidebarRef: React.RefObject<HTMLElement | null>
  inert: boolean
}) {
  return (
    <aside ref={sidebarRef} className="sidebar" id="primary-sidebar" aria-label="Sections" inert={inert}>
      <div className="sidebar-brand">
        <BrandMark />
        <span className="brand-name _lbl">VN EDGE</span>
        <button className="iconbtn sidebar-close" aria-label="Close navigation" onClick={onClose}>
          ×
        </button>
        <button
          className="iconbtn sidebar-collapse"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          title={`${collapsed ? 'Expand' : 'Collapse'} ( [ )`}
          aria-expanded={!collapsed}
        >
          <IconPanelLeft />
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        {groups.map((g) => (
          <div key={g.label} className="sidebar-group">
            <div className="sidebar-group-label _lbl">{g.label}</div>
            {g.items.map((n) => {
              const Icon = n.icon
              const badge = badges[n.to]
              return (
                <NavLink
                  key={n.to}
                  aria-label={badge ? `${n.label}, ${badge.title}` : n.label}
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'on' : ''}`}
                  title={collapsed ? `${n.label} (g ${n.key})` : undefined}
                  onClick={onNavigate}
                >
                  <Icon size={17} />
                  <span className="_lbl sidebar-link-text">{n.label}</span>
                  {badge && badge.n > 0 && (
                    <span className={`nav-badge nav-badge-${badge.tone}`} title={badge.title}>
                      {badge.n > 99 ? '99+' : badge.n}
                    </span>
                  )}
                  <kbd className="sidebar-key _lbl" aria-hidden>
                    g {n.key}
                  </kbd>
                </NavLink>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-conn" title={`${stream.label} · ${feed.label} · last tick`}>
          <span className="conn">
            <StatusDot tone={stream.tone} /> <span className="_lbl">{stream.label}</span>
          </span>
          <span className="conn">
            <StatusDot tone={feed.tone} /> <span className="_lbl">{feed.label}</span>
          </span>
          <span className="conn _lbl muted">
            tick <TickAge lastTick={lastTick} />
          </span>
        </div>
        <div className="sidebar-tools">
          <button
            className={`iconbtn ${density === 'compact' ? 'iconbtn-on' : ''}`}
            onClick={onToggleDensity}
            aria-label={`Density: ${density}. Switch to ${density === 'compact' ? 'comfortable' : 'compact'}`}
            title={`Density: ${density} (d)`}
            aria-pressed={density === 'compact'}
          >
            <IconRows />
          </button>
          <button
            className="iconbtn"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title="Toggle light/dark (t)"
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button
            className="iconbtn"
            onClick={onShowKeys}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <IconKeyboard />
          </button>
        </div>
      </div>
    </aside>
  )
}
