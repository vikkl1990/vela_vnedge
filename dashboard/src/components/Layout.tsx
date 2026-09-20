import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useBackendOnline, useHealth, usePositions, useResetPaper, useStats } from '../api/queries'
import { fmtAge, fmtMoney, fmtPnl, pnlClass } from '../lib/format'
import { useTheme } from '../lib/theme'
import { useToast } from '../lib/toast'
import { useNow } from '../lib/useNow'
import { useSSE } from '../sse/SSEProvider'
import {
  IconActivity,
  IconBell,
  IconChart,
  IconList,
  IconLogo,
  IconLogs,
  IconMoon,
  IconScan,
  IconSettings,
  IconSun,
  IconTrades,
} from './Icons'
import { ConfirmDialog, StatusDot } from './ui'

const NAV = [
  { to: '/', label: 'Overview', icon: IconActivity, end: true },
  { to: '/scanners', label: 'Scanners', icon: IconScan },
  { to: '/signals', label: 'Signals', icon: IconBell },
  { to: '/trades', label: 'Trades', icon: IconTrades },
  { to: '/chart', label: 'Chart', icon: IconChart },
  { to: '/settings', label: 'Settings', icon: IconSettings },
  { to: '/logs', label: 'Logs', icon: IconLogs },
]

export function Layout() {
  const { theme, toggle } = useTheme()
  const sse = useSSE()
  const health = useHealth()
  const stats = useStats()
  const positions = usePositions()
  const { online, checked } = useBackendOnline()
  const now = useNow(1000)
  const toast = useToast()
  const reset = useResetPaper()
  const [confirmReset, setConfirmReset] = useState(false)
  const loc = useLocation()

  const h = health.data
  const feedConnected = h?.feed.connected ?? false
  const lastTick = sse.lastTickAt ?? h?.feed.lastTickAt ?? null
  const tickAge = lastTick ? now - lastTick : null
  const s = stats.data
  const openCount = positions.data?.length ?? s?.openPositions ?? 0
  const crumb = `vnedge · delta india · ${h?.mode ?? 'paper'} · ${loc.pathname === '/' ? 'overview' : loc.pathname.slice(1)}`

  const sseTone = sse.status === 'connected' ? 'ok' : sse.status === 'offline' ? 'danger' : 'warn'
  const sseLabel =
    sse.status === 'connected' ? 'SSE live' : sse.status === 'connecting' ? 'SSE connecting' : sse.status === 'reconnecting' ? `SSE reconnecting (${sse.attempts})` : 'SSE offline'

  return (
    <div className="app">
      <header className="topnav">
        <div className="brand">
          <span className="brand-tile">
            <IconLogo />
          </span>
          <span className="brand-name">VNEdge</span>
          <span className="brand-dot" />
        </div>

        <nav className="navpills" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `navpill ${isActive ? 'navpill-on' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="topright">
          <span className="pill pill-accent">{(h?.mode ?? 'paper').toUpperCase()}</span>
          <span className="topstat" title="Equity">
            <span className="topstat-label">EQ</span>
            <span className="mono">{s ? fmtMoney(s.equity, 0) : '–'}</span>
          </span>
          <span className="topstat" title="Today PnL">
            <span className="topstat-label">DAY</span>
            <span className={`mono ${pnlClass(s?.todayPnl)}`}>{s ? fmtPnl(s.todayPnl, 0) : '–'}</span>
          </span>
          <span className="topstat" title="Open positions">
            <span className="topstat-label">POS</span>
            <span className="mono">{openCount}</span>
          </span>
          <span className="topstat" title="Worker queue (queued / busy / size)">
            <span className="topstat-label">Q</span>
            <span className="mono">{h ? `${h.worker.queued}/${h.worker.busy}/${h.worker.size}` : '–'}</span>
          </span>
          <span className="conn" title={sseLabel}>
            <StatusDot tone={sseTone} /> <span className="hide-narrow">{sseLabel}</span>
          </span>
          <span className="conn" title={feedConnected ? 'Market feed connected' : 'Market feed disconnected'}>
            <StatusDot tone={feedConnected ? 'ok' : 'danger'} />{' '}
            <span className="hide-narrow">feed {feedConnected ? 'on' : 'off'}</span>
            <span className="mono muted small"> · tick {fmtAge(tickAge)}</span>
          </span>
          <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmReset(true)} disabled={!online}>
            Reset paper
          </button>
          <button className="iconbtn" onClick={toggle} aria-label="Toggle theme" title="Toggle light/dark">
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      {checked && !online && (
        <div className="banner banner-danger" role="alert">
          Backend offline — cannot reach <code>/api</code> on localhost:8787. Pages will render but data is unavailable.
          {health.error?.message ? <span className="muted"> ({health.error.message})</span> : null}
        </div>
      )}
      {h?.lastError && (
        <div className="banner banner-warn" role="status">
          Server last error: <code>{h.lastError}</code>
        </div>
      )}

      <div className="terminal">
        <div className="terminal-head">
          <span className="tdots">
            <i />
            <i />
            <i />
          </span>
          <span className="tcrumb mono">{crumb}</span>
          <span className={`pill ${sse.status === 'connected' && feedConnected ? 'pill-ok' : 'pill-warn'} live-pill`}>
            <StatusDot tone={sse.status === 'connected' && feedConnected ? 'ok' : 'warn'} />
            {sse.status === 'connected' && feedConnected ? 'LIVE' : 'STALE'}
          </span>
        </div>
        <div className="terminal-body">
          <aside className="rail" aria-label="Sections">
            {NAV.map((n) => {
              const Icon = n.icon
              return (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `rail-btn ${isActive ? 'rail-on' : ''}`} title={n.label} aria-label={n.label}>
                  <Icon size={17} />
                </NavLink>
              )
            })}
            <span className="rail-spacer" />
            <span className="rail-btn muted" title="Scanners: ok / total">
              <IconList size={17} />
            </span>
          </aside>
          <main className="main">
            <Outlet />
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
    </div>
  )
}
