import { Link } from 'react-router-dom'
import { useMarkets } from '../api/queries'
import type { Signal } from '../api/types'
import { fmtPrice, truncate } from '../lib/format'
import { useSSE } from '../sse/SSEProvider'
import { ScoreBadge, SidePill, StatusDot, Time } from './ui'

/** Telegram-bot-style alerts feed: one card per signal. */
export function AlertsFeed({ signals, limit = 15, title = 'VNEdge Bot' }: { signals: Signal[]; limit?: number; title?: string }) {
  const { status } = useSSE()
  const { data: markets } = useMarkets()
  const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize
  const list = signals.slice(0, limit)
  return (
    <div className="alerts">
      <div className="alerts-head">
        <span className="alerts-avatar" aria-hidden>
          V
        </span>
        <div>
          <div className="alerts-title">{title}</div>
          <div className="alerts-sub">
            <StatusDot tone={status === 'connected' ? 'ok' : 'warn'} /> {status === 'connected' ? 'online' : status}
          </div>
        </div>
      </div>
      <div className="alerts-body">
        {list.length === 0 && (
          <div className="muted small">
            No signals yet.
            <div className="empty-hint">Enable a scanner and wait for the next closed bar.</div>
          </div>
        )}
        {list.map((s) => (
          <div key={s.id} className={`alert-card alert-${s.kind}`}>
            <div className="alert-row">
              <span className="alert-sym">
                {s.symbol} <span className="muted small mono">{s.tf}</span>
              </span>
              <span className="mono">{fmtPrice(s.price, tick(s.symbol))}</span>
            </div>
            <div className="alert-row">
              <span className="alert-desc">
                <SidePill side={s.side} /> <span className="muted">{s.kind}</span>
                {s.sl != null && (
                  <span className="mono small muted">
                    {' '}
                    · SL {fmtPrice(s.sl, tick(s.symbol))}
                  </span>
                )}
                {s.tp?.[0] != null && <span className="mono small muted"> · TP {fmtPrice(s.tp[0], tick(s.symbol))}</span>}
              </span>
              <ScoreBadge score={s.score} />
            </div>
            {s.message && (
              <div className="alert-msg" title={s.message}>
                {truncate(s.summary || s.message, 110)}
              </div>
            )}
            <div className="alert-foot">
              <Time t={s.at} mode="ago" />
              <Link to={`/scanners/${s.scannerId}`} className="link">
                {s.scannerName}
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
