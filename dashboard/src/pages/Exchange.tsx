import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useExchangeCloseAll, useExecution, usePositions, useReconcile } from '../api/queries'
import type { LedgerRow } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { BookBadge, ConfirmDialog, Empty, Loading, Panel, Pill, StatusDot, Time } from '../components/ui'
import { Callout, EmptyState, PageHeader, Stat, StatGrid, TabPanel, Tabs } from '../components/kit'
import '../styles/pages/exchange.css'
import { fmtMoney, fmtPrice, fmtUtc } from '../lib/format'
import { ExecutionQualityPanel } from '../components/ExecutionQuality'
import { TapeAuditPanel } from '../components/TapeAuditPanel'
import { ExecutionHandoffPanel } from '../components/ExecutionHandoff'
import { ExecutionAccountingPanel } from '../components/ExecutionAccounting'
import { AccountObserverPanel } from '../components/AccountObserver'

/**
 * The exchange side of the book: what the executor believes the exchange holds, the last time it
 * checked, what it found at start-up, and every order it has sent. Paper mode shows the same page
 * with nothing attached, so the operator learns the layout before anything is live.
 */
type ExchangeTab = 'now' | 'protection' | 'orders' | 'quality'

export function Exchange() {
  const exec = useExecution()
  const positions = usePositions()
  const reconcile = useReconcile()
  const closeAll = useExchangeCloseAll()
  const auth = useAuth()
  const [confirmFlatten, setConfirmFlatten] = useState(false)
  const [tab, setTab] = useState<ExchangeTab>('now')
  const e = exec.data
  if (exec.isLoading) return <Loading rows={6} />
  if (!e) return <Empty label="Execution status unavailable." hint="The server did not answer /api/execution." />
  const live = e.mode !== 'paper' && !e.dryRun
  const drift = e.lastReconcile?.drift ?? []
  const openIds = new Set((positions.data ?? []).map((p) => p.id))
  const unprotected = (positions.data ?? []).filter((p) => live && !e.brackets.some((b) => b.positionId === p.id && b.stop))
  const stateTone = (s: LedgerRow['state']) => (s === 'filled' ? 'ok' : s === 'acknowledged' ? 'accent' : s === 'rejected' || s === 'unknown' ? 'danger' : s === 'cancelled' ? 'muted' : 'warn')

  const stranded = e.stranded ?? []
  const unconfirmed = e.unconfirmed ?? []
  const needsAttention = stranded.length > 0 || unconfirmed.length > 0 || unprotected.length > 0
  const reconcileLabel = !e.lastReconcile ? 'Not run' : e.lastReconcile.error ? 'Unavailable' : e.lastReconcile.ok ? 'In step' : `${drift.length} drift${drift.length === 1 ? '' : 's'}`
  const reconcileTone = !e.lastReconcile ? 'muted' : e.lastReconcile.ok && !e.lastReconcile.error ? 'gain' : 'loss'
  const modeWord = live ? e.mode : e.dryRun ? 'dry-run' : 'paper'
  const modeLabel = modeWord.charAt(0).toUpperCase() + modeWord.slice(1)
  const tabs: Array<{ id: ExchangeTab; label: string; count?: number; attention?: boolean }> = [
    { id: 'now', label: 'Account and link' },
    { id: 'protection', label: 'Protection and recovery', attention: needsAttention },
    { id: 'orders', label: 'Order ledger', count: e.ledger?.length ?? 0 },
    { id: 'quality', label: 'Quality and audit' },
  ]

  return (
    <div className="page exchange-page">
      <PageHeader
        title="Exchange"
        subtitle="What the order executor believes the exchange holds, when it last checked, and every order it sent. In paper mode nothing is attached, so you can learn the layout first."
        meta={<BookBadge book="account" mode={e.dryRun ? 'dry-run' : e.mode} />}
        actions={<>
          <button className="btn btn-sm" onClick={() => reconcile.mutate()} disabled={!e.hasKeys || reconcile.isPending} title={e.hasKeys ? undefined : 'Needs executor API keys'}>
            {reconcile.isPending ? 'Reconciling…' : 'Reconcile now'}
          </button>
          {auth.isAdmin && (
            <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmFlatten(true)} disabled={!live || closeAll.isPending} title={live ? undefined : 'Only available when live orders can reach the exchange'}>
              Flatten exchange account
            </button>
          )}
        </>}
      />

      {stranded.length > 0 && (
        <Callout tone="danger" title="Stranded exposure">
          The book is closed but the exchange still holds {stranded.map((s) => `#${s.positionId} ${s.symbol} ×${s.qty} (${s.attempts} attempt${s.attempts === 1 ? '' : 's'})`).join(', ')}. The stop stays; every sweep sends a reduce-only market order for the rest.
        </Callout>
      )}
      {unprotected.length > 0 && (
        <Callout tone="danger" title="No stop on the exchange">Open positions with no resting stop: {unprotected.map((p) => `#${p.id} ${p.symbol}`).join(', ')}.</Callout>
      )}
      {unconfirmed.length > 0 && (
        <Callout tone="danger" title="Entries not confirmed yet">The exchange has not confirmed #{unconfirmed.join(', #')}. They have no bracket until it does.</Callout>
      )}
      <Callout tone="warn" title="Live trading is not certified yet">
        Paper trading is available. Live needs production account observation, fault tests for protective orders, emergency close and restart recovery, and full fee and balance reconciliation, then a real-order pilot. A good API check proves read access only, not trading permission.
      </Callout>

      <StatGrid min={200}>
        <Stat label="Account mode" value={<span className="exchange-stat-text">{modeLabel}</span>} sub={e.host ? <>host <span className="mono">{e.host}</span></> : 'no exchange attached'} />
        <Stat label="Executor keys" value={<span className="exchange-stat-text">{e.hasKeys ? 'present' : 'none'}</span>} tone={e.hasKeys ? 'gain' : 'muted'} sub={e.hasKeys ? 'from the service environment' : 'reconcile and live orders need keys'} />
        <Stat
          label="Last reconcile"
          value={<span className="exchange-stat-text">{reconcileLabel}</span>}
          tone={reconcileTone}
          sub={e.lastReconcile ? <><Time t={e.lastReconcile.at} mode="ago" /> · {e.lastReconcile.positions} position(s), {e.lastReconcile.orders} order(s)</> : 'has not run yet'}
        />
        <Stat
          label="Brackets resting"
          value={e.brackets.length}
          tone={unprotected.length ? 'loss' : undefined}
          sub={unprotected.length ? `${unprotected.length} open position(s) have no stop` : live ? 'one stop plus target legs per position' : 'nothing attached in this mode'}
        />
      </StatGrid>

      <Tabs value={tab} onChange={setTab} items={tabs} label="Exchange sections" idPrefix="exch" />

      <TabPanel id="now" value={tab} idPrefix="exch">
        <div className="stack">
          <AccountObserverPanel />
          <div className="grid-2 exchange-grid">
            <Panel title="Connection">
              <dl className="kv-list">
                <div><dt>Account</dt><dd><BookBadge book="account" mode={e.dryRun ? 'dry-run' : e.mode} /></dd></div>
                <div><dt>Host</dt><dd className="mono">{e.host ?? '— (paper: no exchange attached)'}</dd></div>
                <div><dt>Executor credentials</dt><dd><StatusDot tone={e.hasKeys ? 'ok' : 'neutral'} /> {e.hasKeys ? 'present (environment)' : 'none'}</dd></div>
                <div><dt>Brackets</dt><dd>{e.host === 'production' ? 'Production resting stops and targets are not certified in this release' : e.bracket ? 'Enabled. Check each order’s state in the ledger.' : 'Off'}</dd></div>
                <div><dt>Products known</dt><dd className="mono">{e.products ?? '–'}</dd></div>
              </dl>
              {auth.isAdmin && <p className="small"><Link to="/settings#delta-connection">Set up a Delta API connection</Link> to start production account observation. Saved connection credentials are separate from the executor.</p>}
            </Panel>

            <Panel title="Order executor reconciliation">
              {!e.lastReconcile ? (
                <EmptyState title="Not run yet" hint={e.hasKeys ? 'Press Reconcile now to compare the ledger with the exchange.' : 'It needs executor API keys first.'} />
              ) : (
                <dl className="kv-list">
                  <div><dt>When</dt><dd title={fmtUtc(e.lastReconcile.at)}><Time t={e.lastReconcile.at} mode="ago" /></dd></div>
                  <div><dt>Result</dt><dd><Pill tone={e.lastReconcile.ok ? 'ok' : 'danger'}>{e.lastReconcile.error ? 'Unavailable' : e.lastReconcile.ok ? 'in step' : `${drift.length} drift(s)`}</Pill>{e.lastReconcile.error ? <span className="muted small"> {e.lastReconcile.error}</span> : null}</dd></div>
                  <div><dt>Exchange</dt><dd className="mono">{e.lastReconcile.positions} position(s) · {e.lastReconcile.orders} open order(s)</dd></div>
                </dl>
              )}
              {drift.length > 0 && (
                <ul className="list small">
                  {drift.map((d, i) => (
                    <li key={i}>{typeof d === 'string' ? d : <><b>{d.symbol}</b> {d.kind}: {d.detail}</>}</li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>
      </TabPanel>

      <TabPanel id="protection" value={tab} idPrefix="exch">
        <div className="stack">
          <Panel title="Protection on the exchange" right={<span className="muted small">one resting stop and the target legs per open position</span>}>
            {e.brackets.length === 0 ? (
              <EmptyState title={live ? 'No brackets resting' : 'Nothing attached in this mode'} hint={live ? 'Open positions would show their stop and targets here.' : 'In paper mode no orders reach an exchange, so there is nothing to protect.'} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>position</th><th>symbol</th><th>stop</th><th className="num">size</th><th>targets</th></tr></thead>
                  <tbody>
                    {e.brackets.map((b) => (
                      <tr key={b.positionId} className={openIds.has(b.positionId) ? '' : 'muted'}>
                        <td className="mono">#{b.positionId}</td>
                        <td>{b.symbol}</td>
                        <td className="mono">{b.stop ? `${fmtPrice(b.stop.price)} (order ${b.stop.exchangeId ?? b.stop.id})` : <span className="text-danger">none</span>}</td>
                        <td className="num mono">{b.stop?.size ?? '–'}</td>
                        <td className="mono">{b.tps.map((t) => `TP${t.leg ?? ''} ${fmtPrice(t.price)}×${t.size}`).join(' · ') || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Start-up recovery" right={<span className="muted small">what the ledger said was in flight, settled against the exchange</span>}>
            {!e.lastRecovery ? (
              <EmptyState title="No recovery report" hint="Paper mode, or the executor has not started." />
            ) : (
              <>
                <dl className="kv-list kv-row">
                  <div><dt>Settled</dt><dd className="mono">{e.lastRecovery.settled}</dd></div>
                  <div><dt>Brackets restored</dt><dd className="mono">{e.lastRecovery.restored}</dd></div>
                  <div><dt>Stops re-placed</dt><dd className="mono">{e.lastRecovery.replacedStops}</dd></div>
                  <div><dt>Fills adopted</dt><dd className="mono">{e.lastRecovery.adoptedFills}</dd></div>
                  <div><dt>Stray orders cancelled</dt><dd className="mono">{e.lastRecovery.cancelledStray}</dd></div>
                  <div><dt>When</dt><dd title={fmtUtc(e.lastRecovery.at)}><Time t={e.lastRecovery.at} mode="ago" /></dd></div>
                </dl>
                {e.lastRecovery.unmirrored.length > 0 && (
                  <Callout tone="danger" title="Unmirrored paper positions">Open on paper, no exchange history, so not protected on the exchange: #{e.lastRecovery.unmirrored.join(', #')}</Callout>
                )}
                {e.lastRecovery.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
              </>
            )}
          </Panel>
        </div>
      </TabPanel>

      <TabPanel id="orders" value={tab} idPrefix="exch">
        <Panel title="Order ledger" right={<span className="muted small">every order intended, and what became of it · newest first</span>} pad={false}>
          {!e.ledger?.length ? (
            <EmptyState title="No orders sent yet" hint="Every order the executor intends appears here with its state, fill and fee." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>when</th><th>position</th><th>purpose</th><th>symbol</th><th>side</th><th className="num">size</th><th>type</th><th className="num">price</th><th>state</th><th className="num">filled</th><th className="num">avg</th><th className="num">fee</th><th>exchange id</th><th>note</th></tr></thead>
                <tbody>
                  {e.ledger.map((r) => (
                    <tr key={r.id}>
                      <td className="mono" title={fmtUtc(r.updatedAt)}><Time t={r.updatedAt} mode="ago" /></td>
                      <td className="mono">{r.positionId ? `#${r.positionId}` : '–'}</td>
                      <td>{r.purpose}{r.reason ? <span className="muted"> · {r.reason}</span> : null}{r.leg ? <span className="muted"> · leg {r.leg}</span> : null}</td>
                      <td>{r.symbol}</td>
                      <td>{r.side}</td>
                      <td className="num mono">{r.size}</td>
                      <td className="mono small">{r.orderType}</td>
                      <td className="num mono">{r.stopPrice != null ? fmtPrice(r.stopPrice) : r.limitPrice != null ? fmtPrice(r.limitPrice) : 'mkt'}</td>
                      <td><Pill tone={stateTone(r.state)}>{r.state}</Pill></td>
                      <td className="num mono">{r.filledSize || '–'}</td>
                      <td className="num mono">{r.avgPrice != null ? fmtPrice(r.avgPrice) : '–'}</td>
                      <td className="num mono">{r.fee != null ? fmtMoney(r.fee, 4) : '–'}</td>
                      <td className="mono small">{r.exchangeId ?? '–'}</td>
                      <td className="small muted">{r.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </TabPanel>

      <TabPanel id="quality" value={tab} idPrefix="exch">
        <div className="stack">
          <ExecutionQualityPanel />
          <ExecutionAccountingPanel data={e.accounting} dryRun={e.dryRun} />
          <TapeAuditPanel />
          <ExecutionHandoffPanel handoff={e.outbox} />
        </div>
      </TabPanel>

      <ConfirmDialog
        open={confirmFlatten}
        title="Flatten the exchange account?"
        body={<p>Pauses new entries, lets queued execution work settle, cancels every open order on the exchange and sends a reduce-only market order against every exchange position — including any the paper book does not know about — then reconciles. Entries stay paused until you resume them.</p>}
        confirmLabel="Flatten exchange"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmFlatten(false)}
        onConfirm={() => closeAll.mutate(undefined, { onSettled: () => setConfirmFlatten(false) })}
      />
    </div>
  )
}
