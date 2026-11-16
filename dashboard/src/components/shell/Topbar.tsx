import { NavLink, useLocation } from 'react-router-dom'
import { useExecution } from '../../api/queries'
import { bookControlsForPath } from '../../lib/bookNavigation'
import { LOCAL_TZ, fmtMoney, fmtPnl, pnlClass } from '../../lib/format'
import { liveStatus } from '../../lib/liveStatus'
import { BrandMark } from '../Brand'
import { IconMenu, IconSearch } from '../Icons'
import { AccountBadge } from '../kit'
import { BookSwitch, MlLensToggle } from '../kit/books'
import { AccountMenu, type AccountUser } from './AccountMenu'
import type { RouteMeta } from './nav'

type Risk = {
  halted?: boolean
  haltReason?: string | null
  leverageMult?: number
  drawdownPct: number
  day?: { pnl: number } | null
  sizing?: { from?: string; drawdownPct?: number; startEquity?: number } | null
}

/** The slim bar above every page: where you are, search, the account's vital signs, the entries switch, the account menu. */
export function Topbar({
  meta,
  menuRef,
  drawerOpen,
  onOpenDrawer,
  onOpenPalette,
  mode,
  equity,
  risk,
  riskReady,
  online,
  canTrade,
  paused,
  pending,
  onPause,
  onResume,
  user,
  isAdmin,
  theme,
  onToggleTheme,
  density,
  onToggleDensity,
  onShowKeys,
  onResetPaper,
  onSignOut,
}: {
  meta: RouteMeta
  menuRef: React.RefObject<HTMLButtonElement | null>
  drawerOpen: boolean
  onOpenDrawer: () => void
  onOpenPalette: () => void
  mode: string | undefined
  equity: number | undefined
  risk: Risk | undefined
  riskReady: boolean
  online: boolean
  canTrade: boolean
  paused: boolean
  pending: boolean
  onPause: () => void
  onResume: () => void
  user: AccountUser
  isAdmin: boolean
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  density: 'comfortable' | 'compact'
  onToggleDensity: () => void
  onShowKeys: () => void
  onResetPaper?: () => void
  onSignOut: () => void
}) {
  const controls = bookControlsForPath(useLocation().pathname)
  const execution = useExecution()
  const live = liveStatus(execution.isError ? undefined : execution.data)
  const bookLabel = !mode ? 'loading' : mode === 'paper' ? 'paper account' : mode
  return (
    <header className="topbar">
      <button
        ref={menuRef}
        aria-controls="primary-sidebar"
        className="iconbtn topbar-menu"
        onClick={onOpenDrawer}
        aria-label="Open the menu"
        aria-expanded={drawerOpen}
      >
        <IconMenu />
      </button>
      <span className="mobile-brand" aria-label="VN EDGE">
        <BrandMark />
      </span>
      <nav className="crumb" aria-label="Breadcrumb">
        {meta.section && <span className="muted crumb-section">{meta.section}</span>}
        {meta.section && (
          <span className="crumb-sep" aria-hidden>
            ›
          </span>
        )}
        {meta.parent && (
          <>
            <NavLink to={meta.parent.to} className="muted">
              {meta.parent.label}
            </NavLink>
            <span className="crumb-sep" aria-hidden>
              ›
            </span>
          </>
        )}
        <b className="crumb-title">{meta.title}</b>
        <span
          className="pill pill-muted hide-mid"
          title="Times are shown in your local zone; hover any time for UTC"
        >
          {LOCAL_TZ}
        </span>
      </nav>

      {controls.scope && <BookSwitch liveState={live.label} />}
      {controls.mlLens && <MlLensToggle />}

      <button
        type="button"
        className="search-trigger"
        onClick={onOpenPalette}
        aria-label="Search pages, scanners and actions"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <IconSearch size={15} />
        <span className="search-trigger-text">Search or jump to…</span>
        <kbd className="search-trigger-kbd" aria-hidden>
          ⌘K
        </kbd>
      </button>

      <div className="topbar-status">
        {!mode ? (
          <span className="pill pill-muted">Account: loading</span>
        ) : (
          <AccountBadge mode={mode as never} short />
        )}
        <span className="topstat topstat-eq" title={`Equity (USD) · ${bookLabel}`}>
          <span className="topstat-label">Equity</span>
          <span className="mono">{equity !== undefined ? fmtMoney(equity, 0) : '–'}</span>
        </span>
        <span
          className="topstat topstat-day"
          title="Equity change since 00:00 UTC, open positions included: the figure the daily kill switch watches"
        >
          <span className="topstat-label">Day · UTC</span>
          <span className={`mono ${pnlClass(risk?.day?.pnl)}`}>{risk?.day ? fmtPnl(risk.day.pnl) : '–'}</span>
        </span>
        {risk && risk.leverageMult !== undefined && risk.leverageMult < 1 && (
          <span
            className="topstat"
            title={
              risk.sizing?.from === 'peak'
                ? `New positions are sized at ${Math.round(risk.leverageMult * 100)}% while the account is ${risk.drawdownPct.toFixed(1)}% below its peak equity. Full size returns once the drawdown recovers below the threshold (risk.ddScale).`
                : `New positions are sized at ${Math.round(risk.leverageMult * 100)}% while equity is ${(risk.sizing?.drawdownPct ?? 0).toFixed(1)}% below the starting capital of ${fmtMoney(risk.sizing?.startEquity ?? 0, 0)}. Full size returns once equity is back above it (risk.ddScale, risk.ddFrom).`
            }
          >
            <span className="topstat-label">Size</span>
            <span className="mono">{Math.round(risk.leverageMult * 100)}%</span>
          </span>
        )}
      </div>

      <div className="topbar-actions">
        {canTrade &&
          (paused ? (
            <button
              className="btn btn-sm btn-entries"
              title={`Entries halted — ${risk?.haltReason ?? 'risk limit'}. Resuming clears the halt and restarts the day and week windows from the current equity. Open positions keep running their exits.`}
              onClick={onResume}
              disabled={!online || !riskReady || pending}
            >
              {pending ? 'Resuming…' : '▶ Resume entries'}
            </button>
          ) : (
            <button
              className="btn btn-sm btn-danger-outline btn-entries"
              title="Kill switch: no new entries until resumed. Open positions keep running their exits."
              onClick={onPause}
              disabled={!online || !riskReady || pending}
            >
              Pause entries
            </button>
          ))}
        <AccountMenu
          user={user}
          isAdmin={isAdmin}
          theme={theme}
          onToggleTheme={onToggleTheme}
          density={density}
          onToggleDensity={onToggleDensity}
          onShowKeys={onShowKeys}
          onResetPaper={onResetPaper}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  )
}
