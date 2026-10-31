import { useMemo, useState } from 'react'
import { AccountingBadge } from './ExecutionAccounting'
import { Link, useSearchParams } from 'react-router-dom'
import { useMarkets, useScannerIndex, useTradesPage } from '../api/queries'
import type { Trade } from '../api/types'
import { DataTable, type Column } from './DataTable'
import { TradePath } from './TradePath'
import { ErrorState, ExitReasonPill, Loading, Panel, Pnl, SidePill, StatusDot, Time } from './ui'
import { fmtDuration, fmtInt, fmtMoney, fmtPct, fmtPnl, fmtPrice, fmtR, fmtTime } from '../lib/format'
import { JOURNAL_PAGE_SIZE, JOURNAL_PERIODS, journalFilters, updateJournalFilters } from '../lib/journalFilters'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useNow } from '../lib/useNow'

const EXIT_REASONS: Record<string, string> = { sl: 'Stop loss', trail: 'Trailing stop', be: 'Break-even', tp1: 'Take profit 1', tp2: 'Take profit 2', tp3: 'Take profit 3', script_exit: 'Script exit', reversal: 'Reversal', manual: 'Manual close', tp_partial: 'Partial take profit', liquidation: 'Liquidation', removed: 'Scanner removed' }

export function TradeJournal() {
  const [params, setParams] = useSearchParams()
  const now = useNow(60_000)
  const f = journalFilters(params, now)
  const update = (values: Record<string, string>) => setParams(updateJournalFilters(params, values))
  const [scannerSearch, setScannerSearch] = useState('')
  const [pathOf, setPathOf] = useState<{ id: number; title: string } | null>(null)
  const scanners = useScannerIndex()
  const markets = useMarkets()
  const pageQ = useTradesPage(f.query, !f.error)
  // Never show the previous selection's rows or totals beneath new filters.
  const trades = { ...pageQ, data: f.error ? undefined : pageQ.data?.trades }
  const rows = trades.data ?? []
  const total = pageQ.data?.total
  const pages = Math.max(1, Math.ceil((total ?? 0) / JOURNAL_PAGE_SIZE))
  const narrow = useMediaQuery('(max-width: 1440px)')
  const veryNarrow = useMediaQuery('(max-width: 1180px)')
  const mobile = useMediaQuery('(max-width: 760px)')
  const symbols = Array.from(new Set([...(markets.data ?? []).map(m => m.symbol), ...rows.map(t => t.symbol), ...(f.symbol ? [f.symbol] : [])])).sort()
  const filtered = Boolean(f.scanner || f.symbol || f.tf || f.side || f.reason || f.period !== 'all')
  const openPath = (t: Trade) => setPathOf({ id: t.positionId, title: `${t.symbol} ${t.side} · ${t.scannerName}` })
  const pagination = total !== undefined && !f.error && (pages > 1 || f.page > 0) ? <div className="journal-pagination" aria-label="Trade pages">
    <span className="small muted">{rows.length ? `${fmtInt(f.page * JOURNAL_PAGE_SIZE + 1)}–${fmtInt(f.page * JOURNAL_PAGE_SIZE + rows.length)} of ${fmtInt(total)}` : 'No trades on this page'}</span>
    <div className="row gap">
      <button className="btn btn-sm" onClick={() => update({page:String(Math.max(0, f.page - 1))})} disabled={f.page === 0} aria-label="Newer trades">Newer</button>
      <span className="mono small">{f.page + 1} / {pages}</span>
      <button className="btn btn-sm" onClick={() => update({page:String(f.page + 1)})} disabled={f.page >= pages - 1} aria-label="Older trades">Older</button>
    </div>
    {f.page >= pages && <button className="btn btn-sm" onClick={() => update({page:''})}>First page</button>}
  </div> : null
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
      { key: 'pnl', header: 'PnL (USD)', numeric: true, value: (t) => t.pnl, render: (t) => <div><AccountingBadge pending={t.accountingPending} /><details className="pnl-breakdown"><summary><Pnl value={t.pnl} /></summary><span className="small">Trading {fmtPnl(t.grossTradingPnl ?? (t.pnl + t.fees - (t.funding ?? 0)))} − commission {fmtMoney(t.fees)} + funding {fmtPnl(t.funding ?? 0)} = net {fmtPnl(t.pnl)}</span></details></div> },
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

  return <>
    <Panel className="trade-journal" title="Closed trade journal" pad={false} right={
      <div className="row gap">
        <button className="btn btn-sm" onClick={() => update({ period: 'today', reason: 'sl' })}>Today's stops</button>
        {filtered && <button className="btn btn-sm" onClick={() => { setParams({}); setScannerSearch('') }}>Clear filters</button>}
      </div>
    }>
      <div className="journal-filters">
        <label>Market<select className="select" aria-label="Journal market" value={f.symbol} onChange={e => update({symbol:e.target.value})}>
          <option value="">All markets</option>{symbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select></label>
        <label>Timeframe<select className="select" aria-label="Journal timeframe" value={f.tf} onChange={e => update({tf:e.target.value})}>
          <option value="">All timeframes</option>{f.tf && !DELTA_TIMEFRAMES.some(t => t === f.tf) && <option value={f.tf}>{f.tf}</option>}{DELTA_TIMEFRAMES.map(t => <option key={t} value={t}>{t}</option>)}
        </select></label>
        <label>Direction<select className="select" aria-label="Journal direction" value={f.side} onChange={e => update({side:e.target.value})}>
          <option value="">All directions</option><option value="long">Long</option><option value="short">Short</option>
        </select></label>
        <label>Exit<select className="select" aria-label="Journal exit reason" value={f.reason} onChange={e => update({reason:e.target.value})}>
          <option value="">All exits</option>{Array.from(new Set([...Object.keys(EXIT_REASONS),...rows.map(t => t.exitReason),...(f.reason ? [f.reason] : [])])).map(r => <option key={r} value={r}>{EXIT_REASONS[r] ?? r}</option>)}
        </select></label>
        <label>Closed in<select className="select" aria-label="Closing period" value={f.period} onChange={e => update({period:e.target.value})}>
          {JOURNAL_PERIODS.map(([value,label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <details className="journal-scanner-filter">
          <summary>Scanner: {f.scanner ? scanners.data?.find(s => s.id === f.scanner)?.name ?? f.scanner : 'All scanners'}</summary>
          <label>Find scanner<input className="input" type="search" placeholder="Search scanner names…" value={scannerSearch} onChange={e => setScannerSearch(e.target.value)} /></label>
          <label>Scanner<select className="select" aria-label="Journal scanner" value={f.scanner} onChange={e => update({scanner:e.target.value})}>
            <option value="">All scanners</option>
            {f.scanner && !scanners.data?.some(s => s.id === f.scanner) && <option value={f.scanner}>{f.scanner}</option>}
            {(scanners.data ?? []).filter(s => s.id === f.scanner || `${s.name} ${s.id}`.toLowerCase().includes(scannerSearch.toLowerCase())).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        </details>
        {f.period === 'custom' && <div className="journal-dates">
          <label>From (UTC)<input className="input" type="date" value={f.start} onChange={e => update({start:e.target.value})} /></label>
          <label>Through (UTC)<input className="input" type="date" value={f.end} min={f.start || undefined} onChange={e => update({end:e.target.value})} /></label>
        </div>}
      </div>
      <p className="journal-scope muted small">Filters apply to closed trades only. Closing days use UTC, matching Daily; timestamps use your local zone. Filters stay in the URL.</p>
      {!!pageQ.data?.accountingPending && <div className="banner banner-warn" role="status">{pageQ.data.accountingPending} matching trades have incomplete exchange accounting. Their P&amp;L and the totals below are provisional.</div>}
      {f.error ? <div className="banner banner-warn" role="alert">{f.error}</div> : <>
        <div className="journal-totals" aria-label="Filtered journal totals">
          <div><span>Matching trades</span><strong className="mono">{total === undefined ? '–' : fmtInt(total)}</strong></div>
          <div><span>Net P&L · USD</span><strong>{pageQ.data ? <Pnl value={pageQ.data.pnl} /> : '–'}</strong></div>
          <div><span>Commission · USD</span><strong className="mono">{pageQ.data ? fmtMoney(pageQ.data.fees) : '–'}</strong></div>
        </div>
        <div className="journal-scope small muted" role="status">Totals cover every match, across all pages. Net includes commission and funding. Table sorting applies to the current page.{pageQ.isFetching && pageQ.data ? ' Refreshing…' : ''}</div>
        {pagination}
        {trades.isLoading && <Loading kind="table" rows={5} cols={6} />}
        {trades.isError && !trades.data && <ErrorState error={trades.error} onRetry={() => trades.refetch()} />}
        {trades.data && rows.length === 0 ? <div className="journal-empty">
          <b>{filtered ? 'No closed trades match these filters.' : 'No closed trades yet.'}</b>
          <p className="muted small">{filtered ? 'Try another closing period, market, or exit reason.' : 'Completed account positions appear here when they close.'}</p>
          {filtered && <button className="btn btn-sm" onClick={() => { setParams({}); setScannerSearch('') }}>Show all history</button>}
        </div> : trades.data && (mobile ? <div className="journal-cards">
          {rows.map(t => <article key={t.id} className="journal-card">
            <div className="journal-card-head"><div><b>{t.symbol}</b> <span className="mono muted small">{t.tf}</span> <SidePill side={t.side} /></div><Pnl value={t.pnl} /></div>
            <AccountingBadge pending={t.accountingPending} />
            <Link to={`/scanners/${t.scannerId}`} className="link small">{t.scannerName}</Link>
            <div className="journal-card-meta"><Time t={t.exitAt} mode="datetime" className="small muted" /><ExitReasonPill reason={t.exitReason} /></div>
            <dl className="journal-card-metrics">
              <div><dt>Net return</dt><dd className="mono">{fmtR(t.rMultiple)}</dd></div>
              <div><dt>Held</dt><dd>{fmtDuration(t.exitAt - t.entryAt)}</dd></div>
              <div><dt>Entry</dt><dd className="mono">{fmtPrice(t.entryPrice, markets.data?.find(m => m.symbol === t.symbol)?.tickSize)}</dd></div>
              <div><dt>Exit</dt><dd className="mono">{fmtPrice(t.exitPrice, markets.data?.find(m => m.symbol === t.symbol)?.tickSize)}</dd></div>
            </dl>
            <details className="journal-costs"><summary>Costs & fills · commission {fmtMoney(t.fees)}</summary>
              <dl className="journal-card-metrics">
                <div><dt>Trading P&L</dt><dd>{fmtPnl(t.grossTradingPnl ?? (t.pnl + t.fees - (t.funding ?? 0)))}</dd></div>
                <div><dt>Funding</dt><dd>{fmtPnl(t.funding ?? 0)}</dd></div>
                <div><dt>Contracts</dt><dd>{fmtInt(t.qty)}</dd></div>
                <div><dt>Fills</dt><dd>{t.fills?.length ?? 0}</dd></div>
              </dl>
              <p className="muted small">Trading P&L − commission + funding = net P&L.</p>
            </details>
            <div className="journal-card-actions"><button className="btn btn-sm" onClick={() => openPath(t)}>View trade path</button><Link className="btn btn-sm" to={`/signals?${new URLSearchParams({scanner:t.scannerId,symbol:t.symbol,tf:t.tf})}`}>Signal journal</Link></div>
          </article>)}
        </div> : <DataTable columns={tradeCols} rows={rows} rowKey={t => t.id} onRowClick={openPath} defaultSort={{key:'exitAt',dir:'desc'}} caption="Closed trades" />)}
        {rows.length > 10 && pagination}
      </>}
    </Panel>
    <TradePath id={pathOf?.id ?? null} title={pathOf?.title} onClose={() => setPathOf(null)} />
  </>
}
