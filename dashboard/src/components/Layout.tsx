import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useBackendOnline, useHealth, usePositions, useResetPaper, useScannerIndex, useStats } from '../api/queries'
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
  IconBell,
  IconChart,
  IconList,
  IconLogo,
  IconLogs,
  IconMoon,
  IconRows,
  IconScan,
  IconSettings,
  IconSun,
  IconTrades,
} from './Icons'
import { ConfirmDialog, StatusDot } from './ui'

const NAV = [
  { to: '/', label: 'Overview', icon: IconActivity, end: true, key: 'o' },
  { to: '/scanners', label: 'Scanners', icon: IconScan, key: 's' },
  { to: '/signals', label: 'Signals', icon: IconBell, key: 'i' },
  { to: '/trades', label: 'Trades', icon: IconTrades, key: 't' },
  { to: '/chart', label: 'Chart', icon: IconChart, key: 'c' },
  { to: '/settings', label: 'Settings', icon: IconSettings, key: 'e' },
  { to: '/analytics', label: 'Analytics', icon: IconChart, key: 'a' },
  { to: '/incubator', label: 'Incubator', icon: IconScan, key: 'n' },
  { to: '/learn', label: 'Learn', icon: IconChart, key: 'l' },
  { to: '/logs', label: 'Logs', icon: IconLogs, key: 'g' },
  { to: '/profile', label: 'Profile', icon: IconSettings, key: 'p' },
  { to: '/users', label: 'Users', icon: IconSettings, key: 'u', adminOnly: true },
]

const STALE_AFTER_MS = 60_000

