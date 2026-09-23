import { Link } from 'react-router-dom'
import { useExecution, useHealth, usePositions, useRisk } from '../api/queries'
import { fmtPct } from '../lib/format'

type Item = { tone: 'danger' | 'warn'; text: string; hint?: string }

/**
 * What an operator must see without going looking: entries halted, the exchange out of step with
 * the book, positions without their protective orders, or a dead feed. It renders nothing when
 * there is nothing wrong, so its presence alone is the signal.
 */
export function RiskBanner() {
  const risk = useRisk()
  const exec = useExecution()
  const health = useHealth()
  const positions = usePositions()

  const items: Item[] = []
  const r = risk.data
  if (r?.halted) items.push({ tone: 'danger', text: `Entries halted — ${r.haltReason ?? 'risk limit'}`, hint: 'Open positions still run to their exits. Clear it on Settings → Risk.' })
  if (r && !r.halted && r.day?.tripped) items.push({ tone: 'warn', text: `Daily loss limit reached (${fmtPct(r.day.pnlPct, 1, true)} of ${r.day.limitPct}%)` })
  if (r && r.leverageMult !== undefined && r.leverageMult < 1) items.push({ tone: 'warn', text: `Position size scaled to ${Math.round(r.leverageMult * 100)}% after a ${fmtPct(r.drawdownPct, 1)} drawdown` })

  const e = exec.data
  if (e && e.mode !== 'paper') {
    const drift = e.lastReconcile?.drift ?? []
    if (drift.length) items.push({ tone: 'danger', text: `Exchange out of step with the book: ${drift.length} difference${drift.length > 1 ? 's' : ''}`, hint: 'The paper book and the exchange account disagree. Reconcile before trading further.' })
    if (e.lastReconcile?.error) items.push({ tone: 'warn', text: `Reconciliation failed: ${e.lastReconcile.error}` })
    if (e.bracket) {
      const unprotected = (positions.data ?? []).filter((p) => !e.brackets.some((b) => b.positionId === p.id && b.stop))
      if (unprotected.length) items.push({
        tone: 'danger',
        text: `${unprotected.length} position${unprotected.length > 1 ? 's' : ''} without a stop order on ${e.host ?? 'the exchange'}: ${unprotected.map((p) => p.symbol).join(', ')}`,
        hint: 'The paper stop still applies, but nothing protects the exchange position if this bot stops.',
      })
    }
  }

  const feed = health.data?.feed
  if (health.data && feed && !feed.connected) items.push({ tone: 'danger', text: 'Market data feed disconnected — prices and P&L are not live' })

  if (!items.length) return null
  return (
    <div className="risk-banner" role="status" aria-live="polite">
      {items.map((it, i) => (
        <div key={i} className={`risk-banner-item risk-${it.tone}`}>
          <strong>{it.text}</strong>
          {it.hint && <span className="muted small"> {it.hint}</span>}
          {i === 0 && <Link className="link small ml" to="/settings">Settings</Link>}
        </div>
      ))}
    </div>
  )
}
