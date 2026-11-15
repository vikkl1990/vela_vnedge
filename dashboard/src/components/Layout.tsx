import { useQuery } from '@tanstack/react-query'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import {
  useBackendOnline,
  useHealth,
  useKill,
  useResetPaper,
  useResume,
  useRisk,
  useScannerIndex,
  useStats,
} from '../api/queries'
import { REFRESH } from '../api/refreshPolicy'
import { useAuth } from '../auth/AuthGate'
import type { PaletteItem } from '../lib/commandSearch'
import { useDensity } from '../lib/density'
import { fmtAge } from '../lib/format'
import { useHotkeys, type Hotkey } from '../lib/hotkeys'
import { legacyPath } from '../lib/routeHubs'
import { useTheme } from '../lib/theme'
import { useToast } from '../lib/toast'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useNow } from '../lib/useNow'
import { useSSE } from '../sse/SSEProvider'
import { ContextBar } from './ContextBar'
import { RouteErrorBoundary } from './ErrorBoundary'
import { ConfirmDialog, Loading, StatusDot } from './kit'
import { QueryFreshness } from './QueryFreshness'
import { RiskBanner } from './RiskBanner'
import { CommandPalette } from './shell/CommandPalette'
import { HubNav } from './shell/HubNav'
import { ACCOUNT_PAGES, PHONE_TABS, routeMeta, visibleGroups } from './shell/nav'
import { Sidebar, type Connection } from './shell/Sidebar'
import { Topbar } from './shell/Topbar'
import { WorkflowGuide } from './WorkflowGuide'

const STALE_AFTER_MS = 60_000
const SIDE_KEY = 'vnedge.sidebar'

function readSidebar(): boolean {
  try {
    return localStorage.getItem(SIDE_KEY) === 'collapsed'
  } catch {
    return false
  }
}

/** Stale-stream banner. Owns its own clock so only this banner re-renders each second. */
function StaleBanner({ getLastEventAt, enabled }: { getLastEventAt: () => number | null; enabled: boolean }) {
  const now = useNow(1000)
  if (!enabled) return null
  const last = getLastEventAt()
  const silentMs = last ? now - last : null
  if (silentMs == null || silentMs <= STALE_AFTER_MS) return null
  return (
    <div className="banner banner-warn" role="status">
      <StatusDot tone="warn" /> Data may be stale (last update {fmtAge(silentMs)} ago) — the event stream is
      connected but silent.
    </div>
  )
}

