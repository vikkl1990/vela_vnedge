import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useBackendOnline, useHealth, useKill, usePositions, useResetPaper, useResume, useRisk, useScannerIndex, useStats } from '../api/queries'
import { RiskBanner } from './RiskBanner'
import { ContextBar } from './ContextBar'
import { useAuth } from '../auth/AuthGate'
import { useDensity } from '../lib/density'
import { fmtAge, fmtMoney, fmtPnl, LOCAL_TZ, pnlClass } from '../lib/format'
import { useHotkeys, type Hotkey } from '../lib/hotkeys'
import { useTheme } from '../lib/theme'
import { useToast } from '../lib/toast'
import { useNow } from '../lib/useNow'
import { useSSE } from '../sse/SSEProvider'
import { RouteErrorBoundary } from './ErrorBoundary'
import {
  IconActivity,
  IconBars,
  IconBell,
  IconBook,
  IconBookmark,
  IconCalendar,
  IconCandles,
  IconExchange,
  IconFlask,
  IconGraduation,
  IconLogo,
  IconMenu,
  IconMoon,
  IconPanelLeft,
  IconRows,
  IconScan,
  IconSettings,
  IconShield,
  IconSun,
  IconTarget,
  IconTerminal,
  IconTrades,
  IconUser,
  IconUsers,
} from './Icons'
import { BookBadge, ConfirmDialog, StatusDot } from './ui'

type NavItem = { to: string; label: string; icon: (p: { size?: number }) => ReactElement; key: string; end?: boolean; adminOnly?: boolean }

/** Decision 169: the twenty pages in four groups, read down a sidebar instead of across a row of pills. */
const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Trade',
    items: [
      { to: '/', label: 'Overview', icon: IconActivity, end: true, key: 'o' },
      { to: '/signals', label: 'Signals', icon: IconBell, key: 'i' },
      { to: '/trades', label: 'Trades', icon: IconTrades, key: 't' },
      { to: '/chart', label: 'Chart', icon: IconCandles, key: 'c' },
    ],
  },
  {
    label: 'Research',
    items: [
      { to: '/scanners', label: 'Scanners', icon: IconScan, key: 's' },
      { to: '/library', label: 'Library', icon: IconBook, key: 'b' },
      { to: '/incubator', label: 'Incubator', icon: IconFlask, key: 'n' },
      { to: '/trackers', label: 'Trackers', icon: IconTarget, key: 'r' },
      { to: '/analytics', label: 'Analytics', icon: IconBars, key: 'a' },
      { to: '/daily', label: 'Daily', icon: IconCalendar, key: 'y' },
      { to: '/learn', label: 'Learn', icon: IconGraduation, key: 'l' },
      { to: '/decisions', label: 'Decisions', icon: IconBookmark, key: 'd' },
    ],
  },
  {
    label: 'Control',
    items: [
      { to: '/gates', label: 'Gates', icon: IconShield, key: 'k' },
      { to: '/exchange', label: 'Exchange', icon: IconExchange, key: 'x' },
      { to: '/settings', label: 'Settings', icon: IconSettings, key: 'e' },
      { to: '/logs', label: 'Logs', icon: IconTerminal, key: 'g' },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/profile', label: 'Profile', icon: IconUser, key: 'p' },
      { to: '/users', label: 'Users', icon: IconUsers, key: 'u', adminOnly: true },
    ],
  },
]
const STALE_AFTER_MS = 60_000
const SIDE_KEY = 'vnedge.sidebar'

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

/** Route → { title, section, crumb } (scanner detail resolves the scanner's name when loaded). */
function routeMeta(pathname: string, scannerName?: string): { title: string; section: string | null; parent?: { label: string; to: string } } {
  const m = /^\/scanners\/([^/]+)/.exec(pathname)
  if (m) return { title: scannerName ?? decodeURIComponent(m[1]), section: 'Research', parent: { label: 'Scanners', to: '/scanners' } }
  const r = /^\/trades\/(\d+)\/replay/.exec(pathname)
  if (r) return { title: `Trade #${r[1]} replay`, section: 'Trade', parent: { label: 'Trades', to: '/trades' } }
  const seg = pathname === '/' ? '/' : `/${pathname.replace(/^\//, '').split('/')[0]}`
  const group = GROUPS.find((g) => g.items.some((n) => n.to === seg))
  const nav = group?.items.find((n) => n.to === seg)
  return nav ? { title: nav.label, section: group!.label } : { title: 'Not found', section: null }
}

