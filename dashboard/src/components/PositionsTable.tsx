import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClosePosition, useExecution, useMarkets } from '../api/queries'
import type { Position } from '../api/types'
import { fmtInt, fmtMoney, fmtPrice, fmtR, timeAgo } from '../lib/format'
import { useToast } from '../lib/toast'
import { useLivePrice, useLiveTick } from '../sse/prices'
import { DataTable, type Column } from './DataTable'
import { useMediaQuery } from '../lib/useMediaQuery'
import { ConfirmDialog, Pill, Pnl, SidePill, StatusDot, Time } from './ui'

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
    <span className={`mono ${stale ? 'price-stale' : ''}`} title={stale ? `no tick for ${ageMs === null ? 'this symbol yet' : timeAgo(Date.now() - ageMs)} — this is the server's last value, so the P&L beside it may be out of date` : undefined}>
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
  return <span className={stale ? 'price-stale' : ''} title={stale ? 'estimated from a price that is not live' : undefined}><Pnl value={livePnl(p, price)} /></span>
})
const LiveDot = memo(function LiveDot({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <StatusDot tone={livePnl(p, price) >= 0 ? 'ok' : 'danger'} />
})

/**
 * How the exit is set up for this position: which target can actually fill, how far away it is, and
 * where the stop starts protecting. Targets carrying no contracts cannot fill whatever price does,
 * and the trail — not the target — is what usually ends these trades.
 */
function exitPlan(p: Position) {
  const dir = p.side === 'long' ? 1 : -1
  const risk = Math.abs(p.entryPrice - (p.slOriginal ?? p.sl ?? p.entryPrice))
  const live = [0, 1, 2].filter((i) => p.tp?.[i] != null && (p.legs?.[i] ?? 1) > 0 && !p.tpHit?.[i])
  const active = live.length ? p.tp![live[0]] : null
  const pct = active != null && p.entryPrice ? ((active - p.entryPrice) * dir) / p.entryPrice * 100 : null
  const atR = (r: number) => p.entryPrice + dir * risk * r
  return { active, pct, risk, lockAt: atR(1), lockPrice: atR(0.5), trailAt: atR(1.5) }
}

/**
 * What the stop is actually doing. `breakEven` on its own is not the whole story: the trail moves
 * the stop above entry, which locks in profit rather than merely removing the loss.
 */
function stopState(p: Position): { badge: string | null; tone: 'muted' | 'ok'; title: string } {
  if (p.sl == null) return { badge: null, tone: 'muted', title: '' }
  const locked = (p.side === 'long' ? p.sl - p.entryPrice : p.entryPrice - p.sl) * p.qtyOpen * (p.contractValue || 1)
  if (locked > 0.005) return { badge: 'LOCKED', tone: 'ok', title: `Stop is beyond entry: about ${fmtMoney(locked)} is protected if it is hit (before exit costs)` }
  if (p.breakEven || Math.abs(locked) <= 0.005) return { badge: 'BE', tone: 'muted', title: 'Stop is at entry: no loss if it is hit, before exit costs' }
  return { badge: null, tone: 'muted', title: '' }
}

export function PositionsTable({ positions, compact = false }: { positions: Position[]; compact?: boolean }) {
  // Eighteen columns need about 1500px. Below that, drop the derived values rather than making
  // the reader scroll sideways: notional, margin and liquidation can all be inferred from the
  // rest, so they are the first to go, and the per-trade result figures follow.
  const exec = useExecution()
  const mode = exec.data?.mode ?? 'paper'
  const mirrored = mode !== 'paper' && !exec.data?.dryRun
  const venue = {
    mirrored,
    text: mirrored ? `— paper book and ${exec.data?.host ?? mode} account` : mode === 'paper' ? '(paper only)' : `(paper only; ${mode} is in dry-run)`,
  }
  const narrow = useMediaQuery('(max-width: 1440px)')
  const veryNarrow = useMediaQuery('(max-width: 1180px)')
  const dense = compact || veryNarrow
  const { data: markets } = useMarkets()
  const close = useClosePosition()
  const toast = useToast()
  const [closing, setClosing] = useState<Position | null>(null)
  const pending = close.isPending

  const cols = useMemo<Column<Position>[]>(() => {
    const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize
    return [
      {
        key: 'symbol',
        header: 'Symbol',
        value: (p) => p.symbol,
        render: (p) => (
          <span className="cell-sym">
            <LiveDot p={p} />
            <span>
              <b>{p.symbol}</b> <span className="muted small mono">{p.tf}</span>
              <div className="muted small">
                <Link to={`/scanners/${p.scannerId}`} className="link">
                  {p.scannerName}
                </Link>
              </div>
            </span>
          </span>
        ),
      },
      { key: 'side', header: 'Side', value: (p) => p.side, render: (p) => <SidePill side={p.side} /> },
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
      { key: 'entry', header: 'Entry', numeric: true, value: (p) => p.entryPrice, render: (p) => <span className="mono">{fmtPrice(p.entryPrice, tick(p.symbol))}</span> },
      { key: 'mark', header: 'Last', numeric: true, value: (p) => p.markPrice, render: (p) => <LiveMark p={p} tick={tick(p.symbol)} /> },
      {
        key: 'lev',
        header: 'Lev',
        numeric: true,
        value: (p) => p.marginLeverage ?? p.leverage ?? 0,
        render: (p) => <span className="mono">{(p.marginLeverage ?? p.leverage) ? `${(p.marginLeverage ?? p.leverage)!.toFixed(1)}x` : '–'}</span>,
      },
      ...(narrow || compact
        ? []
        : ([
            { key: 'notional', header: 'Notional', numeric: true, value: (p) => p.qtyOpen * p.contractValue * p.markPrice, render: (p) => <LiveNotional p={p} /> },
          ] as Column<Position>[])),
      // margin and liquidation are risk, not detail: they stay until the table is genuinely tiny
      ...(compact
        ? []
        : ([
            { key: 'margin', header: 'Margin', numeric: true, value: (p) => p.margin ?? 0, render: (p) => <span className="mono">{p.margin != null ? fmtMoney(p.margin, 2) : '–'}</span> },
            { key: 'liq', header: 'Liq', numeric: true, value: (p) => p.liqPrice ?? 0, render: (p) => <span className="mono loss">{p.liqPrice != null ? fmtPrice(p.liqPrice, tick(p.symbol)) : '–'}</span> },
          ] as Column<Position>[])),
      {
        key: 'sl',
        header: 'SL',
        numeric: true,
        value: (p) => p.sl,
        render: (p) => (
          <span className="mono">
            {fmtPrice(p.sl, tick(p.symbol))}
            {stopState(p).badge && (
              <Pill tone={stopState(p).tone} className="ml" title={stopState(p).title}>
                {stopState(p).badge}
              </Pill>
            )}
          </span>
        ),
      },
      {
        key: 'tp',
        header: 'Targets',
        numeric: true,
        sortable: false,
        render: (p) => (
          <span className="mono small tp-list">
            {[0, 1, 2].map((i) => {
              // a leg with no contracts allocated can never fill; showing it as a live target misleads
              const size = p.legs?.[i]
              const funded = size === undefined ? true : size > 0
              const share = funded && p.qty ? Math.round(((size ?? p.qty) / p.qty) * 100) : 0
              return (
                <span
                  key={i}
                  className={`${p.tpHit?.[i] ? 'tp-hit' : ''} ${funded ? '' : 'tp-unfunded'}`}
                  title={!funded ? `TP${i + 1} carries no contracts under the current split, so it cannot fill` : p.tpHit?.[i] ? `TP${i + 1} hit` : `TP${i + 1}: ${share}% of the position`}
                >
                  {fmtPrice(p.tp?.[i], tick(p.symbol))}
                  {funded && share > 0 && share < 100 ? <sup className="tp-share">{share}%</sup> : null}
                </span>
              )
            })}
          </span>
        ),
      },
      { key: 'upnl', header: 'Unrealized', numeric: true, value: (p) => p.unrealizedPnl, render: (p) => <LiveUpnl p={p} /> },
      ...(dense
        ? []
        : ([
            { key: 'rpnl', header: 'Realized', numeric: true, value: (p) => p.realizedPnl, render: (p) => <Pnl value={p.realizedPnl} /> },
            { key: 'r', header: 'R', numeric: true, value: (p) => p.rMultiple, render: (p) => <span className={`mono ${p.rMultiple >= 0 ? 'gain' : 'loss'}`}>{fmtR(p.rMultiple)}</span> },
            { key: 'risk', header: 'Risk', numeric: true, value: (p) => p.riskAmount, render: (p) => <span className="mono">{fmtMoney(p.riskAmount)}</span> },
          ] as Column<Position>[])),
      {
        key: 'age',
        header: 'Opened',
        value: (p) => p.entryAt,
        render: (p) => <Time t={p.entryAt} mode="ago" className="muted small" />,
      },
      {
        key: 'actions',
        header: '',
        sortable: false,
        align: 'right',
        render: (p) => (
          <button className="btn btn-xs btn-danger-outline" onClick={() => setClosing(p)} disabled={pending} aria-label={`Close ${p.symbol} position`}>
            Close
          </button>
        ),
      },
    ]
  }, [markets, compact, dense, narrow, pending])

  return (
    <>
      <div className="position-cards" aria-label="Open positions">
        {positions.length === 0 && <p className="muted">No open positions</p>}
        {positions.map((p) => {
          const tick = markets?.find((m) => m.symbol === p.symbol)?.tickSize
          return <article className="position-card" key={p.id}>
            <div className="row gap"><b>{p.symbol} {p.tf}</b><SidePill side={p.side} /></div>
            <Link className="link" to={`/scanners/${p.scannerId}`}>{p.scannerName}</Link>
            <dl className="position-metrics">
              <div><dt>Unrealized P&L (USD)</dt><dd><LiveUpnl p={p} /></dd></div>
              <div><dt>Mark price</dt><dd><LiveMark p={p} tick={tick} /></dd></div>
              <div><dt>Stop loss {p.breakEven ? '(break-even)' : ''}</dt><dd>{fmtPrice(p.sl, tick)}</dd></div>
              <div><dt>Liquidation (modelled)</dt><dd>{fmtPrice(p.liqPrice, tick)}</dd></div>
              <div><dt>Entry price</dt><dd>{fmtPrice(p.entryPrice, tick)}</dd></div>
              <div><dt>Open / initial contracts</dt><dd>{fmtInt(p.qtyOpen)} / {fmtInt(p.qty)}</dd></div>
              <div><dt>Margin (USD)</dt><dd>{fmtMoney(p.margin)}</dd></div>
              <div><dt>Leverage</dt><dd>{(p.marginLeverage ?? p.leverage)?.toFixed(1) ?? '–'}×</dd></div>
              <div><dt>Realized P&L (USD)</dt><dd><Pnl value={p.realizedPnl} /></dd></div>
              <div><dt>Risk (USD)</dt><dd>{fmtMoney(p.riskAmount)}</dd></div>
            </dl>
            <div className="small">
              Targets (only a funded one can fill):{' '}
              {[0, 1, 2].map((i) => {
                const size = p.legs?.[i]
                const funded = size === undefined ? true : size > 0
                return (
                  <span key={i} className={`${p.tpHit?.[i] ? 'tp-hit' : ''} ${funded ? '' : 'tp-unfunded'}`} title={funded ? undefined : 'no contracts allocated to this target'}>
                    {' '}{fmtPrice(p.tp?.[i], tick)}{p.tpHit?.[i] ? ' (hit)' : ''}{i < 2 ? ' /' : ''}
                  </span>
                )
              })}
            </div>
            {(() => {
              const plan = exitPlan(p)
              return (
                <div className="small muted">
                  {plan.active != null && plan.pct != null && (
                    <>Active target {fmtPrice(plan.active, tick)} — needs {plan.pct.toFixed(2)}% from entry. </>
                  )}
                  Protection: stop moves to {fmtPrice(plan.lockPrice, tick)} once price reaches {fmtPrice(plan.lockAt, tick)} (+1R); from {fmtPrice(plan.trailAt, tick)} (+1.5R) it trails 60% of the best price.
                </div>
              )
            })()}
            <button className="btn btn-danger-outline" onClick={() => setClosing(p)} disabled={pending} aria-label={`Close ${p.symbol} position`}>Close position</button>
          </article>
        })}
      </div>
      <div className="position-desktop">
      <DataTable
        columns={cols}
        rows={positions}
        rowKey={(p) => p.id}
        emptyLabel={
          <span>
            No open positions
            <span className="empty-hint">The paper engine opens one when an entry signal is actioned.</span>
          </span>
        }
        defaultSort={{ key: 'age', dir: 'desc' }}
        caption="Open positions"
      />
      </div>
      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.side.toUpperCase()} ${closing.symbol}?` : ''}
        body={closing ? <p>Closes {fmtInt(closing.qtyOpen)} contracts at market {venue.text}.{venue.mirrored && <><br /><span className="muted small">The paper book closes immediately; the exchange order is sent after it and is confirmed separately on the exchange.</span></>}</p> : null}
        confirmLabel="Close position"
        danger
        busy={pending}
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (!closing) return
          close.mutate(closing.id, {
            onSuccess: () => {
              toast.success(venue.mirrored ? `Close requested: ${closing.symbol} closed in the paper book` : `Closed ${closing.symbol}`)
              setClosing(null)
            },
            onError: (e) => toast.error('Close failed', e.message),
          })
        }}
      />
    </>
  )
}
