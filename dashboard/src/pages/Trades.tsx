import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCloseAll, useMarkets, useOrders, usePositions, useScannerIndex, useTrades } from '../api/queries'
import type { Order, Trade } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { PositionsTable } from '../components/PositionsTable'
import { ConfirmDialog, ErrorState, ExitReasonPill, Loading, PageTitle, Panel, Pnl, QueryState, SidePill, StatusDot, Time } from '../components/ui'
import { fmtDuration, fmtInt, fmtMoney, fmtPct, fmtPnl, fmtPrice, fmtR, fmtTime } from '../lib/format'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useToast } from '../lib/toast'

const EXIT_REASONS: Record<string, string> = { tp1: 'Take profit 1', tp2: 'Take profit 2', tp3: 'Take profit 3', sl: 'Stop loss', be: 'Break-even', script_exit: 'Script exit', reversal: 'Reversal', manual: 'Manual close', tp_partial: 'Partial take profit', liquidation: 'Liquidation', removed: 'Scanner removed' }

export function Trades() {
  const positions = usePositions()
  const scanners = useScannerIndex()
  const markets = useMarkets()
  const closeAll = useCloseAll()
  const toast = useToast()
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const [scanner, setScanner] = useState('')
  const [scannerSearch, setScannerSearch] = useState('')
  const [symbol, setSymbol] = useState('')
  const [reason, setReason] = useState('')
  const q = useMemo(() => ({ limit: 300, scanner: scanner || undefined, symbol: symbol || undefined }), [scanner, symbol])
  const trades = useTrades(q)
  const orders = useOrders(200)
  // the closed-trades table needs ~1300px for every column; below that, shed the derived ones
  const narrow = useMediaQuery('(max-width: 1440px)')
  const veryNarrow = useMediaQuery('(max-width: 1180px)')

  const rows = useMemo(() => (trades.data ?? []).filter((t) => !reason || t.exitReason === reason), [trades.data, reason])
  const totals = useMemo(() => rows.reduce((a, t) => ({ pnl: a.pnl + t.pnl, fees: a.fees + (t.fees ?? 0) }), { pnl: 0, fees: 0 }), [rows])
  const symbolOptions = useMemo(() => {
    const set = new Set<string>((markets.data ?? []).map((m) => m.symbol))
    for (const t of trades.data ?? []) set.add(t.symbol)
    return Array.from(set)
  }, [markets.data, trades.data])

  const tradeCols = useMemo<Column<Trade>[]>(() => {
    const tick = (sym: string) => markets.data?.find((m) => m.symbol === sym)?.tickSize
    return [
      { key: 'exitAt', header: 'Closed', value: (t) => t.exitAt, render: (t) => <Time t={t.exitAt} mode="datetime" className="small" /> },
      {
        key: 'symbol',
        header: 'Symbol',
        value: (t) => t.symbol,
        render: (t) => (
          <span className="cell-sym">
            <StatusDot tone={t.pnl >= 0 ? 'ok' : 'danger'} />
            <span>
              <b>{t.symbol}</b> <span className="muted small mono">{t.tf}</span>
              <div className="muted small">
                <Link to={`/scanners/${t.scannerId}`} className="link">
                  {t.scannerName}
                </Link>
              </div>
            </span>
          </span>
        ),
      },
      { key: 'side', header: 'Side', value: (t) => t.side, render: (t) => <SidePill side={t.side} /> },
      { key: 'qty', header: 'Qty', numeric: true, value: (t) => t.qty, render: (t) => <span className="mono">{fmtInt(t.qty)}</span> },
      { key: 'entry', header: 'Entry', numeric: true, value: (t) => t.entryPrice, render: (t) => <span className="mono">{fmtPrice(t.entryPrice, tick(t.symbol))}</span> },
      { key: 'exit', header: 'Exit price', numeric: true, value: (t) => t.exitPrice, render: (t) => <span className="mono">{fmtPrice(t.exitPrice, tick(t.symbol))}</span> },
      ...(veryNarrow
        ? []
        : ([{ key: 'dur', header: 'Held', numeric: true, value: (t) => t.exitAt - t.entryAt, render: (t) => <span className="mono muted small">{fmtDuration(t.exitAt - t.entryAt)}</span> }] as Column<Trade>[])),
      { key: 'pnl', header: 'PnL (USD)', numeric: true, value: (t) => t.pnl, render: (t) => <Pnl value={t.pnl} /> },
      // return % and fees restate what PnL already says, so they are the first to go when narrow
      ...(narrow
        ? []
        : ([
            { key: 'pnlPct', header: 'Return %', title: 'Net P&L divided by initial entry notional, after fees', numeric: true, value: (t) => t.pnlPct, render: (t) => <span className={`mono ${t.pnlPct >= 0 ? 'gain' : 'loss'}`}>{fmtPct(t.pnlPct, 1, true)}</span> },
            { key: 'fees', header: 'Fees (USD)', numeric: true, value: (t) => t.fees, render: (t) => <span className="mono muted">{fmtMoney(t.fees)}</span> },
          ] as Column<Trade>[])),
      { key: 'r', header: 'R', numeric: true, value: (t) => t.rMultiple, render: (t) => <span className={`mono ${t.rMultiple >= 0 ? 'gain' : 'loss'}`}>{fmtR(t.rMultiple)}</span> },
      { key: 'reason', header: 'Exit reason', value: (t) => t.exitReason, render: (t) => <ExitReasonPill reason={t.exitReason} /> },
      {
        key: 'fills',
        header: 'Fills',
        numeric: true,
        value: (t) => t.fills?.length ?? 0,
        render: (t) => (
          <span className="mono small muted" title={(t.fills ?? []).map((f) => `${fmtTime(f.at)} ${f.reason} ${f.qty}@${fmtPrice(f.price, tick(t.symbol))}`).join('\n')}>
            {t.fills?.length ?? 0}
          </span>
        ),
      },
    ]
  }, [markets.data, narrow, veryNarrow])

  const orderCols = useMemo<Column<Order>[]>(() => {
    const tick = (sym: string) => markets.data?.find((m) => m.symbol === sym)?.tickSize
    return [
      { key: 'at', header: 'Time', value: (o) => o.at, render: (o) => <Time t={o.at} mode="datetime" className="small" /> },
      { key: 'symbol', header: 'Symbol', value: (o) => o.symbol, render: (o) => <b>{o.symbol}</b> },
      { key: 'side', header: 'Side', value: (o) => o.side, render: (o) => <span className={`side ${o.side === 'buy' ? 'side-long' : 'side-short'}`}>{o.side.toUpperCase()}</span> },
      { key: 'qty', header: 'Qty', numeric: true, value: (o) => o.qty, render: (o) => <span className="mono">{fmtInt(o.qty)}</span> },
      { key: 'price', header: 'Price', numeric: true, value: (o) => o.price, render: (o) => <span className="mono">{fmtPrice(o.price, tick(o.symbol))}</span> },
      { key: 'fee', header: 'Fee (USD)', numeric: true, value: (o) => o.fee, render: (o) => <span className="mono muted">{fmtMoney(o.fee)}</span> },
      { key: 'reason', header: 'Reason', value: (o) => o.reason, render: (o) => <ExitReasonPill reason={o.reason} /> },
      { key: 'pos', header: 'Pos', numeric: true, value: (o) => o.positionId, render: (o) => <span className="mono muted">#{o.positionId}</span> },
      {
        key: 'scanner',
        header: 'Scanner',
        value: (o) => o.scannerId,
        render: (o) => (
          <Link to={`/scanners/${o.scannerId}`} className="link small">
            {o.scannerId}
          </Link>
        ),
      },
    ]
  }, [markets.data])

  const openCount = positions.data?.length ?? 0

  return (
    <div className="page">
      <PageTitle pre="Positions," accent="managed" post="to the last fill." sub="Open exposure, closed trades and the execution log of the paper engine." />

      <Panel
        title={
          <span>
            Open positions <span className="muted small">({openCount})</span>
          </span>
        }
        right={
          <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmCloseAll(true)} disabled={openCount === 0 || closeAll.isPending}>
            {closeAll.isPending ? 'Closing…' : 'Close all'}
          </button>
        }
        pad={false}
      >
        {positions.isLoading && !positions.data ? (
          <Loading kind="table" rows={3} cols={10} />
        ) : positions.isError && !positions.data ? (
          <ErrorState error={positions.error} onRetry={() => positions.refetch()} />
        ) : (
          <PositionsTable positions={positions.data ?? []} />
        )}
      </Panel>

      <Panel
        title={
          <span>
            Closed trades <span className="muted small">({rows.length})</span>{' '}
            <span className={`mono small ${totals.pnl >= 0 ? 'gain' : 'loss'}`}>· net {fmtPnl(totals.pnl)}</span>{' '}
            <span className="muted small">· fees {fmtMoney(totals.fees)}</span>
          </span>
        }
        right={
          <div className="row gap filters">
            <input className="input scanner-search" type="search" aria-label="Search scanner options" placeholder="Search scanners…" value={scannerSearch} onChange={(e) => setScannerSearch(e.target.value)} />
            <select className="select select-sm" value={scanner} onChange={(e) => setScanner(e.target.value)} aria-label="Scanner">
              <option value="">All scanners</option>
              {(scanners.data ?? []).filter((s) => s.id === scanner || `${s.name} ${s.id}`.toLowerCase().includes(scannerSearch.toLowerCase())).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
              <option value="">All symbols</option>
              {symbolOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Exit reason">
              <option value="">All exits</option>
              {Array.from(new Set([...Object.keys(EXIT_REASONS), ...(trades.data ?? []).map((t) => t.exitReason)])).map((r) => (
                <option key={r} value={r}>
                  {EXIT_REASONS[r] ?? r}
                </option>
              ))}
            </select>
          </div>
        }
        pad={false}
      >
        {trades.isLoading && !trades.data && <Loading kind="table" rows={8} cols={12} />}
        {trades.isError && !trades.data && <ErrorState error={trades.error} onRetry={() => trades.refetch()} />}
        {trades.data && (
          <DataTable
            columns={tradeCols}
            rows={rows}
            rowKey={(t) => t.id}
            defaultSort={{ key: 'exitAt', dir: 'desc' }}
            emptyLabel={
              <span>
                No closed trades
                <span className="empty-hint">Trades land here once a TP, SL or script exit fires on an open position.</span>
              </span>
            }
            caption="Closed trades"
          />
        )}
      </Panel>

      <Panel title="Orders / fills" pad={false}>
        <QueryState {...orders} data={orders.data} empty="No fills yet." hint="Every paper fill (entry, partial TP, exit) is logged here." skeleton="table" skeletonRows={5} skeletonCols={9} onRetry={() => orders.refetch()}>
          {(d) => <DataTable columns={orderCols} rows={d} rowKey={(o) => o.id} defaultSort={{ key: 'at', dir: 'desc' }} caption="Orders and fills" />}
        </QueryState>
      </Panel>

      <ConfirmDialog
        open={confirmCloseAll}
        title={`Close all ${openCount} open position${openCount === 1 ? '' : 's'}?`}
        body={<p>Every open position is closed at market (paper). This cannot be undone.</p>}
        confirmLabel="Close all"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmCloseAll(false)}
        onConfirm={() =>
          closeAll.mutate(undefined, {
            onSuccess: () => {
              setConfirmCloseAll(false)
              toast.success('All positions closed')
            },
            onError: (e) => toast.error('Close all failed', e.message),
          })
        }
      />
    </div>
  )
}