/** Header tick age. Owns the 1 s clock so only this text re-renders. */
function TickAge({ lastTick }: { lastTick: number | null }) {
  const now = useNow(1000)
  // the 1 s clock can lag a tick that has just arrived: clamp so the age never reads as missing
  return <span className="tick-age mono">{fmtAge(lastTick ? Math.max(0, now - lastTick) : null)}</span>
}

/** Stale-stream banner. Owns its own clock for the same reason as TickAge. */
function StaleBanner({ getLastEventAt, enabled }: { getLastEventAt: () => number | null; enabled: boolean }) {
  const now = useNow(1000)
  if (!enabled) return null
  const last = getLastEventAt()
  const silentMs = last ? now - last : null
  if (silentMs == null || silentMs <= STALE_AFTER_MS) return null
  return (
    <div className="banner banner-warn" role="status">
      <StatusDot tone="warn" /> Data may be stale (last update {fmtAge(silentMs)} ago) — the event stream is connected but silent.
    </div>
  )
}

export function Layout() {
  const { theme, toggle } = useTheme()
  const { density, toggle: toggleDensity } = useDensity()
  const sse = useSSE()
  const health = useHealth()
  const stats = useStats()
  const positions = usePositions()
  const scanners = useScannerIndex()
  const { online, checked } = useBackendOnline()
  const toast = useToast()
  const reset = useResetPaper()
  const navigate = useNavigate()
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmPause, setConfirmPause] = useState(false)
  const risk = useRisk()
  const kill = useKill()
  const resume = useResume()
  // a manual pause or a tripped loss limit: either is cleared by the same reset (the halt reason says which)
  const paused = Boolean(risk.data?.halted)
  const [showKeys, setShowKeys] = useState(false)
  const loc = useLocation()
  const auth = useAuth()
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !n.adminOnly || auth.isAdmin) })), [auth.isAdmin])
  const nav = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // ---- sidebar: collapsed to icons on a desktop (remembered), a drawer on a phone ----
  const [collapsed, setCollapsed] = useState(readSidebar)
  const [drawer, setDrawer] = useState(false)
  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDE_KEY, c ? 'open' : 'collapsed')
      } catch {
        /* ignore */
      }
      return !c
    })
  }, [])
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  const h = health.data
  // "not loaded yet" is not "down": defaulting to false flashed a red FEED UNAVAILABLE on every page load
  const feedKnown = health.isSuccess || health.isError
  const feedConnected = h?.feed.connected ?? false
  const lastTick = sse.lastTickAt ?? h?.feed.lastTickAt ?? null
  const s = stats.data
  const openCount = positions.data?.length ?? s?.openPositions ?? 0

  // ---- route meta: document.title + breadcrumb ----
  const scannerId = /^\/scanners\/([^/]+)/.exec(loc.pathname)?.[1]
  const scannerName = scannerId ? scanners.data?.find((x) => x.id === decodeURIComponent(scannerId))?.name : undefined
  const meta = routeMeta(loc.pathname, scannerName)
  useEffect(() => {
    document.title = `VNEdge · ${meta.title}`
  }, [meta.title])

  // ---- connection state ----
  const sseTone = sse.status === 'connected' ? 'ok' : sse.status === 'offline' ? 'danger' : 'warn'
  const sseLabel =
    sse.status === 'connected' ? 'Stream live' : sse.status === 'connecting' ? 'Stream connecting' : sse.status === 'reconnecting' ? `Stream reconnecting (${sse.attempts})` : 'Stream offline'
  const backendDown = (checked && !online) || sse.status === 'offline' || sse.status === 'reconnecting'
  // Freshness is time-derived, so it lives in leaf components with their own 1 s clock.
  // Keeping that clock in Layout re-rendered <Outlet/> — the whole active page — every second.
  const live = sse.status === 'connected' && feedConnected
  const feedTone: 'ok' | 'warn' | 'neutral' = !feedKnown ? 'neutral' : live ? 'ok' : 'warn'
  const feedLabel = !feedKnown ? 'Feed connecting' : live ? 'Feed connected' : 'Feed unavailable'

  // ---- hotkeys ----
  const hotkeys = useMemo<Hotkey[]>(
    () => [
      ...nav.map((n) => ({ keys: `g ${n.key}`, label: `Go to ${n.label}`, run: () => navigate(n.to) })),
      { keys: '[', label: 'Collapse / expand the sidebar', run: toggleSidebar },
      { keys: 't', label: 'Toggle light / dark theme', run: toggle },
      { keys: 'd', label: 'Toggle compact density', run: toggleDensity },
      { keys: '?', label: 'Show this list', run: () => setShowKeys((v) => !v) },
    ],
    [navigate, toggle, toggleDensity, toggleSidebar, nav],
  )
  useHotkeys(hotkeys)

  const bookLabel = !h ? 'loading' : h.mode === 'paper' ? 'paper account' : h.mode

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${drawer ? 'sidebar-open' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="sidebar-backdrop" onClick={() => setDrawer(false)} aria-hidden />
      <aside className="sidebar" aria-label="Sections">
        <div className="sidebar-brand">
          <span className="brand-tile" aria-hidden>
            <IconLogo />
          </span>
          <span className="brand-name _lbl">VNEdge</span>
          <button className="iconbtn sidebar-collapse" onClick={toggleSidebar} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={`${collapsed ? 'Expand' : 'Collapse'} ( [ )`} aria-expanded={!collapsed}>
            <IconPanelLeft />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Primary">
          {groups.map((g) => (
            <div key={g.label} className="sidebar-group">
              <div className="sidebar-group-label _lbl">{g.label}</div>
              {g.items.map((n) => {
                const Icon = n.icon
                return (
                  <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `sidebar-link ${isActive ? 'on' : ''}`} title={collapsed ? `${n.label} (g ${n.key})` : undefined} onClick={() => setDrawer(false)}>
                    <Icon size={17} />
                    <span className="_lbl">{n.label}</span>
                    <kbd className="sidebar-key _lbl" aria-hidden>g {n.key}</kbd>
                  </NavLink>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-conn" title={`${sseLabel} · ${feedLabel} · last tick`}>
            <span className="conn"><StatusDot tone={sseTone} /> <span className="_lbl">{sseLabel}</span></span>
            <span className="conn"><StatusDot tone={feedTone} /> <span className="_lbl">{feedLabel}</span></span>
            <span className="conn _lbl muted">tick <TickAge lastTick={lastTick} /></span>
          </div>
          <div className="sidebar-tools">
            <button className={`iconbtn ${density === 'compact' ? 'iconbtn-on' : ''}`} onClick={toggleDensity} aria-label={`Density: ${density}. Switch to ${density === 'compact' ? 'comfortable' : 'compact'}`} title={`Density: ${density} (d)`} aria-pressed={density === 'compact'}>
              <IconRows />
            </button>
            <button className="iconbtn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle light/dark (t)">
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <button className="iconbtn" onClick={() => setShowKeys(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
              <span aria-hidden>?</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="frame">
        <header className="topbar">
          <button className="iconbtn topbar-menu" onClick={() => setDrawer(true)} aria-label="Open the menu" aria-expanded={drawer}>
            <IconMenu />
          </button>
          <nav className="crumb" aria-label="Breadcrumb">
            {meta.section && <span className="muted">{meta.section}</span>}
            {meta.section && <span className="crumb-sep" aria-hidden>›</span>}
            {meta.parent && (
              <>
                <NavLink to={meta.parent.to} className="muted">{meta.parent.label}</NavLink>
                <span className="crumb-sep" aria-hidden>›</span>
              </>
            )}
            <b>{meta.title}</b>
            <span className="pill pill-muted hide-mid" title="Times are shown in your local zone; hover any time for UTC">{LOCAL_TZ}</span>
          </nav>

          <div className="topbar-status">
            {!h ? <span className="pill pill-muted">Account: loading</span> : <BookBadge book="account" mode={h.mode} />}
            <span className="topstat topstat-eq" title={`Equity (USD) · ${bookLabel}`}>
              <span className="topstat-label">Equity</span>
              <span className="mono">{s ? fmtMoney(s.equity, 0) : '–'}</span>
            </span>
            <span className="topstat topstat-day" title="Equity change since 00:00 UTC, open positions included: the figure the daily kill switch watches">
              <span className="topstat-label">Day</span>
              <span className={`mono ${pnlClass(risk.data?.day?.pnl)}`}>{risk.data?.day ? fmtPnl(risk.data.day.pnl) : '–'}</span>
            </span>
            <span className="topstat" title="Open positions">
              <span className="topstat-label">Open</span>
              <span className="mono">{s ? openCount : '–'}</span>
            </span>
            <span className="topstat hide-mid" title="Worker queue (queued / busy / size)">
              <span className="topstat-label">Queue</span>
              <span className="mono">{h ? `${h.worker.queued}/${h.worker.busy}/${h.worker.size}` : '–'}</span>
            </span>
          </div>

          <div className="topbar-actions">
            {auth.canTrade && (paused ? (
              <button className="btn btn-sm btn-entries" title={`Entries halted — ${risk.data?.haltReason ?? 'risk limit'}. Resuming clears the halt and restarts the day and week windows from the current equity. Open positions keep running their exits.`} onClick={() => resume.mutate()} disabled={!online || resume.isPending}>
                {resume.isPending ? 'Resuming…' : '▶ Resume entries'}
              </button>
            ) : (
              <button className="btn btn-sm btn-danger-outline btn-entries" title="Kill switch: no new entries until resumed. Open positions keep running their exits." onClick={() => setConfirmPause(true)} disabled={!online || kill.isPending}>
                Pause entries
              </button>
            ))}
            {auth.canTrade && (
              <button className="btn btn-sm btn-danger-outline hide-narrow" onClick={() => setConfirmReset(true)} disabled={!online || reset.isPending}>
                Reset paper account
              </button>
            )}
            <span className="account-chip">
              <NavLink to="/profile" className="account-name" title={`${auth.user.username} · ${auth.user.roleLabel}`}>
                <span className="account-avatar" aria-hidden>{(auth.user.displayName || auth.user.username).slice(0, 1).toUpperCase()}</span>
                <span className="hide-narrow">{auth.user.displayName || auth.user.username}</span>
              </NavLink>
              <button className="btn btn-sm" onClick={auth.signOut}>Sign out</button>
            </span>
          </div>
        </header>
        <ContextBar />

        {backendDown && (
          <div className="banner banner-danger" role="alert">
            <StatusDot tone="danger" /> Backend offline — reconnecting{sse.attempts > 0 ? ` (attempt ${sse.attempts})` : ''}…
            <span className="muted"> Pages keep the last known data until <code>/api</code> on localhost:8787 answers.</span>
            {health.error?.message ? <span className="muted"> ({health.error.message})</span> : null}
          </div>
        )}
        <StaleBanner getLastEventAt={sse.getLastEventAt} enabled={!backendDown && sse.status === 'connected'} />
        {h?.lastError && (
          <div className="banner banner-warn" role="status">
            Server last error: <code>{h.lastError}</code>
          </div>
        )}

        <main className="main" id="main" tabIndex={-1}>
          <RiskBanner />
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
        {/* decision 121: on a phone the four views an operator checks in on sit in a bar at the bottom */}
        <nav className="bottombar" aria-label="Phone">
          <NavLink to="/" end className={({ isActive }) => `bottombar-item ${isActive ? 'on' : ''}`}>Overview</NavLink>
          <NavLink to="/decisions" className={({ isActive }) => `bottombar-item ${isActive ? 'on' : ''}`}>Decisions</NavLink>
          <NavLink to="/trades" className={({ isActive }) => `bottombar-item ${isActive ? 'on' : ''}`}>Positions</NavLink>
          <NavLink to="/signals" className={({ isActive }) => `bottombar-item ${isActive ? 'on' : ''}`}>Signals</NavLink>
        </nav>
      </div>

      <ConfirmDialog
        open={confirmPause}
        title="Pause all new entries?"
        body={<p>The kill switch. No scanner opens a position until you resume; open positions keep running their stops, trails and targets. Nothing is closed.</p>}
        confirmLabel="Pause entries"
        danger
        busy={kill.isPending}
        onCancel={() => setConfirmPause(false)}
        onConfirm={() => { kill.mutate({ reason: `paused by ${auth.user.username}` }, { onSettled: () => setConfirmPause(false) }) }}
      />
      <ConfirmDialog
        open={confirmReset}
        title="Reset paper account?"
        body={
          <p>
            Open positions are closed at market, the record is archived (kept for forensics, hidden from every live view) and the
            account restarts at the configured initial equity. Signals are kept.
          </p>
        }
        confirmLabel="Reset account"
        danger
        busy={reset.isPending}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          reset.mutate(undefined, {
            onSuccess: () => {
              setConfirmReset(false)
              toast.success('Paper account reset')
            },
            onError: (e) => toast.error('Reset failed', e.message),
          })
        }}
      />

      <HotkeysDialog open={showKeys} onClose={() => setShowKeys(false)} hotkeys={hotkeys} />
    </div>
  )
}

function HotkeysDialog({ open, onClose, hotkeys }: { open: boolean; onClose: () => void; hotkeys: Hotkey[] }) {
  return (
    <ConfirmDialog
      open={open}
      title="Keyboard shortcuts"
      confirmLabel="Close"
      onCancel={onClose}
      onConfirm={onClose}
      body={
        <dl className="keys">
          {hotkeys.map((k) => (
            <div key={k.keys} className="keys-row">
              <dt>
                {k.keys.split(' ').map((p, i) => (
                  <kbd key={i}>{p}</kbd>
                ))}
              </dt>
              <dd>{k.label}</dd>
            </div>
          ))}
          <div className="keys-row">
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Close dialogs</dd>
          </div>
        </dl>
      }
    />
  )
}