/** Route → { title, crumb } (scanner detail resolves the scanner's name when loaded). */
function routeMeta(pathname: string, scannerName?: string): { title: string; crumb: string } {
  if (pathname === '/') return { title: 'Overview', crumb: 'overview' }
  const m = /^\/scanners\/([^/]+)/.exec(pathname)
  if (m) {
    const id = decodeURIComponent(m[1])
    return { title: scannerName ?? id, crumb: `scanners / ${id}` }
  }
  const seg = pathname.replace(/^\//, '').split('/')[0]
  const nav = NAV.find((n) => n.to === `/${seg}`)
  return nav ? { title: nav.label, crumb: nav.label.toLowerCase() } : { title: 'Not found', crumb: seg }
}

/** Header tick age. Owns the 1 s clock so only this text re-renders. */
function TickAge({ lastTick }: { lastTick: number | null }) {
  const now = useNow(1000)
  return <span className="mono muted small hide-mid"> · tick {fmtAge(lastTick ? now - lastTick : null)}</span>
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
  const [showKeys, setShowKeys] = useState(false)
  const loc = useLocation()
  const auth = useAuth()
  const nav = NAV.filter((n) => !n.adminOnly || auth.isAdmin)

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
  const crumb = `vnedge · delta india · ${h?.mode ?? 'paper'} · ${meta.crumb}`

  // ---- connection state ----
  const sseTone = sse.status === 'connected' ? 'ok' : sse.status === 'offline' ? 'danger' : 'warn'
  const sseLabel =
    sse.status === 'connected' ? 'SSE live' : sse.status === 'connecting' ? 'SSE connecting' : sse.status === 'reconnecting' ? `SSE reconnecting (${sse.attempts})` : 'SSE offline'
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
      { keys: 't', label: 'Toggle light / dark theme', run: toggle },
      { keys: 'd', label: 'Toggle compact density', run: toggleDensity },
      { keys: '?', label: 'Show this list', run: () => setShowKeys((v) => !v) },
    ],
    [navigate, toggle, toggleDensity, nav],
  )
  useHotkeys(hotkeys)

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topnav">
        <div className="brand">
          <span className="brand-tile" aria-hidden>
            <IconLogo />
          </span>
          <span className="brand-name">VNEdge</span>
          <span className="brand-dot" aria-hidden />
        </div>

        <nav className="navpills" aria-label="Primary">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `navpill ${isActive ? 'navpill-on' : ''}`} aria-current={loc.pathname === n.to ? 'page' : undefined}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="topright">
          <span className="pill pill-accent">{!h ? 'Execution: loading' : h.mode === 'paper' ? 'Paper · simulated fills' : `Execution: ${h.mode}`}</span>
          <span className="topstat" title="Equity (USD)">
            <span className="topstat-label">EQ USD</span>
            <span className="mono">{s ? fmtMoney(s.equity, 0) : '–'}</span>
          </span>
          <span className="topstat" title="Today's PnL">
            <span className="topstat-label">DAY USD</span>
            <span className={`mono ${pnlClass(s?.todayPnl)}`}>{s ? fmtPnl(s.todayPnl) : '–'}</span>
          </span>
          <span className="topstat" title="Open positions">
            <span className="topstat-label">POS</span>
            <span className="mono">{s ? openCount : '–'}</span>
          </span>
          <span className="topstat hide-mid" title="Worker queue (queued / busy / size)">
            <span className="topstat-label">Q</span>
            <span className="mono">{h ? `${h.worker.queued}/${h.worker.busy}/${h.worker.size}` : '–'}</span>
          </span>
          <span className="conn" title={sseLabel}>
            <StatusDot tone={sseTone} /> <span className="hide-narrow">{sseLabel}</span>
          </span>
          <span className="conn" title={feedConnected ? 'Market feed connected' : 'Market feed disconnected'}>
            <StatusDot tone={feedConnected ? 'ok' : 'danger'} />{' '}
            <span className="hide-narrow">feed {feedConnected ? 'on' : 'off'}</span>
            <TickAge lastTick={lastTick} />
          </span>
          {auth.canTrade && (
            <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmReset(true)} disabled={!online || reset.isPending}>
              Reset paper
            </button>
          )}
          <span className="account-chip">
            <NavLink to="/profile" className="account-name" title={`${auth.user.username} · ${auth.user.roleLabel}`}>
              {auth.user.displayName || auth.user.username}
            </NavLink>
            <span className="muted small hide-mid">{auth.user.roleLabel}</span>
            <button className="btn btn-sm" onClick={auth.signOut}>Sign out</button>
          </span>
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
      </header>

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

      <div className="terminal">
        <div className="terminal-head">
          <span className="tdots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span className="tcrumb mono" aria-label="Breadcrumb">
            {crumb}
          </span>
          <span className="tcrumb-tz mono muted small hide-narrow" title="Times are shown in your local zone; hover any time for UTC">
            {LOCAL_TZ}
          </span>
          <span className={`pill ${feedTone === 'ok' ? 'pill-ok' : feedTone === 'warn' ? 'pill-warn' : ''} live-pill`} aria-live="polite">
            <StatusDot tone={feedTone} />
            {feedLabel}
          </span>
        </div>
        <div className="terminal-body">
          <aside className="rail" aria-label="Sections">
            {nav.map((n) => {
              const Icon = n.icon
              return (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `rail-btn ${isActive ? 'rail-on' : ''}`} title={`${n.label} (g ${n.key})`} aria-label={n.label}>
                  <Icon size={17} />
                </NavLink>
              )
            })}
            <span className="rail-spacer" />
            <span className="rail-btn muted" title={h ? `Scanners: ${h.scanners.enabled} enabled / ${h.scanners.runnable} runnable / ${h.scanners.total} total` : 'Scanners'} aria-hidden>
              <IconList size={17} />
            </span>
          </aside>
          <main className="main" id="main" tabIndex={-1}>
            <RouteErrorBoundary>
              <Outlet />
            </RouteErrorBoundary>
          </main>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset paper account?"
        body={
          <p>
            This wipes all open positions, closed trades and the equity curve, and restarts at the configured initial equity. Signals
            are kept.
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
