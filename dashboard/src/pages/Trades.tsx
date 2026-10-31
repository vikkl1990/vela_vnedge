import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TradeJournal } from '../components/TradeJournal'
import { AccountingBadge } from '../components/ExecutionAccounting'
import { useCloseAll, useExecution, useMarkets, useOrders, usePositions } from '../api/queries'
import type { Order } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { PositionsTable } from '../components/PositionsTable'
import { BookBadge, ConfirmDialog, ErrorState, ExitReasonPill, Loading, PageTitle, Panel, Pill, Pnl, QueryState, Time } from '../components/ui'
import { fmtInt, fmtMoney, fmtPrice } from '../lib/format'
import { useToast } from '../lib/toast'

export function Trades() {
  const positions = usePositions()
  const markets = useMarkets()
  const closeAll = useCloseAll()
  const exec = useExecution()
  const mode = exec.data?.mode ?? 'paper'
  const mirrored = mode !== 'paper' && !exec.data?.dryRun
  const toast = useToast()
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const orders = useOrders(200)

  const orderCols = useMemo<Column<Order>[]>(() => {
    const tick = (sym: string) => markets.data?.find((m) => m.symbol === sym)?.tickSize
    return [
      { key: 'at', header: 'Time', value: (o) => o.at, render: (o) => <Time t={o.at} mode="datetime" className="small" /> },
      { key: 'symbol', header: 'Symbol', value: (o) => o.symbol, render: (o) => <b>{o.symbol}</b> },
      { key: 'side', header: 'Side', value: (o) => o.side, render: (o) => <span className={`side ${o.side === 'buy' ? 'side-long' : 'side-short'}`}>{o.side.toUpperCase()}</span> },
      { key: 'qty', header: 'Qty', numeric: true, value: (o) => o.qty, render: (o) => <span className="mono">{fmtInt(o.qty)}</span> },
      {
        key: 'price', header: 'Price', numeric: true, value: (o) => o.price, title: 'exch = restated from the exchange\'s own fill; quote = crossed the live spread; otherwise modelled slippage',
        render: (o) => <span className="mono">{fmtPrice(o.price, tick(o.symbol))}{o.accountingState && o.accountingState!=='complete' ? <AccountingBadge pending /> : o.priceSource === 'exchange' ? <Pill tone="ok" className="ml">exch</Pill> : o.priceSource === 'depth' ? <span className="muted small"> depth</span> : o.priceSource === 'quote' ? <span className="muted small"> q</span> : null}</span>,
      },
      { key: 'funding', header: 'Funding (USD)', numeric: true, value: o => o.pnl, render: o => o.reason === 'funding' ? <span title="Paper settlement cashflow; source coverage is on Exchange">{o.pnl == null ? 'unavailable' : <Pnl value={o.pnl} />}</span> : <span className="muted">–</span> },
      { key: 'fee', header: 'Commission (USD)', numeric: true, value: (o) => o.fee, render: (o) => <span className="mono muted">{fmtMoney(o.fee)}</span> },
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
      <PageTitle pre="Positions," accent="managed" post="to the last fill." sub={<>The account's open exposure, closed trades and fills. <BookBadge book="account" mode={mode} short /> Shadow-book trades live in the Incubator; backtests in each scanner.</>} />

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

      <TradeJournal />

      <Panel title="Orders / fills" right={<span className="small muted">Latest 200 · all markets · independent of journal filters</span>} pad={false}>
        <QueryState {...orders} data={orders.data} empty="No fills yet." hint="Every paper fill (entry, partial TP, exit) is logged here." skeleton="table" skeletonRows={5} skeletonCols={9} onRetry={() => orders.refetch()}>
          {(d) => <DataTable columns={orderCols} rows={d} rowKey={(o) => o.id} defaultSort={{ key: 'at', dir: 'desc' }} caption="Orders and fills" />}
        </QueryState>
      </Panel>

      <ConfirmDialog
        open={confirmCloseAll}
        title={`Close all ${openCount} open position${openCount === 1 ? '' : 's'}?`}
        body={<p>Every open position is closed at market {mirrored ? `— paper book and ${exec.data?.host ?? mode} account` : mode === 'paper' ? '(paper only)' : `(paper only; ${mode} is in dry-run)`}. This cannot be undone.{mirrored && <><br /><span className="muted small">The paper book closes immediately; exchange orders follow and are confirmed separately on the exchange.</span></>}</p>}
        confirmLabel="Close all"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmCloseAll(false)}
        onConfirm={() =>
          closeAll.mutate(undefined, {
            onSuccess: () => {
              setConfirmCloseAll(false)
              toast.success(mirrored ? 'Close requested: the paper book is flat' : 'All positions closed')
            },
            onError: (e) => toast.error('Close all failed', e.message),
          })
        }
      />
    </div>
  )
}
