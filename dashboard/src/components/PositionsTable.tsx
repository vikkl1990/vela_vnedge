import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClosePosition, useMarkets } from '../api/queries'
import type { Position } from '../api/types'
import { fmtInt, fmtMoney, fmtPrice, fmtR } from '../lib/format'
import { useToast } from '../lib/toast'
import { useLivePrice } from '../sse/prices'
import { DataTable, type Column } from './DataTable'
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
const LiveMark = memo(function LiveMark({ p, tick }: { p: Position; tick?: number }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <span className="mono">{fmtPrice(price ?? p.markPrice, tick)}</span>
})
const LiveNotional = memo(function LiveNotional({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <span className="mono">{fmtMoney(p.qtyOpen * p.contractValue * (price ?? p.markPrice), 2)}</span>
})
const LiveUpnl = memo(function LiveUpnl({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <Pnl value={livePnl(p, price)} />
})
const LiveDot = memo(function LiveDot({ p }: { p: Position }) {
  const price = useLivePrice(p.symbol, p.markPrice)
  return <StatusDot tone={livePnl(p, price) >= 0 ? 'ok' : 'danger'} />
})

export function PositionsTable({ positions, compact = false }: { positions: Position[]; compact?: boolean }) {
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
      { key: 'mode', header: 'Mode', value: p => p.executionMode ?? 'paper', render: p => <span className="muted small">{p.executionMode === 'shadow' ? 'Shadow (hypothetical)' : p.executionMode ?? 'paper'}</span> },
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
      { key: 'mark', header: 'Mark', numeric: true, value: (p) => p.markPrice, render: (p) => <LiveMark p={p} tick={tick(p.symbol)} /> },
      {
        key: 'lev',
        header: 'Lev',
        numeric: true,
        value: (p) => p.marginLeverage ?? p.leverage ?? 0,
        render: (p) => <span className="mono">{(p.marginLeverage ?? p.leverage) ? `${(p.marginLeverage ?? p.leverage)!.toFixed(1)}x` : '–'}</span>,
      },
      { key: 'notional', header: 'Notional', numeric: true, value: (p) => p.qtyOpen * p.contractValue * p.markPrice, render: (p) => <LiveNotional p={p} /> },
      { key: 'margin', header: 'Margin', numeric: true, value: (p) => p.margin ?? 0, render: (p) => <span className="mono">{p.margin != null ? fmtMoney(p.margin, 2) : '–'}</span> },
      { key: 'liq', header: 'Liq', numeric: true, value: (p) => p.liqPrice ?? 0, render: (p) => <span className="mono loss">{p.liqPrice != null ? fmtPrice(p.liqPrice, tick(p.symbol)) : '–'}</span> },
      {
        key: 'sl',
        header: 'SL',
        numeric: true,
        value: (p) => p.sl,
        render: (p) => (
          <span className="mono">
            {fmtPrice(p.sl, tick(p.symbol))}
            {p.breakEven && (
              <Pill tone="muted" className="ml" title="Stop moved to break-even">
                BE
              </Pill>
            )}
          </span>
        ),
      },
      {
        key: 'tp',
        header: 'TP1/2/3',
        numeric: true,
        sortable: false,
        render: (p) => (
          <span className="mono small tp-list">
            {[0, 1, 2].map((i) => (
              <span key={i} className={p.tpHit?.[i] ? 'tp-hit' : ''} title={p.tpHit?.[i] ? 'hit' : ''}>
                {fmtPrice(p.tp?.[i], tick(p.symbol))}
              </span>
            ))}
          </span>
        ),
      },
      { key: 'upnl', header: 'Unrealized', numeric: true, value: (p) => p.unrealizedPnl, render: (p) => <LiveUpnl p={p} /> },
      ...(compact
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
  }, [markets, compact, pending])

  return (
    <>
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
      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.side.toUpperCase()} ${closing.symbol}?` : ''}
        body={closing ? <p>Closes {fmtInt(closing.qtyOpen)} contracts at market (paper).</p> : null}
        confirmLabel="Close position"
        danger
        busy={pending}
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (!closing) return
          close.mutate(closing.id, {
            onSuccess: () => {
              toast.success(`Closed ${closing.symbol}`)
              setClosing(null)
            },
            onError: (e) => toast.error('Close failed', e.message),
          })
        }}
      />
    </>
  )
}
