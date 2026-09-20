import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useEquity, usePositions, useScanners, useSignals, useStats } from '../api/queries'
import { AlertsFeed } from '../components/AlertsFeed'
import { EquityChart, PnlByScannerChart, type PnlBar } from '../components/charts'
import { PositionsTable } from '../components/PositionsTable'
import { TickerTape } from '../components/TickerTape'
import { ErrorState, KpiTile, Loading, PageTitle, Panel, QueryState } from '../components/ui'
import { fmtInt, fmtMoney, fmtProfitFactor, fmtPct, fmtPnl, fmtR, pnlClass } from '../lib/format'

export function Overview() {
  const stats = useStats()
  const equity = useEquity()
  const scanners = useScanners()
  const signals = useSignals({ limit: 15 })
  const positions = usePositions()

  const s = stats.data
  const pnlBars = useMemo<PnlBar[]>(() => {
    if (!s?.byScanner) return []
    const names = new Map((scanners.data ?? []).map((x) => [x.id, x.name]))
    return Object.entries(s.byScanner)
      .filter(([, v]) => v && (v.trades > 0 || v.pnl !== 0))
      .map(([id, v]) => ({ id, name: names.get(id) ?? id, pnl: v.pnl }))
  }, [s, scanners.data])

  const expectancy = useMemo(() => {
    if (!s?.byScanner) return null
    let sumR = 0
    let n = 0
    for (const v of Object.values(s.byScanner)) {
      if (v && v.trades > 0 && Number.isFinite(v.avgR)) {
        sumR += v.avgR * v.trades
        n += v.trades
      }
    }
    return n ? sumR / n : null
  }, [s])

  const visibleScanners = (scanners.data ?? []).filter((x) => !x.hidden).length
  const net = s ? s.realizedPnl + s.unrealizedPnl : 0

  return (
    <div className="page">
      <TickerTape />
      <PageTitle pre="The market's noise," accent="filtered" post="to conviction." sub={scanners.data ? `Paper-trading ${visibleScanners} Pine scanners using Delta India market data. Fills and P&L are simulated.` : 'Paper-trading Pine scanners using Delta India market data. Fills and P&L are simulated.'} />

      {stats.isLoading && !s && <Loading kind="kpi" rows={9} />}
      {stats.isError && !s && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
      {s && (
        <div className="kpi-grid">
          <KpiTile label="Equity (USD)" value={fmtMoney(s.equity, 2)} sub={<span className="muted">initial {fmtMoney(s.initialEquity, 0)}</span>} />
          <KpiTile label="Net PnL (USD)" value={fmtPnl(net)} tone={pnlClass(net) as 'gain' | 'loss' | 'neutral'} sub={<span className="muted">{s.initialEquity ? `${fmtPct((net / s.initialEquity) * 100, 1, true)} of purse` : ''} · after fees</span>} />
          <KpiTile label="Realized PnL (USD)" value={fmtPnl(s.realizedPnl)} tone={pnlClass(s.realizedPnl) as 'gain' | 'loss' | 'neutral'} sub={<span className="muted">fees {fmtMoney(s.fees)}</span>} />
          <KpiTile label="Unrealized PnL (USD)" value={fmtPnl(s.unrealizedPnl)} tone={pnlClass(s.unrealizedPnl) as 'gain' | 'loss' | 'neutral'} sub={<span className={pnlClass(s.todayPnl)}>today {fmtPnl(s.todayPnl)}</span>} />
          <KpiTile label="Win rate" value={fmtPct(s.winRatePct)} sub={<span className="muted">{s.wins}W / {s.losses}L</span>} />
          <KpiTile label="Profit factor" value={fmtProfitFactor(s.profitFactor)} tone={s.profitFactor >= 1 ? 'gain' : 'loss'} />
          <KpiTile label="Expectancy" value={fmtR(expectancy)} tone={expectancy == null ? 'neutral' : expectancy >= 0 ? 'gain' : 'loss'} hint="Average R per trade, weighted by trade count" />
          <KpiTile label="Max drawdown" value={`−${fmtPct(Math.abs(s.maxDrawdownPct))}`} tone="loss" />
          <KpiTile label="Trades" value={fmtInt(s.trades)} sub={<span className="muted">{s.openPositions} open</span>} />
        </div>
      )}

      <div className="grid-2-1">
        <Panel title="Equity curve" right={<span className="muted small mono">USD · simulated equity</span>}>
          <QueryState {...equity} data={equity.data} empty="No equity points yet." hint="The curve starts with the first fill." skeleton="chart" skeletonHeight={240} onRetry={() => equity.refetch()}>
            {(d) => <EquityChart data={d} height={240} baseline={s?.initialEquity} />}
          </QueryState>
        </Panel>
        <Panel
          title="Live signals"
          right={
            <Link to="/signals" className="btn btn-xs">
              All signals →
            </Link>
          }
          pad={false}
        >
          <QueryState {...signals} data={signals.data} empty="No signals yet." hint="Enable a scanner and wait for the next closed bar." skeleton="cards" skeletonRows={4} onRetry={() => signals.refetch()}>
            {(d) => <AlertsFeed signals={d} limit={15} />}
          </QueryState>
        </Panel>
      </div>

      <div className="grid-2-1">
        <Panel title="PnL by scanner">
          {stats.isLoading && !s ? <Loading kind="chart" height={240} /> : <PnlByScannerChart data={pnlBars} height={240} />}
        </Panel>
        <Panel title="Scanner fleet">
          <QueryState {...scanners} data={scanners.data} empty="No scanners loaded." hint="Drop .pine files into the scanners folder and restart the server." onRetry={() => scanners.refetch()}>
            {(d) => {
              const ok = d.filter((x) => x.status === 'ok').length
              const en = d.filter((x) => x.enabled).length
              const err = d.filter((x) => x.lastRun?.error).length
              return (
                <div className="fleet">
                  <div className="fleet-row">
                    <span>Total</span>
                    <span className="mono">{d.length}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Runnable</span>
                    <span className="mono gain">{ok}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Enabled</span>
                    <span className="mono accent">{en}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Incompatible</span>
                    <span className="mono loss">{d.filter((x) => x.status === 'incompatible').length}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Unavailable</span>
                    <span className="mono warn">{d.filter((x) => x.status === 'unavailable').length}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Last-run errors</span>
                    <span className={`mono ${err ? 'loss' : ''}`}>{err}</span>
                  </div>
                  <Link to="/scanners" className="btn btn-sm mt">
                    Manage scanners
                  </Link>
                </div>
              )
            }}
          </QueryState>
        </Panel>
      </div>

      <Panel
        title="Open positions"
        right={
          <Link to="/trades" className="btn btn-xs">
            Positions & trades →
          </Link>
        }
        pad={false}
      >
        {positions.isLoading && !positions.data ? (
          <Loading kind="table" rows={3} cols={10} />
        ) : positions.isError && !positions.data ? (
          <ErrorState error={positions.error} onRetry={() => positions.refetch()} />
        ) : (
          <PositionsTable positions={positions.data ?? []} compact />
        )}
      </Panel>
    </div>
  )
}
