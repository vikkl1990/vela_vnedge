import { useState } from 'react'
import { useExchangeCloseAll, useExecution, usePositions, useReconcile } from '../api/queries'
import type { LedgerRow } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { BookBadge, ConfirmDialog, Empty, Loading, Panel, Pill, StatusDot } from '../components/ui'
import { fmtAge, fmtMoney, fmtPrice, fmtUtc } from '../lib/format'

/**
 * The exchange side of the book: what the executor believes the exchange holds, the last time it
 * checked, what it found at start-up, and every order it has sent. Paper mode shows the same page
 * with nothing attached, so the operator learns the layout before anything is live.
 */
export function Exchange() {
  const exec = useExecution()
  const positions = usePositions()
  const reconcile = useReconcile()
  const closeAll = useExchangeCloseAll()
  const auth = useAuth()
  const [confirmFlatten, setConfirmFlatten] = useState(false)
  const e = exec.data
  if (exec.isLoading) return <Loading rows={6} />
  if (!e) return <Empty label="Execution status unavailable." hint="The server did not answer /api/execution." />
  const live = e.mode !== 'paper' && !e.dryRun
  const drift = e.lastReconcile?.drift ?? []
  const openIds = new Set((positions.data ?? []).map((p) => p.id))
  const unprotected = (positions.data ?? []).filter((p) => live && !e.brackets.some((b) => b.positionId === p.id && b.stop))
  const stateTone = (s: LedgerRow['state']) => (s === 'filled' ? 'ok' : s === 'acknowledged' ? 'accent' : s === 'rejected' || s === 'unknown' ? 'danger' : s === 'cancelled' ? 'muted' : 'warn')

  return (
    <div className="page">
      <div className="page-head">
        <h1>Exchange</h1>
        <div className="row gap">
          <button className="btn btn-sm" onClick={() => reconcile.mutate()} disabled={!e.hasKeys || reconcile.isPending}>
            {reconcile.isPending ? 'Reconciling…' : 'Reconcile now'}
          </button>
          {auth.isAdmin && (
            <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmFlatten(true)} disabled={!live || closeAll.isPending}>
              Flatten exchange account
            </button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <Panel title="Connection">
          <dl className="kv-list">
            <div><dt>Account</dt><dd><BookBadge book="account" mode={e.dryRun ? 'dry-run' : e.mode} /></dd></div>
            <div><dt>Host</dt><dd className="mono">{e.host ?? '— (paper: no exchange attached)'}</dd></div>
            <div><dt>API keys</dt><dd><StatusDot tone={e.hasKeys ? 'ok' : 'neutral'} /> {e.hasKeys ? 'present (environment)' : 'none'}</dd></div>
            <div><dt>Brackets</dt><dd>{e.bracket ? 'stop-market + take-profit limits rest on the exchange' : 'off — every exit is sent at market when it happens'}</dd></div>
            <div><dt>Products known</dt><dd className="mono">{e.products ?? '–'}</dd></div>
          </dl>
        </Panel>

        <Panel title="Last reconciliation">
          {!e.lastReconcile ? (
            <p className="muted small">Not run yet{e.hasKeys ? '' : ' — needs API keys'}.</p>
          ) : (
            <dl className="kv-list">
              <div><dt>When</dt><dd title={fmtUtc(e.lastReconcile.at)}>{fmtAge(Date.now() - e.lastReconcile.at)} ago</dd></div>
              <div><dt>Result</dt><dd><Pill tone={e.lastReconcile.ok ? 'ok' : 'danger'}>{e.lastReconcile.ok ? 'in step' : `${drift.length} drift(s)`}</Pill>{e.lastReconcile.error ? <span className="muted small"> {e.lastReconcile.error}</span> : null}</dd></div>
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

      <Panel title="Start-up recovery" right={<span className="muted small">what the ledger said was in flight, settled against the exchange</span>}>
        {!e.lastRecovery ? (
          <p className="muted small">No recovery report (paper mode, or the executor has not started).</p>
        ) : (
          <>
            <dl className="kv-list kv-row">
              <div><dt>Settled</dt><dd className="mono">{e.lastRecovery.settled}</dd></div>
              <div><dt>Brackets restored</dt><dd className="mono">{e.lastRecovery.restored}</dd></div>
              <div><dt>Stops re-placed</dt><dd className="mono">{e.lastRecovery.replacedStops}</dd></div>
              <div><dt>Fills adopted</dt><dd className="mono">{e.lastRecovery.adoptedFills}</dd></div>
              <div><dt>Stray orders cancelled</dt><dd className="mono">{e.lastRecovery.cancelledStray}</dd></div>
              <div><dt>When</dt><dd title={fmtUtc(e.lastRecovery.at)}>{fmtAge(Date.now() - e.lastRecovery.at)} ago</dd></div>
            </dl>
            {e.lastRecovery.unmirrored.length > 0 && (
              <p className="text-danger small">Unmirrored paper positions (open on paper, no exchange history — not protected on the exchange): #{e.lastRecovery.unmirrored.join(', #')}</p>
            )}
            {e.lastRecovery.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
          </>
        )}
      </Panel>

      <Panel title="Protection on the exchange" right={<span className="muted small">one resting stop and the target legs per open position</span>}>
        {(e.stranded?.length ?? 0) > 0 && (
          <p className="text-danger small"><b>Stranded exposure</b> — the book is closed but the exchange still holds: {e.stranded!.map((s) => `#${s.positionId} ${s.symbol} ×${s.qty} (${s.attempts} attempt${s.attempts === 1 ? '' : 's'})`).join(', ')}. The stop stays; every sweep sends a reduce-only market order for the rest.</p>
        )}
        {(e.unconfirmed?.length ?? 0) > 0 && (
          <p className="text-danger small">Entries the exchange has not confirmed yet — no bracket until it does: #{e.unconfirmed!.join(', #')}</p>
        )}
        {unprotected.length > 0 && (
          <p className="text-danger small">Open positions with NO stop on the exchange: {unprotected.map((p) => `#${p.id} ${p.symbol}`).join(', ')}</p>
        )}
        {e.brackets.length === 0 ? (
          <p className="muted small">{live ? 'No brackets resting.' : 'Nothing attached in this mode.'}</p>
        ) : (
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
        )}
      </Panel>

      <Panel title="Order ledger" right={<span className="muted small">every order intended, and what became of it · newest first</span>}>
        {!e.ledger?.length ? (
          <p className="muted small">No orders sent yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>when</th><th>position</th><th>purpose</th><th>symbol</th><th>side</th><th className="num">size</th><th>type</th><th className="num">price</th><th>state</th><th className="num">filled</th><th className="num">avg</th><th className="num">fee</th><th>exchange id</th><th>note</th></tr></thead>
              <tbody>
                {e.ledger.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" title={fmtUtc(r.updatedAt)}>{fmtAge(Date.now() - r.updatedAt)}</td>
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
