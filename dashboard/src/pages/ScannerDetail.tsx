import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useBacktest, useConfig, useEquity, useMarkets, useRunBacktest, useRunScanner, useScannerSource, useScanners, useSignals, useTrades } from '../api/queries'
import type { Trade } from '../api/types'
import { VelaChart, type ChartScript } from '../chart/VelaChart'
import { EquityChart } from '../components/charts'
import { DataTable, type Column } from '../components/DataTable'
import { IconExternal, IconPlay } from '../components/Icons'
import { Collapsible, Empty, ErrorState, ExitReasonPill, KpiTile, Loading, Panel, Pill, Pnl, QueryState, ScannerStatusPill, Segmented, SidePill, Time } from '../components/ui'
import { SignalsTable } from './Signals'
import { fmtInt, fmtMs, fmtNum, fmtPct, fmtPrice, fmtR } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'

export function ScannerDetail() {
  const { id = '' } = useParams()
  const scanners = useScanners()
  const config = useConfig()
  const markets = useMarkets()
  const s = scanners.data?.find((x) => x.id === id)
  const toast = useToast()

  const symbols = useMemo(() => {
    const own = s?.symbols?.length ? s.symbols : (config.data?.symbols ?? [])
    return own.length ? own : (markets.data ?? []).map((m) => m.symbol).slice(0, 5)
  }, [s, config.data, markets.data])
  const tfs = useMemo(() => (s?.timeframes?.length ? s.timeframes : config.data?.timeframes?.length ? config.data.timeframes : ['15m']), [s, config.data])

  const [symbolSel, setSymbol] = useState('')
  const [tfSel, setTf] = useState('')
  const symbol = symbolSel && symbols.includes(symbolSel) ? symbolSel : (symbols[0] ?? '')
  const tf = tfSel && tfs.includes(tfSel) ? tfSel : (tfs[0] ?? '')

  const [showScript, setShowScript] = useState(false)
  const source = useScannerSource(showScript ? id : undefined)
  const scripts = useMemo<ChartScript[]>(() => {
    if (!showScript || !s || !source.data?.patched) return []
    return [{ id: s.id, title: s.name, source: source.data.patched, overlay: s.overlay }]
  }, [showScript, s, source.data])

  const signals = useSignals({ scanner: id, limit: 100 })
  const trades = useTrades({ scanner: id, limit: 200 })
  const equity = useEquity(id)
  const run = useRunScanner()
  const backtest = useBacktest(id, symbol, tf)
  const runBt = useRunBacktest()
  const tick = markets.data?.find((m) => m.symbol === symbol)?.tickSize

  if (scanners.isLoading && !scanners.data)
    return (
      <div className="page">
        <Loading rows={3} />
        <Loading kind="kpi" rows={8} />
        <Loading kind="chart" height={520} />
      </div>
    )
  if (scanners.isError && !scanners.data) return <ErrorState error={scanners.error} onRetry={() => scanners.refetch()} />
  if (!s)
    return (
      <div className="page">
        <ErrorState label={`Scanner “${id}” not found`} />
        <Link to="/scanners" className="link">
          ← back to scanners
        </Link>
      </div>
    )

  const st = s.stats
  const bt = st?.backtest
  const btRes = runBt.data ?? backtest.data

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <nav className="crumbs small muted" aria-label="Breadcrumb">
            <Link to="/scanners" className="link">
              scanners
            </Link>{' '}
            / <span className="mono">{s.id}</span>
          </nav>
          <h1 className="h1">
            {s.name}{' '}
            <a href={s.url} target="_blank" rel="noreferrer" className="link muted" title="Open on TradingView" aria-label="Open on TradingView">
              <IconExternal size={14} />
            </a>
          </h1>
          <div className="row gap">
            <ScannerStatusPill status={s.status} reason={s.reason} />
            <Pill tone={s.enabled ? 'ok' : 'muted'}>{s.enabled ? 'ENABLED' : 'DISABLED'}</Pill>
            <Pill tone="accent">{s.exitMode}</Pill>
            <span className="muted small mono">
              v{s.pineVersion} · {s.lines} lines · {s.file}
            </span>
          </div>
          {s.reason && <div className="small loss mt">{s.reason}</div>}
          {s.lastRun && (
            <div className="small muted mt">
              last run <Time t={s.lastRun.at} mode="ago" /> on {s.lastRun.symbol} {s.lastRun.tf} in {fmtMs(s.lastRun.ms)}
              {s.lastRun.error && <span className="loss"> · {s.lastRun.error}</span>}
            </div>
          )}
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() =>
              run.mutate(s.id, {
                onSuccess: (r) => toast.success('Queued', `${r.queued} run(s)`),
                onError: (e) => toast.error('Run failed', e.message),
              })
            }
            disabled={s.status !== 'ok' || run.isPending}
          >
            <IconPlay /> {run.isPending ? 'Queuing…' : 'Run now'}
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <KpiTile label="Signals" value={fmtInt(st?.signals)} />
        <KpiTile label="Trades" value={fmtInt(st?.trades)} sub={<span className="muted">{st?.open ?? 0} open</span>} />
        <KpiTile label="Win rate" value={fmtPct(st?.winRatePct)} sub={<span className="muted">{st?.wins ?? 0}W / {st?.losses ?? 0}L</span>} />
        <KpiTile label="Profit factor" value={fmtNum(st?.profitFactor)} tone={(st?.profitFactor ?? 0) >= 1 ? 'gain' : 'loss'} />
        <KpiTile label="PnL" value={<Pnl value={st?.pnl} />} sub={<span className="muted">{fmtPct(st?.pnlPct, 1, true)}</span>} />
        <KpiTile label="Avg R" value={fmtR(st?.avgR)} tone={(st?.avgR ?? 0) >= 0 ? 'gain' : 'loss'} />
        <KpiTile label="Max DD" value={`−${fmtPct(Math.abs(st?.maxDrawdownPct ?? 0))}`} tone="loss" />
        <KpiTile label="Backtest PF" value={bt ? fmtNum(bt.profitFactor) : '–'} sub={bt ? <span className="muted">{bt.trades} trades · {fmtPct(bt.winRatePct)} · <Pnl value={bt.pnl} /></span> : <span className="muted">no warm backtest</span>} hint="Backtest profit factor" />
      </div>

      <Panel
        title="Chart"
        right={
          <div className="row gap">
            <Segmented ariaLabel="Symbol" value={symbol} onChange={setSymbol} options={symbols} />
            <Segmented ariaLabel="Timeframe" value={tf} onChange={setTf} options={tfs.length ? tfs : [...DELTA_TIMEFRAMES]} />
            <label className="check">
              <input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} /> Show script on chart
            </label>
            {showScript && source.isLoading && <span className="muted small">loading source…</span>}
            {showScript && source.isError && <span className="loss small">source unavailable</span>}
          </div>
        }
        pad={false}
      >
        {symbol && tf ? <VelaChart symbol={symbol} tf={tf} height={520} scripts={scripts} tickSize={tick} /> : <Loading kind="chart" height={520} />}
      </Panel>

      <div className="grid-2-1">
        <Panel title="Equity curve (this scanner)">
          <QueryState {...equity} data={equity.data} empty="No equity points for this scanner." hint="The curve starts with its first closed trade." skeleton="chart" skeletonHeight={200} onRetry={() => equity.refetch()}>
            {(d) => <EquityChart data={d} height={200} />}
          </QueryState>
        </Panel>
        <Panel
          title="Backtest"
          right={
            <button
              className="btn btn-sm btn-cta"
              disabled={!symbol || !tf || runBt.isPending}
              onClick={() =>
                runBt.mutate(
                  { scanner: s.id, symbol, tf },
                  {
                    onSuccess: (r) => toast.success('Backtest complete', `${r.trades?.length ?? 0} trades over ${r.bars} bars`),
                    onError: (e) => toast.error('Backtest failed', e.message),
                  },
                )
              }
            >
              {runBt.isPending ? 'Running…' : `Run backtest ${symbol} ${tf}`}
            </button>
          }
        >
          {backtest.isLoading && !btRes && <Loading rows={4} />}
          {!btRes && !backtest.isLoading && <Empty label={`No backtest for ${symbol} ${tf} yet.`} hint="Run one with the button above." />}
          {btRes && (
            <div className="bt">
              <div className="bt-stats">
                <span className="stat-chip">
                  <span className="stat-k">BARS</span>
                  <span className="mono">{fmtInt(btRes.bars)}</span>
                </span>
                <span className="stat-chip">
                  <span className="stat-k">TRADES</span>
                  <span className="mono">{fmtInt(btRes.trades?.length ?? (btRes.stats?.trades as number))}</span>
                </span>
                <span className="stat-chip">
                  <span className="stat-k">WIN</span>
                  <span className="mono">{fmtPct(btRes.stats?.winRatePct as number)}</span>
                </span>
                <span className="stat-chip">
                  <span className="stat-k">PF</span>
                  <span className="mono">{fmtNum(btRes.stats?.profitFactor as number)}</span>
                </span>
                <span className="stat-chip">
                  <span className="stat-k">PNL</span>
                  <Pnl value={btRes.stats?.pnl as number} />
                </span>
                <span className="stat-chip">
                  <span className="stat-k">MAX DD</span>
                  <span className="mono">{fmtPct(btRes.stats?.maxDrawdownPct as number)}</span>
                </span>
                <span className="muted small">
                  at <Time t={btRes.at} mode="datetime" />
                </span>
              </div>
              {btRes.equity?.length > 1 && <EquityChart data={btRes.equity.map((e) => ({ at: e.at, equity: e.equity, realized: 0, unrealized: 0 }))} height={140} />}
              <TradesMini trades={btRes.trades ?? []} tick={tick} maxHeight={300} />
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Signals" right={<span className="muted small">{signals.data?.length ?? 0} latest</span>} pad={false}>
        <QueryState {...signals} data={signals.data} empty="No signals from this scanner." hint="Signals appear after the next closed bar once it is enabled." skeleton="table" skeletonRows={5} skeletonCols={9} onRetry={() => signals.refetch()}>
          {(d) => <SignalsTable signals={d} hideScanner maxHeight={360} />}
        </QueryState>
      </Panel>

      <Panel title="Closed trades" pad={false}>
        <QueryState {...trades} data={trades.data} empty="No closed trades from this scanner." hint="Trades land here once a TP, SL or script exit fires." skeleton="table" skeletonRows={5} skeletonCols={8} onRetry={() => trades.refetch()}>
          {(d) => <TradesMini trades={d} tick={tick} maxHeight={360} />}
        </QueryState>
      </Panel>

      <Collapsible title="Source" right={source.data ? <span className="muted small mono">{source.data.patches.length} patch(es)</span> : null}>
        <SourceViewer id={id} />
      </Collapsible>
    </div>
  )
}

