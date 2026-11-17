import { memo, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClosePosition, useExecution, useMarkets, usePositionsHealth } from '../api/queries'
import type { Position } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { fmtAge, fmtInt, fmtMoney, fmtPrice, fmtR } from '../lib/format'
import { positionTargets, protectionText, quantityText, targetR } from '../lib/protection'
import { useToast } from '../lib/toast'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useLivePrice, useLiveTick } from '../sse/prices'
import { AssetChip } from './AssetChip'
import { DataTable, type Column } from './DataTable'
import { ConfirmDialog, Pnl, SidePill, StatusDot, Time } from './kit'
import { TradePath } from './TradePath'
import { ActiveStop, CloseNow } from './PositionHealth'
import { healthMatches, quoteFresh } from '../lib/positionHealth'

/** Live unrealized PnL from the latest tick (falls back to the server's number). */
function livePnl(p: Position, price: number | undefined): number {
  if (!Number.isFinite(price as number)) return p.unrealizedPnl
  const dir = p.side === 'long' ? 1 : -1
  return ((price as number) - p.entryPrice) * dir * p.qtyOpen * (p.contractValue || 1)
}

/*
 * Leaf cells subscribe to ticks for their own symbol, so a BTCUSD tick re-renders
 * only BTCUSD cells — the table and the other rows stay untouched.
 */
