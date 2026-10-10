import type { MarketVerdict } from '../api/types'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useEquity, useLearning, useMarketsToday, useOps, useOpsMetricsHistory, usePositions, useRefreshMarketsToday, useRisk, useScannerIndex, useSignals, useStats } from '../api/queries'
import { AlertsFeed } from '../components/AlertsFeed'
import { EquityChart, PnlByScannerChart, Sparkline, type PnlBar } from '../components/charts'
import { PositionsTable } from '../components/PositionsTable'
import { TickerTape } from '../components/TickerTape'
import { ErrorState, KpiTile, Loading, PageTitle, Panel, Pill, QueryState } from '../components/ui'
import { fmtInt, fmtMoney, fmtProfitFactor, fmtPct, fmtPnl, fmtR, pnlClass } from '../lib/format'

export function Overview() {
  const stats = useStats()
  const equity = useEquity()
  const scanners = useScannerIndex()
  const signals = useSignals({ limit: 15 })
  const positions = usePositions()
  const risk = useRisk()

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
  const net = s ? s.closedPnl + s.openPnl : 0
  const day = risk.data?.day

  return (
    <div className="page">
      <TickerTape />
      <EdgeVerdictLine />
      <PageTitle pre="The market's noise," accent="filtered" post="to conviction." sub={scanners.data ? `Paper account: ${visibleScanners} Pine scanners on Delta India data, fills and P&L simulated. The shadow book and backtests never touch it.` : 'Paper account on Delta India data. The shadow book and backtests never touch it.'} />

      {stats.isLoading && !s && <Loading kind="kpi" rows={9} />}
      {stats.isError && !s && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
      {s && (
        <div className="kpi-grid">
          <KpiTile label="Equity (USD)" value={fmtMoney(s.equity, 2)} sub={<span className="muted">initial {fmtMoney(s.initialEquity, 0)}</span>} />
          <KpiTile label="Net PnL (USD)" value={fmtPnl(net)} tone={pnlClass(net) as 'gain' | 'loss' | 'neutral'} sub={<span className="muted">{s.initialEquity ? `${fmtPct((net / s.initialEquity) * 100, 1, true)} of purse` : ''} · after fees</span>} />
          <KpiTile label="Closed PnL (USD)" value={fmtPnl(s.closedPnl)} tone={pnlClass(s.closedPnl) as 'gain' | 'loss' | 'neutral'} sub={<span className="muted">fees {fmtMoney(s.closedFees)} · {fmtInt(s.trades)} trades, the journal</span>} />
          <KpiTile label="Open PnL (USD)" value={fmtPnl(s.openPnl)} tone={pnlClass(s.openPnl) as 'gain' | 'loss' | 'neutral'} hint="Open positions: banked legs, fees and mark" sub={day ? <span className={pnlClass(day.pnl)}>today {fmtPnl(day.pnl)} since 00:00 UTC</span> : <span className="muted">{s.openPositions} open</span>} />
          <KpiTile label="Win rate" value={fmtPct(s.winRatePct)} sub={<span className="muted">{s.wins}W / {s.losses}L</span>} />
          <KpiTile label="Profit factor" value={fmtProfitFactor(s.profitFactor)} tone={s.profitFactor >= 1 ? 'gain' : 'loss'} />
          <KpiTile label="Expectancy" value={fmtR(expectancy)} tone={expectancy == null ? 'neutral' : expectancy >= 0 ? 'gain' : 'loss'} hint="Average R per trade, weighted by trade count" />
          <KpiTile label="Drawdown" value={`−${fmtPct(s.drawdownPct)}`} tone={s.drawdownPct > 0 ? 'loss' : 'neutral'} hint="From the equity peak since the reset, open positions included; the Risk page and the alerts use this same number" sub={<span className="muted">worst −{fmtPct(s.maxDrawdownPct)} · peak {fmtMoney(s.peakEquity, 0)}</span>} />
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
        <AlertsStatusLine />
        <SystemPanel />
        <MarketsTodayPanel />
        <Panel title="Scanner fleet">
          <QueryState {...scanners} data={scanners.data} empty="No scanners loaded." hint="Drop .pine files into the scanners folder and restart the server." onRetry={() => scanners.refetch()}>
            {(d) => {
              const ok = d.filter((x) => x.status === 'ok').length
              const en = d.filter((x) => x.enabled).length
              const err = d.filter((x) => x.lastRunError).length
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


/** Which pairs the fleet may trade now, and why the others are out — the market-level gate of decision 56. */
function MarketsTodayPanel() {
  const q = useMarketsToday()
  const refresh = useRefreshMarketsToday()
  const d = q.data
  if (!d) return null
  if (!d.enabled) return (
    <Panel title="Markets today" right={<span className="muted small">gate off — every fleet market is allowed</span>}>
      <p className="muted small">Turn on <span className="mono">risk.marketGate</span> to trade only markets whose book is cheap enough to cross, volatile enough to pay that round trip, and not losing recently.</p>
    </Panel>
  )
  const tracked = d.markets.filter((m) => m.tracked !== false), elsewhere = d.markets.filter((m) => m.tracked === false)
  const allowed = tracked.filter((m) => m.allowed), blocked = tracked.filter((m) => !m.allowed)
  const liquidElsewhere = elsewhere.filter((m) => m.allowed), outElsewhere = elsewhere.filter((m) => !m.allowed)
  const tip = (m: MarketVerdict) => [m.bookCostPct != null ? `book ${m.bookCostPct.toFixed(3)}% round trip (spread ${(m.spreadPct ?? 0).toFixed(3)}%)` : 'book not read', m.atrPct != null ? `15m ATR ${m.atrPct.toFixed(2)}%` : 'no candles — not scanned', m.turnoverUsd != null ? `$${(m.turnoverUsd / 1e6).toFixed(2)}M 24h` : '', `${m.trades} trades${m.pf != null ? ` PF ${m.pf.toFixed(2)}` : ''} in 14d`].filter(Boolean).join(' · ')
  return (
    <Panel title={`Markets today · ${allowed.length} of ${tracked.length} scanned allowed, ${blocked.length} out`} right={<div className="row gap"><span className="muted small">{d.at ? `judged ${new Date(d.at).toISOString().slice(11, 16)} UTC` : ''}</span><button className="btn btn-xs" onClick={() => refresh.mutate()} disabled={refresh.isPending}>{refresh.isPending ? 'Judging…' : 'Re-judge'}</button></div>}>
      <div className="chips">
        {allowed.map((m) => <Pill key={m.symbol} tone="ok" title={tip(m)}>{m.symbol.replace(/USD$/, '')}</Pill>)}
      </div>
      {elsewhere.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          <b>Liquid on Delta but not scanned</b> ({liquidElsewhere.length}{outElsewhere.length ? `, ${outElsewhere.length} more out` : ''}) — the daily hunt picks from these:{' '}
          {liquidElsewhere.map((m) => <span key={m.symbol} className="mono" title={tip(m)}>{m.symbol.replace(/USD$/, '')} </span>)}
        </p>
      )}
      {blocked.length > 0 && (
        <table className="table small" style={{ marginTop: 8 }}>
          <tbody>
            {[...blocked, ...outElsewhere].map((m) => (
              <tr key={m.symbol} className={m.tracked === false ? 'muted' : ''}><td className="mono">{m.symbol}</td><td className="muted">{m.reasons.join(' · ')}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}


/** Whether anyone would hear a halt: the alert channel, what it last sent, and what last failed. */
function AlertsStatusLine() {
  const ops = useOps()
  const a = ops.data?.alerts
  if (!a) return null
  const ok = Boolean(a.configured)
  return (
    <div className={`banner ${ok ? '' : 'banner-warn'} small`} role="note">
      <b>Alerts:</b> {ok ? `${a.channel ?? 'channel'} configured · ${a.sent ?? 0} sent` : 'not configured — a halt, a stranded position or a hunt result reaches nobody until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in the service environment'}
      {a.lastError ? <span className="text-danger"> · last error: {a.lastError}</span> : null}
      {a.recent?.length ? <span className="muted"> · last: {a.recent[a.recent.length - 1].text.slice(0, 80)}</span> : null}
    </div>
  )
}

/** The process over the last day, minute by minute: the graphs that would have shown the overnight kills coming (decision 80). */
function SystemPanel() {
  const h = useOpsMetricsHistory(24)
  const rows = h.data?.rows ?? []
  const mb = (v: number) => `${Math.round(v / 1048576)} MB`
  const row = (label: string, values: Array<number | null>, format?: (v: number) => string, hint?: string) => (
    <div className="kv-row" title={hint}>
      <span className="muted small" style={{ minWidth: 120, display: 'inline-block' }}>{label}</span>
      <Sparkline values={values} format={format} />
    </div>
  )
  return (
    <Panel title="System, last 24 h" right={<span className="muted small">{rows.length ? `${rows.length} samples` : ''}</span>}>
      {h.isLoading && !rows.length ? <Loading kind="kpi" rows={4} /> : null}
      {!h.isLoading && !rows.length ? <p className="muted small">No samples yet: the monitor writes one a minute.</p> : null}
      {rows.length > 0 && (
        <div className="kv-list">
          {row('Resident memory', rows.map((r) => r.rss), mb, 'The whole process, worker heaps included; the kernel kills it at the cgroup limit')}
          {row('Memory of limit', rows.map((r) => r.rssPct), (v) => `${v.toFixed(0)}%`, 'The monitor recycles workers at 75%')}
          {row('Queue depth', rows.map((r) => r.queued), undefined, 'Scanner jobs waiting for a worker')}
          {row('Runs per hour', rows.map((r) => r.runsH), undefined, 'Scanner cells run in the trailing hour (one row per cell, so a lower bound)')}
          {row('Signals per hour', rows.map((r) => r.signalsH))}
          {row('Close lag (s)', rows.map((r) => r.closeLagS), (v) => v.toFixed(1), 'Median seconds between a bar ending and its close being announced')}
          {row('Open positions', rows.map((r) => r.openPositions))}
        </div>
      )}
    </Panel>
  )
}

/** The one sentence the product owes its operator (decision 87): is there an edge yet, on which book, with what confidence. */
function EdgeVerdictLine() {
  const l = useLearning()
  const d = l.data
  if (!d) return null
  const word = (b: { lb90: number | null; ub90: number | null }) => (b.lb90 !== null && b.lb90 > 0 ? 'paying' : b.ub90 !== null && b.ub90 < 0 ? 'failing' : 'undecided')
  const tone = (w: string) => (w === 'paying' ? 'gain' : w === 'failing' ? 'loss' : 'muted')
  const book = (name: string, b: typeof d.live) => (
    <span>
      <b>{name}</b>: <b className={tone(word(b))}>{word(b)}</b> · {b.trades} trades · {b.avgR >= 0 ? '+' : ''}{b.avgR.toFixed(2)}R a trade
      {b.lb90 !== null && b.ub90 !== null ? <span className="muted"> (90% band {b.lb90 >= 0 ? '+' : ''}{b.lb90.toFixed(2)} to {b.ub90 >= 0 ? '+' : ''}{b.ub90.toFixed(2)})</span> : null}
      {b.costShare !== null ? <span className="muted"> · costs {Math.round(b.costShare * 100)}% of risk</span> : null}
    </span>
  )
  return (
    <div className={`banner small ${word(d.live) === 'failing' ? 'banner-warn' : ''}`} role="note" title="Paying: the 90% confidence band of R per trade is above zero. Failing: it is below zero. Undecided: it straddles zero, which is what a small sample looks like.">
      Edge: {book('Account', d.live)}{d.current ? <> · {book('Under current settings', d.current)}</> : null} · {book('Shadow', d.shadow)}
    </div>
  )
}
