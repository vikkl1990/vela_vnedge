import { Link } from 'react-router-dom'
import type { Scanner } from '../../api/types'
import { IconPlay } from '../../components/Icons'
import { AccountBadge, BookBadge, Pill, Pnl, ScannerStatusPill, Time } from '../../components/kit'
import { fmtMs, fmtPct, fmtProfitFactor } from '../../lib/format'
import { readerLabel, scannerActivity } from '../../lib/scannerPresentation'

export function ScannerCard({
  s,
  showIdentity,
  onToggle,
  onRun,
  busy,
  runBusy,
  onHide,
  onRelease,
}: {
  s: Scanner
  showIdentity?: boolean
  onToggle: (v: boolean) => void
  onRun: () => void
  busy: boolean
  runBusy: boolean
  onHide: () => void
  onRelease: () => void
}) {
  const st = s.stats
  const activity = scannerActivity(s)
  const tfs = Array.isArray(s.pairs)
    ? [...new Set(s.pairs.map((p) => p.tf))].join('/') || 'no pairs'
    : (s.timeframes ?? []).join('/') || 'global'
  return (
    <div className={`card scanner-card ${s.enabled ? 'card-on' : ''}`}>
      <div className="card-head">
        <span className={`dot ${s.enabled ? 'dot-ok' : s.status === 'ok' ? 'dot-neutral' : 'dot-danger'}`} />
        <Link to={`/scanners/${s.id}`} className="card-title">
          {s.name}
          {showIdentity && <span className="small muted"> · {s.id}</span>}
        </Link>
        <span className="card-pills">
          <BookCells s={s} />
          <Pill tone="accent">{tfs.toUpperCase()}</Pill>
          {s.health?.quarantined ? (
            <Pill
              tone="danger"
              title={`Quarantined: ${s.health.reason ?? s.health.lastError}. Not scheduled until released.`}
            >
              quarantined
            </Pill>
          ) : (
            <ScannerStatusPill status={s.status} reason={s.reason} />
          )}
        </span>
      </div>
      <div className="card-summary mono">
        {s.scheduledCells ?? '–'} paper cells · {readerLabel(s)} · {s.entryProtection ?? 'inherit'} protection
        · {s.exitMode} exits
        {s.entryLimit && (
          <div>
            Maker {s.entryLimit.atr} ATR · {s.entryLimit.minutes}m expiry · {s.entryLimit.tfs.join(', ')}
          </div>
        )}
        {s.reads?.labels?.length ? <div>Entry labels: {s.reads.labels.join(', ')}</div> : null}
        <div className="scanner-activity">
          <Pill tone={activity.tone}>{activity.label}</Pill>
          <span>{activity.detail}</span>
        </div>
      </div>
      {s.status !== 'ok' && s.reason && (
        <div className="small loss" title={s.reason}>
          {s.reason.length > 90 ? `${s.reason.slice(0, 89)}…` : s.reason}
        </div>
      )}
      <div className="card-stats">
        <span className="stat-chip">
          <span className="stat-k">TRADES</span>
          <span className="mono">{st?.trades ?? 0}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">WIN</span>
          <span className="mono">{fmtPct(st?.winRatePct)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PF</span>
          <span className="mono">{fmtProfitFactor(st?.profitFactor)}</span>
        </span>
        <span className="stat-chip">
          <span className="stat-k">PNL</span>
          <Pnl value={st?.pnl} />
        </span>
        <span className="stat-chip" title="Backtest profit factor">
          <span className="stat-k">BT PF</span>
          <span className="mono muted">{fmtProfitFactor(st?.backtest?.profitFactor)}</span>
        </span>
      </div>
      <div className="card-foot">
        <span className="muted small">
          {s.lastRun ? (
            <>
              ran <Time t={s.lastRun.at} mode="ago" /> · {fmtMs(s.lastRun.ms)}
              {s.lastRun.error && <span className="loss"> · error</span>}
            </>
          ) : (
            'never run'
          )}
        </span>
        <span className="row-actions">
          <button
            className="btn btn-xs"
            onClick={onHide}
            disabled={busy}
            title={s.hidden ? 'Restore to the list' : 'Remove from the list (disables it)'}
          >
            {s.hidden ? 'Restore' : 'Remove'}
          </button>
          {s.health?.quarantined && (
            <button
              className="btn btn-xs btn-danger-outline"
              onClick={onRelease}
              disabled={busy}
              title={`Quarantined: ${s.health.reason ?? s.health.lastError}. Release it to schedule it again; a repeat failure quarantines it again.`}
            >
              Release
            </button>
          )}
          <button
            className="btn btn-xs"
            onClick={onRun}
            disabled={s.status !== 'ok' || runBusy}
            title="Run now"
          >
            <IconPlay /> Run
          </button>
          <label
            className="switch"
            title={
              s.status !== 'ok'
                ? `Cannot enable: ${s.reason ?? s.status}`
                : s.enabled
                  ? 'Enabled'
                  : 'Disabled'
            }
          >
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={s.status !== 'ok' || busy}
              onChange={(e) => onToggle(e.target.checked)}
              aria-label={`Enable ${s.name}`}
            />
            <span className="switch-ui" />
          </label>
        </span>
      </div>
    </div>
  )
}

/** The scanner's books as badges: the account with its market count, the shadow book with its; nothing when it trades nowhere. */
export function BookCells({ s }: { s: Scanner }) {
  const b = s.books ?? { account: [], shadow: [], proposed: [] }
  if (!b.account.length && !b.shadow.length && !b.proposed.length)
    return <span className="muted small">–</span>
  return (
    <span className="row gap-xs" style={{ display: 'inline-flex', gap: 4 }}>
      {b.account.length > 0 && (
        <span title={`In the account on: ${b.account.join(', ')}`}>
          <AccountBadge generic /> <span className="mono small">{b.account.length}</span>
        </span>
      )}
      {(b.shadow.length > 0 || b.proposed.length > 0) && (
        <span
          title={`In the shadow book on: ${[...b.shadow, ...b.proposed].join(', ')}${b.proposed.length ? ` · proposed for promotion: ${b.proposed.join(', ')}` : ''}`}
        >
          <BookBadge book="shadow" short />{' '}
          <span className="mono small">{b.shadow.length + b.proposed.length}</span>
        </span>
      )}
    </span>
  )
}

export function ShareBar({ pct }: { pct: number }) {
  const label = pct < 10 ? pct.toFixed(1) : pct.toFixed(0)
  return (
    <span className="sc-share" role="img" aria-label={`${label}% of entry signals`}>
      <span className="sc-share-track">
        <span className="sc-share-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="mono small">{label}%</span>
    </span>
  )
}