function TradesMini({ trades, tick, maxHeight }: { trades: Trade[]; tick?: number; maxHeight?: number }) {
  const cols = useMemo<Column<Trade>[]>(
    () => [
      { key: 'exitAt', header: 'Closed', value: (t) => t.exitAt, render: (t) => <Time t={t.exitAt} mode="datetime" className="small muted" /> },
      {
        key: 'sym',
        header: 'Symbol',
        value: (t) => t.symbol,
        render: (t) => (
          <span>
            <b>{t.symbol}</b> <span className="muted small mono">{t.tf}</span>
          </span>
        ),
      },
      { key: 'side', header: 'Side', value: (t) => t.side, render: (t) => <SidePill side={t.side} /> },
      { key: 'entry', header: 'Entry', numeric: true, value: (t) => t.entryPrice, render: (t) => fmtPrice(t.entryPrice, tick) },
      { key: 'exit', header: 'Exit', numeric: true, value: (t) => t.exitPrice, render: (t) => fmtPrice(t.exitPrice, tick) },
      { key: 'pnl', header: 'PnL', numeric: true, value: (t) => t.pnl, render: (t) => <Pnl value={t.pnl} /> },
      { key: 'r', header: 'R', numeric: true, value: (t) => t.rMultiple, render: (t) => <span className={t.rMultiple >= 0 ? 'gain' : 'loss'}>{fmtR(t.rMultiple)}</span> },
      { key: 'reason', header: 'Exit reason', value: (t) => t.exitReason, render: (t) => <ExitReasonPill reason={t.exitReason} /> },
    ],
    [tick],
  )
  return <DataTable columns={cols} rows={trades} rowKey={(t) => t.id ?? `${t.positionId}-${t.exitAt}`} defaultSort={{ key: 'exitAt', dir: 'desc' }} emptyLabel="No trades" maxHeight={maxHeight} caption="Trades" />
}

function SourceViewer({ id }: { id: string }) {
  const src = useScannerSource(id)
  const [tab, setTab] = useState<'patched' | 'original'>('patched')
  if (src.isLoading) return <Loading rows={8} />
  if (src.isError || !src.data) return <ErrorState error={src.error} onRetry={() => src.refetch()} />
  const d = src.data
  return (
    <div>
      <div className="row gap mb">
        <Segmented ariaLabel="Source version" value={tab} onChange={setTab} options={['patched', 'original']} />
        <span className="muted small">
          patches:{' '}
          {d.patches.length ? (
            d.patches.map((p) => (
              <Pill key={p} tone="accent" className="ml">
                {p}
              </Pill>
            ))
          ) : (
            <span className="mono">none</span>
          )}
        </span>
      </div>
      <pre className="source">{tab === 'patched' ? d.patched : d.source}</pre>
    </div>
  )
}