/** Last traded price, dimmed and explained when the feed for this symbol has gone quiet. */
const LiveMark = memo(function LiveMark({ p, tick }: { p: Position; tick?: number }) {
  const { price, ageMs, stale } = useLiveTick(p.symbol, p.markPrice)
  return (
    <span
      className={`mono ${stale ? 'price-stale' : ''}`}
      title={
        stale
          ? `no tick for ${ageMs === null ? 'this symbol yet' : fmtAge(ageMs)} — this is the server's last value, so the P&L beside it may be out of date`
          : undefined
      }
    >
      {fmtPrice(price ?? p.markPrice, tick)}
    </span>
  )
})
const LiveNotional = memo(function LiveNotional({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <span className="mono">{fmtMoney(p.qtyOpen * p.contractValue * (price ?? p.markPrice), 2)}</span>
})
const LiveUpnl = memo(function LiveUpnl({ p }: { p: Position }) {
  const { price, stale } = useLiveTick(p.symbol, p.markPrice)
  return (
    <span
      className={stale ? 'price-stale' : ''}
      title={stale ? 'estimated from a price that is not live' : undefined}
    >
      <Pnl value={livePnl(p, price)} />
    </span>
  )
})
const LiveDot = memo(function LiveDot({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <StatusDot tone={livePnl(p, price) >= 0 ? 'ok' : 'danger'} />
})

function ExecutionState({ p }: { p: Position }) {
  const e = p.execution
  if (!e) return null
  if (e.pending)
    return (
      <div className="small" role="status">
        Exit {e.pending.status === 'partial' ? 'partially filled' : 'pending'} · {e.pending.reason}
        <br />
        <span className="muted">
          {e.pending.last_error ?? 'Awaiting executable depth'} · remaining exposure held
        </span>
      </div>
    )
  if (e.desiredStop != null)
    return (
      <div className="muted small">
        Stop update pending: {fmtPrice(e.desiredStop)}. Current SL remains active.
      </div>
    )
  return null
}

function PositionTargets({ p, tick }: { p: Position; tick?: number }) {
  const targets = positionTargets(p)
  const active = targets.filter((t) => t.state === 'active')
  const rLabel = (price: number) => {
    const r = targetR(p, price)
    return r == null ? 'R unavailable' : fmtR(r)
  }
  return (
    <div className="position-targets">
      {active.length ? (
        active.map((t) => (
          <span className="mono" key={t.index}>
            TP{t.index + 1} {fmtPrice(t.price, tick)} <small className="muted">{rLabel(t.price)}</small>
          </span>
        ))
      ) : (
        <span className="muted">No allocated target</span>
      )}
      <details>
        <summary>Exit details</summary>
        {targets.map((t) => (
          <div key={t.index}>
            TP{t.index + 1}: {fmtPrice(t.price, tick)} · {rLabel(t.price)} ·{' '}
            {t.state === 'active'
              ? `${t.qty} contracts allocated`
              : t.state === 'reference'
                ? 'reference only; no contracts'
                : t.state === 'hit'
                  ? 'already hit'
                  : 'allocation unknown'}
          </div>
        ))}
        <p>{protectionText(p)}</p>
      </details>
    </div>
  )
}

export function PositionsTable({ positions, compact = false }: { positions: Position[]; compact?: boolean }) {
  const health = usePositionsHealth(positions.length > 0)
  const [clock, setClock] = useState(() => performance.now())
  useEffect(() => {
    if (!positions.length) return
    const timer = window.setInterval(() => setClock(performance.now()), 500)
    return () => window.clearInterval(timer)
  }, [positions.length])
  const healthById = useMemo(
    () => new Map(health.data?.response.positions.map((h) => [h.id, h]) ?? []),
    [health.data],
  )
  const [pathOf, setPathOf] = useState<{ id: number; title: string } | null>(null)
  // Eighteen columns need about 1500px. Below that, drop the derived values rather than making
  // the reader scroll sideways: notional, margin and liquidation can all be inferred from the
  // rest, so they are the first to go, and the per-trade result figures follow.
  const exec = useExecution()
  const mode = exec.data?.mode ?? 'paper'
  const mirrored = mode !== 'paper' && !exec.data?.dryRun
  const venue = {
    mirrored,
    text: mirrored
      ? `— paper book and ${exec.data?.host ?? mode} account`
      : mode === 'paper'
        ? '(paper only)'
        : `(paper only; ${mode} is in dry-run)`,
  }
  const narrow = useMediaQuery('(max-width: 1680px)')
  const veryNarrow = useMediaQuery('(max-width: 1180px)')
  const dense = compact || veryNarrow
  // with a 100%-at-TP3 split nothing is realised until the trade closes, so the column is dead weight
  const anyRealized = positions.some((p) => p.realizedPnl !== 0)
  const { data: markets } = useMarkets()
  const close = useClosePosition()
  const toast = useToast()
  const [closing, setClosing] = useState<Position | null>(null)
  const auth = useAuth()
  const pending = close.isPending || !auth.canTrade

  const cols = useMemo<Column<Position>[]>(() => {
    const observed = (p: Position) => {
      const h = healthById.get(p.id)
      return healthMatches(p, h) ? h : undefined
    }
    const fresh = (p: Position) => {
      const h = observed(p)
      return (
        !!h &&
        !health.isError &&
        !!health.data &&
        quoteFresh(h, health.data.receivedAt, health.data.requestMs, clock)
      )
    }
    const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize
    return [
      {
        key: 'symbol',
        header: 'Symbol',
        className: 'position-identity',
        value: (p) => p.symbol,
        render: (p) => (
          <span className="cell-sym">
            <LiveDot p={p} />
            <span>
              <b>{p.symbol}</b> <span className="muted small mono">{p.tf}</span>{' '}
              <AssetChip symbol={p.symbol} />
              <div className="muted small">
                <Link to={`/scanners/${p.scannerId}`} className="link">
                  {p.scannerName}
                </Link>
                {compact && (
                  <div>
                    {fmtInt(p.qtyOpen)}/{fmtInt(p.qty)} contracts ·{' '}
                    {(p.marginLeverage ?? p.leverage)?.toFixed(1) ?? '–'}×<br />
                    Filled <Time t={p.entryAt} mode="datetime" /> · <Time t={p.entryAt} mode="ago" />
                  </div>
                )}
                <ExecutionState p={p} />
              </div>
            </span>
          </span>
        ),
      },
      { key: 'side', header: 'Side', value: (p) => p.side, render: (p) => <SidePill side={p.side} /> },
      ...(compact
        ? []
        : ([
            {
              key: 'qty',
              header: 'Qty',
              numeric: true,
              value: (p) => p.qtyOpen,
              render: (p) => (
                <span className="mono">
                  {fmtInt(p.qtyOpen)}
                  <span className="muted">/{fmtInt(p.qty)}</span>
                </span>
              ),
            },
          ] as Column<Position>[])),
      {
        key: 'entry',
        header: compact ? 'Entry / Last' : 'Entry',
        numeric: true,
        value: (p) => p.entryPrice,
        render: (p) => (
          <div>
            <span className="mono">{fmtPrice(p.entryPrice, tick(p.symbol))}</span>
            {compact && (
              <div className="small muted">
                Last <LiveMark p={p} tick={tick(p.symbol)} />
              </div>
            )}
          </div>
        ),
      },
      ...(compact
        ? []
        : ([
            {
              key: 'mark',
              header: 'Last',
              numeric: true,
              value: (p) => p.markPrice,
              render: (p) => <LiveMark p={p} tick={tick(p.symbol)} />,
            },
            {
              key: 'lev',
              header: 'Lev',
              numeric: true,
              value: (p) => p.marginLeverage ?? p.leverage ?? 0,
              render: (p) => (
                <span className="mono">
                  {(p.marginLeverage ?? p.leverage)
                    ? `${(p.marginLeverage ?? p.leverage)!.toFixed(1)}x`
                    : '–'}
                </span>
              ),
            },
          ] as Column<Position>[])),
      ...(narrow || compact
        ? []
        : ([
            {
              key: 'notional',
              header: 'Notional',
              numeric: true,
              value: (p) => p.qtyOpen * p.contractValue * p.markPrice,
              render: (p) => <LiveNotional p={p} />,
            },
          ] as Column<Position>[])),
      // margin and liquidation are risk, not detail: they stay until the table is genuinely tiny
      ...(compact
        ? []
        : ([
            {
              key: 'margin',
              header: 'Margin',
              numeric: true,
              value: (p) => p.margin ?? 0,
              render: (p) => <span className="mono">{p.margin != null ? fmtMoney(p.margin, 2) : '–'}</span>,
            },
            {
              key: 'liq',
              header: 'Liq',
              numeric: true,
              value: (p) => p.liqPrice ?? 0,
              render: (p) => (
                <span className="mono loss">
                  {p.liqPrice != null ? fmtPrice(p.liqPrice, tick(p.symbol)) : '–'}
                </span>
              ),
            },
          ] as Column<Position>[])),
      {
        key: 'sl',
        header: 'Active SL',
        numeric: true,
        value: (p) => p.sl,
        render: (p) => <ActiveStop p={p} h={observed(p)} tick={tick(p.symbol)} />,
      },
      {
        key: 'tp',
        header: 'Target',
        numeric: true,
        sortable: false,
        render: (p) => {
          return <PositionTargets p={p} tick={tick(p.symbol)} />
        },
      },
      ...(compact
        ? []
        : ([
            {
              key: 'upnl',
              header: 'Gross unrealized',
              numeric: true,
              value: (p) => p.unrealizedPnl,
              render: (p) => <LiveUpnl p={p} />,
            },
          ] as Column<Position>[])),
      {
        key: 'closeNow',
        header: 'Net close-now · USD',
        numeric: true,
        sortable: false,
        render: (p) => (
          <div>
            <CloseNow p={p} h={observed(p)} fresh={fresh(p)} unavailable={health.isError} />
            {compact && (
              <div className="small muted">
                Gross unrealized <LiveUpnl p={p} />
              </div>
            )}
          </div>
        ),
      },
      ...(dense || !anyRealized
        ? []
        : ([
            {
              key: 'rpnl',
              header: 'Realized',
              numeric: true,
              value: (p) => p.realizedPnl,
              render: (p) => <Pnl value={p.realizedPnl} />,
            },
          ] as Column<Position>[])),
      ...(dense
        ? []
        : ([
            {
              key: 'r',
              header: 'R',
              numeric: true,
              value: (p) => p.rMultiple,
              render: (p) => (
                <span
                  className={`mono ${p.rMultiple == null ? 'neutral' : p.rMultiple >= 0 ? 'gain' : 'loss'}`}
                >
                  {fmtR(p.rMultiple)}
                </span>
              ),
            },
            {
              key: 'risk',
              header: 'Risk',
              numeric: true,
              value: (p) => p.riskAmount,
              render: (p) => <span className="mono">{fmtMoney(p.riskAmount)}</span>,
            },
          ] as Column<Position>[])),
      ...(compact
        ? []
        : ([
            {
              key: 'age',
              header: 'Filled',
              value: (p) => p.entryAt,
              render: (p) => (
                <div>
                  <Time t={p.entryAt} mode="datetime" className="small" />
                  <br />
                  <Time t={p.entryAt} mode="ago" className="muted small" />
                </div>
              ),
            },
          ] as Column<Position>[])),
      {
        key: 'actions',
        header: '',
        sortable: false,
        align: 'right',
        render: (p) => (
          <button
            className="btn btn-xs btn-danger-outline"
            onClick={() => setClosing(p)}
            disabled={pending}
            aria-label={`Close ${p.symbol} position`}
          >
            Close
          </button>
        ),
      },
    ]
  }, [markets, compact, dense, narrow, pending, anyRealized, healthById, health.data, health.isError, clock])

  return (
    <>
      <div className="position-cards" aria-label="Open positions">
        {positions.length === 0 && <p className="muted">No open positions</p>}
        {positions.map((p) => {
          const candidate = healthById.get(p.id)
          const h = healthMatches(p, candidate) ? candidate : undefined
          const fresh =
            !!h &&
            !health.isError &&
            !!health.data &&
            quoteFresh(h, health.data.receivedAt, health.data.requestMs, clock)
          const tick = markets?.find((m) => m.symbol === p.symbol)?.tickSize
          return (
            <article className="position-card" key={p.id}>
              <div className="row gap">
                <b>
                  {p.symbol} {p.tf}
                </b>
                <AssetChip symbol={p.symbol} />
                <SidePill side={p.side} />
              </div>
              <Link className="link" to={`/scanners/${p.scannerId}`}>
                {p.scannerName}
              </Link>
              <ExecutionState p={p} />
              <dl className="position-metrics">
                <div>
                  <dt>Filled</dt>
                  <dd>
                    <Time t={p.entryAt} mode="datetime" />
                    <br />
                    <Time t={p.entryAt} mode="ago" />
                  </dd>
                </div>
                <div>
                  <dt>Gross unrealized P&L (USD)</dt>
                  <dd>
                    <LiveUpnl p={p} />
                  </dd>
                </div>
                <div>
                  <dt>Mark price</dt>
                  <dd>
                    <LiveMark p={p} tick={tick} />
                  </dd>
                </div>
                <div>
                  <dt>Active SL</dt>
                  <dd>
                    <ActiveStop p={p} h={h} tick={tick} />
                  </dd>
                </div>
                <div>
                  <dt>
                    Liquidation (modelled
                    {p.maintenanceMarginPct != null ? `, ${p.maintenanceMarginPct}% maintenance` : ''})
                  </dt>
                  <dd>{fmtPrice(p.liqPrice, tick)}</dd>
                </div>
                <div>
                  <dt>Entry price</dt>
                  <dd>{fmtPrice(p.entryPrice, tick)}</dd>
                </div>
                <div>
                  <dt>Open / initial contracts</dt>
                  <dd>
                    {fmtInt(p.qtyOpen)} / {fmtInt(p.qty)}
                  </dd>
                </div>
                <div>
                  <dt>Remaining size</dt>
                  <dd>
                    {quantityText(p.qtyOpen, p.contractValue)} {p.symbol.replace(/USD$/, '')} ·{' '}
                    <LiveNotional p={p} /> current notional
                  </dd>
                </div>
                <div>
                  <dt>Margin (USD)</dt>
                  <dd>{fmtMoney(p.margin)}</dd>
                </div>
                <div>
                  <dt>Leverage</dt>
                  <dd>{(p.marginLeverage ?? p.leverage)?.toFixed(1) ?? '–'}×</dd>
                </div>
                <div>
                  <dt>Funding (USD)</dt>
                  <dd>
                    <Pnl value={p.funding ?? 0} />
                  </dd>
                </div>
                <div>
                  <dt>Commission (USD)</dt>
                  <dd>{fmtMoney(p.fees)}</dd>
                </div>
                <div>
                  <dt>Realized P&L before commission (USD)</dt>
                  <dd>
                    <Pnl value={p.realizedPnl} />
                  </dd>
                </div>
                <div>
                  <dt>Risk (USD)</dt>
                  <dd>{fmtMoney(p.riskAmount)}</dd>
                </div>
              </dl>
              <h4>Net close-now · USD</h4>
              <CloseNow p={p} h={h} fresh={fresh} unavailable={health.isError} />
              <PositionTargets p={p} tick={tick} />
              <div className="position-card-actions">
                <button
                  className="btn"
                  onClick={() => setPathOf({ id: p.id, title: `${p.symbol} ${p.side} · ${p.scannerName}` })}
                >
                  View trade path
                </button>
                <button
                  className="btn btn-danger-outline"
                  onClick={() => setClosing(p)}
                  disabled={pending}
                  aria-label={`Close ${p.symbol} position`}
                >
                  Close position
                </button>
              </div>
            </article>
          )
        })}
      </div>
      <div className="position-desktop">
        <DataTable
          columns={cols}
          rows={compact ? [...positions].sort((a, b) => b.entryAt - a.entryAt) : positions}
          rowKey={(p) => p.id}
          onRowClick={(p) => setPathOf({ id: p.id, title: `${p.symbol} ${p.side} · ${p.scannerName}` })}
          emptyLabel={
            <span>
              No open positions
              <span className="empty-hint">The account opens one when an entry signal is actioned.</span>
            </span>
          }
          defaultSort={{ key: 'age', dir: 'desc' }}
          caption="Open positions"
        />
      </div>
      <TradePath id={pathOf?.id ?? null} title={pathOf?.title} onClose={() => setPathOf(null)} />
      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.side.toUpperCase()} ${closing.symbol}?` : ''}
        body={
          closing ? (
            <p>
              Closes {fmtInt(closing.qtyOpen)} contracts at market {venue.text}.
              {venue.mirrored && (
                <>
                  <br />
                  <span className="muted small">
                    The paper book closes immediately; the exchange order is sent after it and is confirmed
                    separately on the exchange.
                  </span>
                </>
              )}
            </p>
          ) : null
        }
        confirmLabel="Close position"
        danger
        busy={pending}
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (!closing) return
          close.mutate(closing.id, {
            onSuccess: (result) => {
              toast.success(
                result.execution?.pending
                  ? `Close pending: ${closing.symbol} is awaiting executable depth`
                  : venue.mirrored
                    ? `Close requested: ${closing.symbol} closed in the paper book`
                    : `Closed ${closing.symbol}`,
              )
              setClosing(null)
            },
            onError: (e) => toast.error('Close failed', e.message),
          })
        }}
      />
    </>
  )
}