export function Layout() {
  const { theme, toggle } = useTheme()
  const { density, toggle: toggleDensity } = useDensity()
  const sse = useSSE()
  const health = useHealth()
  const stats = useStats()
  const scanners = useScannerIndex()
  const { online, checked } = useBackendOnline()
  const toast = useToast()
  const reset = useResetPaper()
  const navigate = useNavigate()
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmResume, setConfirmResume] = useState(false)
  const [confirmPause, setConfirmPause] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const risk = useRisk()
  const kill = useKill()
  const resume = useResume()
  // a manual pause or a tripped loss limit: either is cleared by the same reset (the halt reason says which)
  const paused = Boolean(risk.data?.halted)
  const [showKeys, setShowKeys] = useState(false)
  const loc = useLocation()
  const auth = useAuth()
  const groups = useMemo(() => visibleGroups(auth.isAdmin), [auth.isAdmin])
  const nav = useMemo(
    () => [...groups.flatMap((g) => g.items), ...ACCOUNT_PAGES.filter((p) => !p.adminOnly || auth.isAdmin)],
    [groups, auth.isAdmin],
  )

  // ---- sidebar: collapsed to icons on a desktop (remembered), a drawer on a phone ----
  const [collapsed, setCollapsed] = useState(readSidebar)
  const [drawer, setDrawer] = useState(false)
  const mobile = useMediaQuery('(max-width: 900px)')
  const sidebarRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
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
    if (!drawer || !mobile) return
    const menuButton = menuRef.current
    const priorOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    sidebarRef.current?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false)
      if (e.key !== 'Tab') return
      const items = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled)',
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0)
      const first = items[0],
        last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = priorOverflow
      menuButton?.focus()
    }
  }, [drawer, mobile])

  const h = health.data
  // "not loaded yet" is not "down": defaulting to false flashed a red FEED UNAVAILABLE on every page load
  const feedKnown = health.isSuccess || health.isError
  const feedConnected = h?.feed.connected ?? false
  const lastTick = sse.lastTickAt ?? h?.feed.lastTickAt ?? null
  const s = stats.data

  // ---- route meta: document.title + breadcrumb ----
  const scannerId = /^\/scanners\/([^/]+)/.exec(legacyPath(loc.pathname))?.[1]
  const scannerName = scannerId
    ? scanners.data?.find((x) => x.id === decodeURIComponent(scannerId))?.name
    : undefined
  const meta = routeMeta(loc.pathname, scannerName)
  useEffect(() => {
    document.title = `VN EDGE · ${meta.title}`
  }, [meta.title])

  // ---- connection state ----
  const stream: Connection = {
    tone: sse.status === 'connected' ? 'ok' : sse.status === 'offline' ? 'danger' : 'warn',
    label:
      sse.status === 'connected'
        ? 'Stream live'
        : sse.status === 'connecting'
          ? 'Stream connecting'
          : sse.status === 'reconnecting'
            ? `Stream reconnecting (${sse.attempts})`
            : 'Stream offline',
  }
  const backendDown = checked && !online
  const streamInterrupted = sse.status === 'offline' || sse.status === 'reconnecting'
  // Freshness is time-derived, so it lives in leaf components with their own 1 s clock.
  const live = sse.status === 'connected' && feedConnected
  const feed: Connection = {
    tone: !feedKnown ? 'neutral' : live ? 'ok' : 'warn',
    label: !feedKnown ? 'Feed connecting' : live ? 'Feed connected' : 'Feed unavailable',
  }

  // ---- what waits for a decision: a small count on the Decisions link (the same cached query the page uses) ----
  const incubator = useQuery({
    queryKey: ['incubator'],
    queryFn: api.incubator,
    refetchInterval: REFRESH.slow,
    staleTime: 20_000,
  })
  const proposals =
    incubator.data?.pairs.filter((p) => p.stage === 'proposed' || p.stage === 'demote_proposed').length ?? 0
  const badges = useMemo(
    () => ({
      '/strategies':
        proposals > 0
          ? {
              n: proposals,
              tone: 'warn' as const,
              title: `${proposals} proposal${proposals === 1 ? '' : 's'} waiting`,
            }
          : undefined,
    }),
    [proposals],
  )

  // ---- command palette: pages, actions, then scanners once someone types ----
  const palette = useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = nav.map((n) => ({
      id: `page:${n.to}`,
      kind: 'page',
      title: n.label,
      subtitle: n.blurb,
      keywords: n.keywords,
      to: n.to,
      hint: `g ${n.key}`,
    }))
    const acts: PaletteItem[] = [
      {
        id: 'act:theme',
        kind: 'action',
        title: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: 'appearance colour mode',
        hint: 't',
      },
      {
        id: 'act:density',
        kind: 'action',
        title: density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density',
        keywords: 'rows tight spacing',
        hint: 'd',
      },
      {
        id: 'act:sidebar',
        kind: 'action',
        title: collapsed ? 'Expand the sidebar' : 'Collapse the sidebar',
        keywords: 'navigation menu',
        hint: '[',
      },
      { id: 'act:keys', kind: 'action', title: 'Show keyboard shortcuts', hint: '?' },
    ]
    if (auth.canTrade) {
      acts.push(
        paused
          ? {
              id: 'act:resume',
              kind: 'action',
              title: 'Resume entries…',
              subtitle: 'Asks for confirmation',
              keywords: 'kill switch halt',
            }
          : {
              id: 'act:pause',
              kind: 'action',
              title: 'Pause entries…',
              subtitle: 'Asks for confirmation',
              keywords: 'kill switch halt stop',
            },
      )
      if (h?.mode === 'paper')
        acts.push({
          id: 'act:reset',
          kind: 'action',
          title: 'Reset paper account…',
          subtitle: 'Asks for confirmation',
          keywords: 'restart equity',
        })
    }
    acts.push({ id: 'act:signout', kind: 'action', title: 'Sign out' })
    const sc: PaletteItem[] = (scanners.data ?? [])
      .filter((x) => !x.hidden)
      .map((x) => ({
        id: `scanner:${x.id}`,
        kind: 'scanner',
        title: x.name,
        subtitle: x.enabled ? 'enabled' : x.status === 'ok' ? 'scanner' : x.status,
        keywords: `${x.id} ${x.category ?? ''}`,
        to: `/scanners/${x.id}`,
      }))
    return [...pages, ...acts, ...sc]
  }, [nav, theme, density, collapsed, auth.canTrade, paused, h?.mode, scanners.data])
  const paletteActions = useMemo<Record<string, () => void>>(
    () => ({
      'act:theme': toggle,
      'act:density': toggleDensity,
      'act:sidebar': toggleSidebar,
      'act:keys': () => setShowKeys(true),
      'act:resume': () => setConfirmResume(true),
      'act:pause': () => setConfirmPause(true),
      'act:reset': () => setConfirmReset(true),
      'act:signout': auth.signOut,
    }),
    [toggle, toggleDensity, toggleSidebar, auth.signOut],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setShowPalette((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- hotkeys ----
  const hotkeys = useMemo<Hotkey[]>(
    () => [
      {
        keys: '/',
        label: 'Search pages, scanners and actions (also ⌘K / Ctrl+K)',
        run: () => setShowPalette(true),
      },
      ...nav.map((n) => ({ keys: `g ${n.key}`, label: `Go to ${n.label}`, run: () => navigate(n.to) })),
      { keys: '[', label: 'Collapse / expand the sidebar', run: toggleSidebar },
      { keys: 't', label: 'Toggle light / dark theme', run: toggle },
      { keys: 'd', label: 'Toggle compact density', run: toggleDensity },
      { keys: '?', label: 'Show this list', run: () => setShowKeys((v) => !v) },
    ],
    [navigate, toggle, toggleDensity, toggleSidebar, nav],
  )
  useHotkeys(hotkeys)

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''} ${drawer ? 'sidebar-open' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="sidebar-backdrop" onClick={() => setDrawer(false)} aria-hidden />
      <Sidebar
        sidebarRef={sidebarRef}
        inert={mobile && !drawer}
        groups={groups}
        collapsed={collapsed}
        onToggleCollapsed={toggleSidebar}
        onNavigate={() => setDrawer(false)}
        onClose={() => setDrawer(false)}
        badges={badges}
        stream={stream}
        feed={feed}
        lastTick={lastTick}
        density={density}
        onToggleDensity={toggleDensity}
        theme={theme}
        onToggleTheme={toggle}
        onShowKeys={() => setShowKeys(true)}
      />

      <div className="frame" inert={mobile && drawer}>
        <Topbar
          meta={meta}
          menuRef={menuRef}
          drawerOpen={drawer}
          onOpenDrawer={() => setDrawer(true)}
          onOpenPalette={() => setShowPalette(true)}
          mode={h?.mode}
          equity={s?.equity}
          risk={risk.data}
          riskReady={Boolean(risk.data) && !risk.isError}
          online={online}
          canTrade={auth.canTrade}
          paused={paused}
          pending={paused ? resume.isPending : kill.isPending}
          onPause={() => setConfirmPause(true)}
          onResume={() => setConfirmResume(true)}
          user={auth.user}
          isAdmin={auth.isAdmin}
          theme={theme}
          onToggleTheme={toggle}
          density={density}
          onToggleDensity={toggleDensity}
          onShowKeys={() => setShowKeys(true)}
          onResetPaper={auth.canTrade && h?.mode === 'paper' ? () => setConfirmReset(true) : undefined}
          onSignOut={auth.signOut}
        />
        <ContextBar />

        {backendDown && (
          <div className="banner banner-danger" role="alert">
            <StatusDot tone="danger" /> Backend offline — reconnecting
            {sse.attempts > 0 ? ` (attempt ${sse.attempts})` : ''}…
            <span className="muted">
              {' '}
              Showing the last received data. Trading status cannot be confirmed until the server responds.
            </span>
            {health.error?.message ? <span className="muted"> ({health.error.message})</span> : null}
          </div>
        )}
        {!backendDown && streamInterrupted && (
          <div className="banner banner-warn" role="status">
            Live updates interrupted — reconnecting. The server may still be running; displayed prices can be
            delayed.
          </div>
        )}
        <StaleBanner
          getLastEventAt={sse.getLastEventAt}
          enabled={!backendDown && sse.status === 'connected'}
        />
        {h?.lastError && (
          <div className="banner banner-warn" role="status">
            Server last error: <code>{h.lastError}</code>
          </div>
        )}

        <main className="main" id="main" tabIndex={-1}>
          <QueryFreshness />
          <RiskBanner />
          {loc.pathname !== '/' && <WorkflowGuide />}
          <RouteErrorBoundary>
            <Suspense fallback={<Loading kind="cards" label="Loading the page" />}>
              <div className="route" key={loc.pathname}>
                <HubNav />
                <Outlet />
              </div>
            </Suspense>
          </RouteErrorBoundary>
        </main>
        {/* decision 121: on a phone the four views an operator checks in on sit in a bar at the bottom */}
        <nav className="bottombar" aria-label="Phone">
          {PHONE_TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => `bottombar-item ${isActive ? 'on' : ''}`}
            >
              {t.label}
            </NavLink>
          ))}
          <button
            type="button"
            className="bottombar-item"
            onClick={() => setDrawer(true)}
            aria-controls="primary-sidebar"
            aria-expanded={drawer}
          >
            More
          </button>
        </nav>
      </div>

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        items={palette}
        actions={paletteActions}
      />

      <ConfirmDialog
        open={confirmResume}
        title="Resume entries and reset loss windows?"
        body={
          <p>
            Current halt: {risk.data?.haltReason ?? 'risk limit'}. Resuming clears the halt and starts new
            daily and weekly loss windows from current equity. Open positions continue their existing exits.
          </p>
        }
        confirmLabel="Resume entries"
        busy={resume.isPending}
        onCancel={() => setConfirmResume(false)}
        onConfirm={() =>
          resume.mutate(undefined, {
            onSuccess: () => setConfirmResume(false),
            onError: (e) => toast.error('Could not resume entries', e.message),
          })
        }
      />
      <ConfirmDialog
        open={confirmPause}
        title="Pause all new entries?"
        body={
          <p>
            The kill switch. No scanner opens a position until you resume; open positions keep running their
            stops, trails and targets. Nothing is closed.
          </p>
        }
        confirmLabel="Pause entries"
        danger
        busy={kill.isPending}
        onCancel={() => setConfirmPause(false)}
        onConfirm={() => {
          kill.mutate(
            { reason: `paused by ${auth.user.username}` },
            { onSettled: () => setConfirmPause(false) },
          )
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        title="Reset paper account?"
        body={
          <p>
            Open positions are closed at market, the record is archived (kept for forensics, hidden from every
            live view) and the account restarts at the configured initial equity. Signals are kept.
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

function HotkeysDialog({
  open,
  onClose,
  hotkeys,
}: {
  open: boolean
  onClose: () => void
  hotkeys: Hotkey[]
}) {
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
              <kbd>⌘</kbd>
              <kbd>K</kbd>
            </dt>
            <dd>Open the command palette from anywhere</dd>
          </div>
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
