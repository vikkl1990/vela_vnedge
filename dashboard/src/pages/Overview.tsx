import type { MarketVerdict } from '../api/types'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useEquity, useHealth, useLearning, useMarketsToday, useOps, useOpsMetricsHistory, usePositions, useRefreshMarketsToday, useRisk, useScannerIndex, useSignalActivity, useSignals, useStats } from '../api/queries'
import { AlertsFeed } from '../components/AlertsFeed'
import { EquityChart, Sparkline } from '../components/charts'
import { ScannerPnlBoard, type ScannerPnlRow } from '../components/ScannerPnlBoard'
import { PositionsTable } from '../components/PositionsTable'
import { TickerTape } from '../components/TickerTape'
import { ErrorState, KpiTile, Loading, PageTitle, Panel, Pill, QueryState } from '../components/ui'
import { fmtInt, fmtMoney, fmtProfitFactor, fmtPct, fmtPnl, fmtR, pnlClass } from '../lib/format'
import { RunHealthPanel } from '../components/RunHealthPanel'

export function Overview() {
  const stats = useStats()
  const equity = useEquity()
  const scanners = useScannerIndex()
  const signals = useSignals({ limit: 15 })
  const positions = usePositions()
  const risk = useRisk()

  const s = stats.data
  const pnlRows = useMemo<ScannerPnlRow[]>(() => {
    if (!s?.byScanner) return []
    const names = new Map((scanners.data ?? []).map((x) => [x.id, x.name]))
    return Object.entries(s.byScanner)
      .filter(([, v]) => v && (v.trades > 0 || v.pnl !== 0))
      .map(([id, v]) => ({ id, name: names.get(id) ?? id, pnl: v.pnl, trades: v.trades, winRatePct: v.winRatePct, avgR: v.avgR }))
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
  const markets = useMarketsToday()
  const mt = markets.data
  const tracked = (mt?.markets ?? []).filter((m) => m.tracked !== false)
  const allowedN = tracked.filter((m) => m.allowed).length
  // Stored initial stop-risk budgets; current stops may already have moved.
  const openRisk = (positions.data ?? []).reduce((a, p) => a + (p.riskAmount ?? 0), 0)
  const openRiskPct = s && s.equity > 0 ? (openRisk / s.equity) * 100 : 0
  const activity = useSignalActivity()
  const signals24 = activity.data?.entries

  return (
    <div className="page">
      <TickerTape />
      <PageTitle pre="The market's noise," accent="filtered" post="to conviction." sub={scanners.data ? `Paper account on Delta India data; fills and P&L simulated. ${visibleScanners} scripts in the visible library, ${(scanners.data ?? []).filter(s => s.enabled).length} account-enabled. The shadow book and backtests never touch it.` : 'Paper account on Delta India data. The shadow book and backtests never touch it.'} />
      <AttentionBanner />

      {stats.isLoading && !s && <Loading kind="kpi" rows={3} />}
      {stats.isError && !s && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
      {s && (
        <>
          <div className="hero-grid">
            <KpiTile
              label="Equity (USD)"
              value={fmtMoney(s.equity, 2)}
              tone={day ? (pnlClass(day.pnl) as 'gain' | 'loss' | 'neutral') : 'neutral'}
              sub={<span>{day ? <span className={pnlClass(day.pnl)}>{fmtPnl(day.pnl)} today</span> : null}<span className="muted"> · net {fmtPnl(net)} on {fmtMoney(s.initialEquity, 0)} · drawdown −{fmtPct(s.drawdownPct)} from the peak</span></span>}
            />
            <KpiTile
              label="Open PnL (USD)"
              value={fmtPnl(s.openPnl)}
              tone={pnlClass(s.openPnl) as 'gain' | 'loss' | 'neutral'}
              hint="Open positions: banked legs, fees and mark"
              sub={<span className="muted">{s.openPositions} open · {fmtPct(openRiskPct)} of equity in initial stop-risk budgets{s.openFees ? ` · fees so far ${fmtMoney(s.openFees)}` : ''}</span>}
            />
            <KpiTile
              label="Markets the gate allows today"
              value={mt ? (mt.enabled ? `${allowedN} of ${tracked.length}` : 'gate off') : '–'}
              tone={mt?.enabled && allowedN === 0 ? 'loss' : 'neutral'}
              hint="The market gate's verdict: turnover, book cost and quote, judged every hour"
              sub={<span className="muted"><span title={activity.data ? `Journal count as of ${new Date(activity.data.at).toISOString()}` : 'Loading journal count'}>{signals24 ?? '–'} entry signals in 24 h</span> · <Link to="/gates">every gate</Link></span>}
            />
          </div>
          <EdgeVerdictLine />
          <div className="stat-strip" role="list" aria-label="Secondary figures">
            <span role="listitem"><span className="stat-k">Closed</span> <span className={`mono ${pnlClass(s.closedPnl)}`}>{fmtPnl(s.closedPnl)}</span> <span className="muted">fees {fmtMoney(s.closedFees)}</span></span>
            <span role="listitem"><span className="stat-k">Trades</span> <span className="mono">{fmtInt(s.trades)}</span></span>
            <span role="listitem"><span className="stat-k">Win</span> <span className="mono">{fmtPct(s.winRatePct)}</span> <span className="muted">{s.wins}W / {s.losses}L</span></span>
            <span role="listitem"><span className="stat-k">PF</span> <span className={`mono ${s.profitFactor >= 1 ? 'gain' : 'loss'}`}>{fmtProfitFactor(s.profitFactor)}</span></span>
            <span role="listitem" title="Average R per trade, weighted by trade count"><span className="stat-k">Expectancy</span> <span className={`mono ${expectancy == null ? '' : expectancy >= 0 ? 'gain' : 'loss'}`}>{fmtR(expectancy)}</span></span>
            <span role="listitem" title="From the equity peak since the reset, open positions included"><span className="stat-k">Worst drawdown</span> <span className="mono loss">−{fmtPct(s.maxDrawdownPct)}</span> <span className="muted">peak {fmtMoney(s.peakEquity, 0)}</span></span>
          </div>
        </>
      )}

      <Panel
        title="Open positions"
        right={<div className="row gap"><Link to="/trades?period=today&reason=sl" className="btn btn-xs">Today's stops</Link><Link to="/trades" className="btn btn-xs">Open trade journal →</Link></div>}
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
        <Panel title="PnL by scanner" right={<span className="muted small">since the reset · click a row for the scanner</span>}>
          {stats.isLoading && !s ? <Loading kind="chart" height={240} /> : <ScannerPnlBoard rows={pnlRows} />}
        </Panel>
        <AlertsStatusLine />
        <SystemPanel />
        <RunHealthPanel />
        <MarketsTodayPanel />
        <Panel title="Scanner fleet">
          <QueryState {...scanners} data={scanners.data} empty="No scanners loaded." hint="Drop .pine files into the scanners folder and restart the server." onRetry={() => scanners.refetch()}>
            {(d) => {
              const ok = d.filter((x) => !x.hidden && x.status === 'ok').length
              const en = d.filter((x) => x.enabled).length
              const err = d.filter((x) => x.enabled && !x.hidden && x.lastRunError).length
              const removed = d.filter((x) => x.hidden).length
              return (
                <div className="fleet">
                  <div className="fleet-row" title="The same count as the Scanners page: loaded scripts minus the removed ones">
                    <span>In the list</span>
                    <span className="mono">{d.length - removed}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Removed</span>
                    <span className="mono muted">{removed}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Runnable in visible library</span>
                    <span className="mono gain">{ok}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Account-enabled scanners</span>
                    <span className="mono accent">{en}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Incompatible in visible library</span>
                    <span className="mono loss">{d.filter((x) => !x.hidden && x.status === 'incompatible').length}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Unavailable in visible library</span>
                    <span className="mono warn">{d.filter((x) => !x.hidden && x.status === 'unavailable').length}</span>
                  </div>
                  <div className="fleet-row">
                    <span>Enabled scanners with last-run errors</span>
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
    <Panel title={`${d.freshDepth?'Cached market screen':'Markets today'} · ${allowed.length} of ${tracked.length} scanned allowed, ${blocked.length} out`} right={<div className="row gap"><span className="muted small">{d.at ? `judged ${new Date(d.at).toISOString().slice(11, 16)} UTC` : ''}</span><button className="btn btn-xs" onClick={() => refresh.mutate()} disabled={refresh.isPending}>{refresh.isPending ? 'Judging…' : 'Re-judge'}</button></div>}>
      {d.freshDepth&&<p className="muted small">These are cached screening costs. Every entry and pending fill is checked again at its actual contract quantity using fresh depth; a cached cost result is not entry permission.</p>}
      <div className="chips">
        {allowed.map((m) => <Pill key={m.symbol} tone="ok" title={tip(m)}>{m.symbol.replace(/USD$/, '')}</Pill>)}
      </div>
      {elsewhere.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          <b>Liquid on Delta but not scanned</b> ({liquidElsewhere.length}{outElsewhere.length ? `, ${outElsewhere.length} more out` : ''}) — the daily hunt picks from these:{' '}
          {liquidElsewhere.map((m) => <span key={m.symbol} className="mono" title={tip(m)}>{m.symbol.replace(/USD$/, '')} </span>)}
        </p>
      )}
      {blocked.length + outElsewhere.length > 0 && (
        <div className="markets-out" style={{ marginTop: 8 }}>
          <table className="table small">
            <tbody>
              {[...blocked, ...outElsewhere].map((m) => (
                <tr key={m.symbol} className={m.tracked === false ? 'muted' : ''}><td className="mono">{m.symbol}</td><td className="muted">{m.reasons.join(' · ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}


/** Faults that outrank every number on the page: a dead daily job, a scanner in the account that is not running. Nothing renders when there are none. */
function AttentionBanner() {
  const h = useHealth()
  const items = h.data?.attention ?? []
  if (!items.length) return null
  return (
    <div className="banner banner-warn attention attention-row small" role="alert">
      <span className="attention-head"><b>Needs attention</b> <span className="muted">{items.length}</span></span>
      <ul>
        {items.map((it) => (
          <li key={it.key}>
            {it.text} · <Link to={it.href}>open</Link>
          </li>
        ))}
      </ul>
      <Link to="/decisions" className="btn btn-xs attention-all">Decisions →</Link>
    </div>
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
      {/* decision 196: a failed request is an error, not an empty history */}
      {h.isError && !rows.length ? <ErrorState error={h.error as Error} label="System history unavailable" onRetry={() => h.refetch()} /> : null}
      {!h.isLoading && !h.isError && !rows.length ? <p className="muted small">No samples yet: the monitor writes one a minute.</p> : null}
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
      <b>{name}</b>: <b className={tone(word(b))}>{word(b)}</b> · {b.trades} trades · {fmtR(b.avgR)} a trade
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
