import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useClosePosition, useMarkets } from '../api/queries'
import type { Position } from '../api/types'
import { fmtDateTime, fmtInt, fmtPrice, fmtR, timeAgo } from '../lib/format'
import { useToast } from '../lib/toast'
import { useNow } from '../lib/useNow'
import { useSSE } from '../sse/SSEProvider'
import { DataTable, type Column } from './DataTable'
import { ConfirmDialog, Pill, Pnl, SidePill, StatusDot } from './ui'

export function PositionsTable({ positions, compact = false }: { positions: Position[]; compact?: boolean }) {
  const { data: markets } = useMarkets()
  const { lastPrice } = useSSE()
  const now = useNow(5000)
  const close = useClosePosition()
  const toast = useToast()
  const [closing, setClosing] = useState<Position | null>(null)
  const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize

  /** Live unrealized PnL: prefer the server's number, nudge with the latest tick when newer. */
  const livePnl = (p: Position): number => {
    const t = lastPrice[p.symbol]
    if (!t || !Number.isFinite(t.price)) return p.unrealizedPnl
    const dir = p.side === 'long' ? 1 : -1
    return (t.price - p.entryPrice) * dir * p.qtyOpen * (p.contractValue || 1)
  }
  const liveMark = (p: Position) => lastPrice[p.symbol]?.price ?? p.markPrice

  const cols: Column<Position>[] = [
    {
      key: 'symbol',
      header: 'Symbol',
      value: (p) => p.symbol,
      render: (p) => (
        <span className="cell-sym">
          <StatusDot tone={livePnl(p) >= 0 ? 'ok' : 'danger'} />
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
      align: 'right',
      value: (p) => p.qtyOpen,
      render: (p) => (
        <span className="mono">
          {fmtInt(p.qtyOpen)}
          <span className="muted">/{fmtInt(p.qty)}</span>
        </span>
      ),
    },
    { key: 'entry', header: 'Entry', align: 'right', value: (p) => p.entryPrice, render: (p) => <span className="mono">{fmtPrice(p.entryPrice, tick(p.symbol))}</span> },
    { key: 'mark', header: 'Mark', align: 'right', value: (p) => liveMark(p), render: (p) => <span className="mono">{fmtPrice(liveMark(p), tick(p.symbol))}</span> },
    {
      key: 'sl',
      header: 'SL',
      align: 'right',
      value: (p) => p.sl,
      render: (p) => (
        <span className="mono">
          {fmtPrice(p.sl, tick(p.symbol))}
          {p.breakEven && (
            <Pill tone="muted" className="ml">
              BE
            </Pill>
          )}
        </span>
      ),
    },
    {
      key: 'tp',
      header: 'TP1/2/3',
      align: 'right',
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
    { key: 'upnl', header: 'Unrealized', align: 'right', value: (p) => livePnl(p), render: (p) => <Pnl value={livePnl(p)} /> },
    ...(compact
      ? []
      : ([
          { key: 'rpnl', header: 'Realized', align: 'right', value: (p) => p.realizedPnl, render: (p) => <Pnl value={p.realizedPnl} /> },
          { key: 'r', header: 'R', align: 'right', value: (p) => p.rMultiple, render: (p) => <span className={`mono ${p.rMultiple >= 0 ? 'gain' : 'loss'}`}>{fmtR(p.rMultiple)}</span> },
          { key: 'risk', header: 'Risk', align: 'right', value: (p) => p.riskAmount, render: (p) => <span className="mono">{fmtPrice(p.riskAmount)}</span> },
        ] as Column<Position>[])),
    {
      key: 'age',
      header: 'Opened',
      value: (p) => p.entryAt,
      render: (p) => (
        <span className="muted small" title={fmtDateTime(p.entryAt)}>
          {timeAgo(p.entryAt, now)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      align: 'right',
      render: (p) => (
        <button className="btn btn-xs btn-danger-outline" onClick={() => setClosing(p)} disabled={close.isPending}>
          Close
        </button>
      ),
    },
  ]

  return (
    <>
      <DataTable columns={cols} rows={positions} rowKey={(p) => p.id} emptyLabel="No open positions" defaultSort={{ key: 'age', dir: 'desc' }} />
      <ConfirmDialog
        open={!!closing}
        title={closing ? `Close ${closing.side.toUpperCase()} ${closing.symbol}?` : ''}
        body={closing ? <p>Closes {fmtInt(closing.qtyOpen)} contracts at market (paper).</p> : null}
        confirmLabel="Close position"
        danger
        busy={close.isPending}
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
