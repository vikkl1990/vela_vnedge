import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useEquity,
  useHealth,
  useLearning,
  useMarketsToday,
  useOps,
  useOpsMetricsHistory,
  usePositions,
  useRefreshMarketsToday,
  useRisk,
  useScannerIndex,
  useSignalActivity,
  useSignals,
  useStats,
} from '../api/queries'
import { REFRESH } from '../api/refreshPolicy'
import type { MarketVerdict } from '../api/types'
import { AlertsFeed } from '../components/AlertsFeed'
import { EquityChart, Sparkline } from '../components/charts'
import {
  AccountBadge,
  Callout,
  ErrorState,
  Loading,
  PageHeader,
  Pill,
  QueryState,
  Section,
  Stat,
  StatGrid,
  TabPanel,
  Tabs,
} from '../components/kit'
import { PaperPositions } from '../components/PaperPositions'
import { ScannerPnlBoard, type ScannerPnlRow } from '../components/ScannerPnlBoard'
import { TickerTape } from '../components/TickerTape'

import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import {
  BookCards,
  LiveStatusStrip,
  MlAdvisor,
  PromotionLadder,
  RealityGap,
} from '../components/home/HomeBooks'
import { AssetClassBreakdown } from '../components/AssetClassBreakdown'
import { classRows } from '../lib/assetClass'
import { RunHealthPanel } from '../components/RunHealthPanel'
import { fmtInt, fmtMoney, fmtPct, fmtPnl, fmtProfitFactor, fmtR, pnlClass } from '../lib/format'
import { useNow } from '../lib/useNow'
import '../styles/pages/home.css'

/** The last seven UTC days by asset class: which kinds of markets the trades and the money come from. */
function AssetClassHome() {
  const now = useNow(3_600_000)
  const from = Math.floor(now / 3_600_000) * 3_600_000 - 7 * 86_400_000
  const q = useQuery({
    queryKey: ['analytics', 'performance', { from, view: 'home-classes' }],
    queryFn: () => api.performance({ from }),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  })
  return (
    <Section
      variant="panel"
      title="By asset class, last 7 days"
      actions={
        <Link to="/analytics?period=7d" className="btn btn-xs">
          Analytics →
        </Link>
      }
    >
      {q.data ? (
        <div className="home-split">
          <div>
            <b className="small">Paper account</b>
            <AssetClassBreakdown rows={classRows(q.data.byGroup, 'paper')} book="paper" />
          </div>
          <div>
            <b className="small">Shadow research</b>
            <AssetClassBreakdown rows={classRows(q.data.byGroup, 'shadow')} book="shadow" />
          </div>
        </div>
      ) : q.isError ? (
        <p className="muted small">The class breakdown could not load. It retries on its own.</p>
      ) : (
        <p className="muted small">Loading…</p>
      )}
    </Section>
  )
}

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
      .map(([id, v]) => ({
        id,
        name: names.get(id) ?? id,
        pnl: v.pnl,
        trades: v.trades,
        winRatePct: v.winRatePct,
        avgR: v.avgR,
      }))
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

  const eqSpark = useMemo(() => (equity.data ?? []).slice(-120).map((p) => p.equity), [equity.data])
  const [tab, setTab] = useState<'account' | 'scanners' | 'system' | 'markets'>('account')
  const health = useHealth()

  return (
    <div className="page overview-page">
      <PageHeader
        title="Home"
        subtitle="Four books, one view. Every number says which book it comes from."
        meta={health.data ? <AccountBadge mode={health.data.mode} /> : undefined}
        actions={
          <Link to="/trades" className="btn btn-sm">
            Trade journal →
          </Link>
        }
      />
      <TickerTape />
      <LiveStatusStrip />
      <BookCards />
      <div className="home-split">
        <PromotionLadder />
        <RealityGap />
      </div>
      <div className="home-split">
        <NeedsYou />
        <MlAdvisor />
      </div>
      <AssetClassHome />

      <Section
        variant="panel"
        title={<span>Open positions, paper</span>}
        actions={
          <div className="row gap">
            <Link to="/trades?period=today&reason=sl" className="btn btn-xs">
              Today's stops
            </Link>
            <Link to="/trades" className="btn btn-xs">
              Open trade journal →
            </Link>
          </div>
        }
        pad={false}
      >
        <PaperPositions query={positions} compact />
      </Section>

      <div className="grid-2-1">
        <Section
          variant="panel"
          title="Equity curve"
          actions={<span className="muted small mono">USD · simulated equity</span>}
        >
          <QueryState
            {...equity}
            data={equity.data}
            empty="No equity points yet."
            hint="The curve starts with the first fill."
            skeleton="chart"
            skeletonHeight={240}
            onRetry={() => equity.refetch()}
          >
            {(d) => <EquityChart data={d} height={240} baseline={s?.initialEquity} />}
          </QueryState>
        </Section>
        <Section
          variant="panel"
          title="Live signals"
          actions={
            <Link to="/signals" className="btn btn-xs">
              All signals →
            </Link>
          }
          pad={false}
        >
          <QueryState
            {...signals}
            data={signals.data}
            empty="No signals yet."
            hint="No recorded events yet. Check scheduled pairs and signal conditions on Scanners."
            skeleton="cards"
            skeletonRows={4}
            onRetry={() => signals.refetch()}
          >
            {(d) => <AlertsFeed signals={d} limit={15} />}
          </QueryState>
        </Section>
      </div>

      {/* the long tail of the old page, one tab at a time instead of one long scroll */}
      <Tabs
        idPrefix="ov"
        label="More about the paper account"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'account', label: 'Paper account' },
          { id: 'scanners', label: 'By scanner', count: pnlRows.length || undefined },
          { id: 'system', label: 'System' },
          {
            id: 'markets',
            label: 'Markets today',
            count: mt?.enabled ? `${allowedN}/${tracked.length}` : undefined,
          },
        ]}
      />
      <TabPanel idPrefix="ov" id="account" value={tab}>
        <div className="stack">
          {stats.isLoading && !s && <Loading kind="kpi" rows={3} />}
          {stats.isError && !s && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
          {s && (
            <>
              <StatGrid min={250}>
                <Stat
                  label="Equity (USD)"
                  value={fmtMoney(s.equity, 2)}
                  tone={day ? (day.pnl > 0 ? 'gain' : day.pnl < 0 ? 'loss' : undefined) : undefined}
                  spark={eqSpark}
                  sub={
                    <span>
                      {day ? (
                        <span className={pnlClass(day.pnl)}>{fmtPnl(day.pnl)} since 00:00 UTC</span>
                      ) : null}
                      <span>
                        {' '}
                        · net {fmtPnl(net)} on {fmtMoney(s.initialEquity, 0)} · {fmtPct(s.drawdownPct)} below
                        the peak
                      </span>
                    </span>
                  }
                />
                <Stat
                  label="Open P&L (USD)"
                  value={fmtPnl(s.openPnl)}
                  tone={s.openPnl > 0 ? 'gain' : s.openPnl < 0 ? 'loss' : undefined}
                  title="Open positions: banked legs, fees and mark"
                  sub={`${s.openPositions} open${s.openFees ? ` · fees so far ${fmtMoney(s.openFees)}` : ''}`}
                />
                <Stat
                  label="Open risk"
                  value={fmtPct(openRiskPct)}
                  tone={openRiskPct >= 8 ? 'warn' : undefined}
                  title="Stored initial stop-risk budgets of open positions; current stops may already have moved"
                  sub={`of equity in initial stop-risk budgets across ${s.openPositions} position${s.openPositions === 1 ? '' : 's'}`}
                />
                <Stat
                  label="Markets the gate allows"
                  value={mt ? (mt.enabled ? `${allowedN} of ${tracked.length}` : 'gate off') : '–'}
                  tone={mt?.enabled && allowedN === 0 ? 'loss' : undefined}
                  title="The market gate's verdict: turnover, book cost and quote, judged every hour"
                  sub={
                    <span>
                      <span
                        title={
                          activity.data
                            ? `Journal count as of ${new Date(activity.data.at).toISOString()}`
                            : 'Loading journal count'
                        }
                      >
                        {signals24 ?? '–'} signals reached admission in 24 h
                      </span>{' '}
                      · <Link to="/signals">{activity.data?.copyHeld ?? '–'} held</Link> ·{' '}
                      <Link to="/gates">every gate</Link>
                    </span>
                  }
                />
              </StatGrid>
              <EdgeVerdictLine />
              <div className="stat-strip" role="list" aria-label="Secondary figures">
                <span role="listitem">
                  <span className="stat-k">Closed</span>{' '}
                  <span className={`mono ${pnlClass(s.closedPnl)}`}>{fmtPnl(s.closedPnl)}</span>{' '}
                  <span className="muted">fees {fmtMoney(s.closedFees)}</span>
                </span>
                <span role="listitem">
                  <span className="stat-k">Trades</span> <span className="mono">{fmtInt(s.trades)}</span>
                </span>
                <span role="listitem">
                  <span className="stat-k">Win</span> <span className="mono">{fmtPct(s.winRatePct)}</span>{' '}
                  <span className="muted">
                    {s.wins}W / {s.losses}L
                  </span>
                </span>
                <span role="listitem">
                  <span className="stat-k">PF</span>{' '}
                  <span className={`mono ${s.profitFactor >= 1 ? 'gain' : 'loss'}`}>
                    {fmtProfitFactor(s.profitFactor)}
                  </span>
                </span>
                <span role="listitem" title="Average R per trade, weighted by trade count">
                  <span className="stat-k">Expectancy</span>{' '}
                  <span className={`mono ${expectancy == null ? '' : expectancy >= 0 ? 'gain' : 'loss'}`}>
                    {fmtR(expectancy)}
                  </span>
                </span>
                <span role="listitem" title="From the equity peak since the reset, open positions included">
                  <span className="stat-k">Worst drawdown</span>{' '}
                  <span className="mono loss">−{fmtPct(s.maxDrawdownPct)}</span>{' '}
                  <span className="muted">peak {fmtMoney(s.peakEquity, 0)}</span>
                </span>
              </div>
            </>
          )}
        </div>
      </TabPanel>
      <TabPanel idPrefix="ov" id="scanners" value={tab}>
        <div className="grid-2-1">
          <Section
            variant="panel"
            title="PnL by scanner"
            actions={<span className="muted small">since the reset · click a row for the scanner</span>}
          >
            {stats.isLoading && !s ? (
              <Loading kind="chart" height={240} />
            ) : (
              <ScannerPnlBoard rows={pnlRows} />
            )}
          </Section>
          <FleetPanel />
        </div>
      </TabPanel>
      <TabPanel idPrefix="ov" id="system" value={tab}>
        <div className="grid-2">
          <SystemPanel />
          <div className="stack">
            <AlertsStatusLine />
            <RunHealthPanel />
          </div>
        </div>
      </TabPanel>
      <TabPanel idPrefix="ov" id="markets" value={tab}>
        <MarketsTodayPanel />
      </TabPanel>
    </div>
  )
}

/** Scanner counts at a glance, with the way into the Scanners page. */
function FleetPanel() {
  const scanners = useScannerIndex()
  return (
    <Section variant="panel" title="Scanner fleet">
      <QueryState
        {...scanners}
        data={scanners.data}
        empty="No scanners loaded."
        hint="Drop .pine files into the scanners folder and restart the server."
        onRetry={() => scanners.refetch()}
      >
        {(d) => {
          const ok = d.filter((x) => !x.hidden && x.status === 'ok').length
          const en = d.filter((x) => x.enabled).length
          const err = d.filter((x) => x.enabled && !x.hidden && x.lastRunError).length
          const removed = d.filter((x) => x.hidden).length
          const rows: Array<[string, number, string, string?]> = [
            [
              'In the list',
              d.length - removed,
              '',
              'The same count as the Scanners page: loaded scripts minus the removed ones',
            ],
            ['Removed', removed, 'muted'],
            ['Runnable in the visible library', ok, 'gain'],
            ['Enabled on the account', en, 'accent'],
            [
              'Incompatible in the visible library',
              d.filter((x) => !x.hidden && x.status === 'incompatible').length,
              'loss',
            ],
            [
              'Unavailable in the visible library',
              d.filter((x) => !x.hidden && x.status === 'unavailable').length,
              'warn',
            ],
            ['Enabled, last run failed', err, err ? 'loss' : ''],
          ]
          return (
            <div className="fleet">
              {rows.map(([label, n, tone, tip]) => (
                <div className="fleet-row" key={label} title={tip}>
                  <span>{label}</span>
                  <span className={`mono ${tone}`}>{n}</span>
                </div>
              ))}
              <Link to="/scanners" className="btn btn-sm mt">
                Manage scanners
              </Link>
            </div>
          )
        }}
      </QueryState>
    </Section>
  )
}

/** Everything that waits for the operator, in one place: faults, proposals, a silent alert channel. Nothing renders when there is none. */
function NeedsYou() {
  const h = useHealth()
  const ops = useOps()
  const inc = useQuery({
    queryKey: ['incubator'],
    queryFn: api.incubator,
    refetchInterval: REFRESH.slow,
    staleTime: 20_000,
  })
  const items: Array<{ key: string; text: string; to: string; cta: string }> = (h.data?.attention ?? []).map(
    (it) => ({ key: it.key, text: it.text, to: it.href, cta: 'Open' }),
  )
  const proposals =
    inc.data?.pairs.filter((p) => p.stage === 'proposed' || p.stage === 'demote_proposed').length ?? 0
  if (proposals > 0)
    items.push({
      key: 'proposals',
      text: `${proposals} proposal${proposals === 1 ? ' is' : 's are'} waiting for a decision`,
      to: '/decisions',
      cta: 'Decide',
    })
  if (ops.data?.alerts && !ops.data.alerts.configured)
    items.push({
      key: 'alerts',
      text: 'The alert channel is not configured: a halt or a stranded position reaches nobody',
      to: '/settings',
      cta: 'Set up',
    })
  if (!items.length) return null
  return (
    <section className="needs" aria-label="Needs you">
      <div className="needs-head">
        <h2>Needs you</h2>
        <span className="mono needs-count">{items.length}</span>
      </div>
      <ul className="needs-list">
        {items.map((it) => (
          <li key={it.key}>
            <span className="needs-text">{it.text}</span>
            <Link to={it.to} className="btn btn-xs">
              {it.cta} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Which pairs the fleet may trade now, and why the others are out — the market-level gate of decision 56. */
function MarketsTodayPanel() {
  const q = useMarketsToday()
  const refresh = useRefreshMarketsToday()
  const d = q.data
  if (!d) return null
  if (!d.enabled)
    return (
      <Section
        variant="panel"
        title="Markets today"
        actions={<span className="muted small">gate off — every fleet market is allowed</span>}
      >
        <p className="muted small">
          Turn on <span className="mono">risk.marketGate</span> to trade only markets whose book is cheap
          enough to cross, volatile enough to pay that round trip, and not losing recently.
        </p>
      </Section>
    )
  const tracked = d.markets.filter((m) => m.tracked !== false),
    elsewhere = d.markets.filter((m) => m.tracked === false)
  const allowed = tracked.filter((m) => m.allowed),
    blocked = tracked.filter((m) => !m.allowed)
  const liquidElsewhere = elsewhere.filter((m) => m.allowed),
    outElsewhere = elsewhere.filter((m) => !m.allowed)
  const tip = (m: MarketVerdict) =>
    [
      m.bookCostPct != null
        ? `book ${m.bookCostPct.toFixed(3)}% round trip (spread ${(m.spreadPct ?? 0).toFixed(3)}%)`
        : 'book not read',
      m.atrPct != null ? `15m ATR ${m.atrPct.toFixed(2)}%` : 'no candles — not scanned',
      m.turnoverUsd != null ? `$${(m.turnoverUsd / 1e6).toFixed(2)}M 24h` : '',
      `${m.trades} trades${m.pf != null ? ` PF ${m.pf.toFixed(2)}` : ''} in 14d`,
    ]
      .filter(Boolean)
      .join(' · ')
  return (
    <Section
      variant="panel"
      title={`${d.freshDepth ? 'Cached market screen' : 'Markets today'} · ${allowed.length} of ${tracked.length} scanned allowed, ${blocked.length} out`}
      actions={
        <div className="row gap">
          <span className="muted small">
            {d.at ? `judged ${new Date(d.at).toISOString().slice(11, 16)} UTC` : ''}
          </span>
          <button className="btn btn-xs" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? 'Judging…' : 'Re-judge'}
          </button>
        </div>
      }
    >
      {d.freshDepth && (
        <p className="muted small">
          These are cached screening costs. Every entry and pending fill is checked again at its actual
          contract quantity using fresh depth; a cached cost result is not entry permission.
        </p>
      )}
      <div className="chips">
        {allowed.map((m) => (
          <Pill key={m.symbol} tone="ok" title={tip(m)}>
            {m.symbol.replace(/USD$/, '')}
          </Pill>
        ))}
      </div>
      {elsewhere.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          <b>Liquid on Delta but not scanned</b> ({liquidElsewhere.length}
          {outElsewhere.length ? `, ${outElsewhere.length} more out` : ''}) — the daily hunt picks from these:{' '}
          {liquidElsewhere.map((m) => (
            <span key={m.symbol} className="mono" title={tip(m)}>
              {m.symbol.replace(/USD$/, '')}{' '}
            </span>
          ))}
        </p>
      )}
      {blocked.length + outElsewhere.length > 0 && (
        <div className="markets-out" style={{ marginTop: 8 }}>
          <table className="table small">
            <tbody>
              {[...blocked, ...outElsewhere].map((m) => (
                <tr key={m.symbol} className={m.tracked === false ? 'muted' : ''}>
                  <td className="mono">{m.symbol}</td>
                  <td className="muted">{m.reasons.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
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
      <b>Alerts:</b>{' '}
      {ok
        ? `${a.channel ?? 'channel'} configured · ${a.sent ?? 0} sent`
        : 'not configured — connect Telegram in Settings so halts, stranded positions and hunt results reach you'}
      {a.lastError ? <span className="text-danger"> · last error: {a.lastError}</span> : null}
      {a.recent?.length ? (
        <span className="muted"> · last: {a.recent[a.recent.length - 1].text.slice(0, 80)}</span>
      ) : null}
    </div>
  )
}

/** The process over the last day, minute by minute: the graphs that would have shown the overnight kills coming (decision 80). */
function SystemPanel() {
  const h = useOpsMetricsHistory(24)
  const rows = h.data?.rows ?? []
  const mb = (v: number) => `${Math.round(v / 1048576)} MB`
  const row = (
    label: string,
    values: Array<number | null>,
    format?: (v: number) => string,
    hint?: string,
  ) => (
    <div className="kv-row" title={hint}>
      <span className="muted small" style={{ minWidth: 120, display: 'inline-block' }}>
        {label}
      </span>
      <Sparkline values={values} format={format} />
    </div>
  )
  return (
    <Section
      variant="panel"
      title="System, last 24 h"
      actions={<span className="muted small">{rows.length ? `${rows.length} samples` : ''}</span>}
    >
      {h.isLoading && !rows.length ? <Loading kind="kpi" rows={4} /> : null}
      {/* decision 196: a failed request is an error, not an empty history */}
      {h.isError && !rows.length ? (
        <ErrorState error={h.error as Error} label="System history unavailable" onRetry={() => h.refetch()} />
      ) : null}
      {!h.isLoading && !h.isError && !rows.length ? (
        <p className="muted small">No samples yet: the monitor writes one a minute.</p>
      ) : null}
      {rows.length > 0 && (
        <div className="kv-list">
          {row(
            'Resident memory',
            rows.map((r) => r.rss),
            mb,
            'The whole process, worker heaps included; the kernel kills it at the cgroup limit',
          )}
          {row(
            'Memory of limit',
            rows.map((r) => r.rssPct),
            (v) => `${v.toFixed(0)}%`,
            'The monitor recycles workers at 75%',
          )}
          {row(
            'Queue depth',
            rows.map((r) => r.queued),
            undefined,
            'Scanner jobs waiting for a worker',
          )}
          {row(
            'Runs per hour',
            rows.map((r) => r.runsH),
            undefined,
            'Scanner cells run in the trailing hour (one row per cell, so a lower bound)',
          )}
          {row(
            'Signals per hour',
            rows.map((r) => r.signalsH),
          )}
          {row(
            'Close lag (s)',
            rows.map((r) => r.closeLagS),
            (v) => v.toFixed(1),
            'Median seconds between a bar ending and its close being announced',
          )}
          {row(
            'Open positions',
            rows.map((r) => r.openPositions),
          )}
        </div>
      )}
    </Section>
  )
}

/** The one sentence the product owes its operator (decision 87): is there an edge yet, on which book, with what confidence. */
function EdgeVerdictLine() {
  const l = useLearning()
  const d = l.data
  if (!d) return null
  const word = (b: { lb90: number | null; ub90: number | null }) =>
    b.lb90 !== null && b.lb90 > 0 ? 'paying' : b.ub90 !== null && b.ub90 < 0 ? 'failing' : 'undecided'
  const tone = (w: string) => (w === 'paying' ? 'gain' : w === 'failing' ? 'loss' : 'muted')
  const book = (name: string, b: typeof d.live) => (
    <span>
      <b>{name}</b>: <b className={tone(word(b))}>{word(b)}</b> · {b.trades} trades · {fmtR(b.avgR)} a trade
      {b.lb90 !== null && b.ub90 !== null ? (
        <span className="muted">
          {' '}
          (90% band {b.lb90 >= 0 ? '+' : ''}
          {b.lb90.toFixed(2)} to {b.ub90 >= 0 ? '+' : ''}
          {b.ub90.toFixed(2)})
        </span>
      ) : null}
      {b.costShare !== null ? (
        <span className="muted"> · costs {Math.round(b.costShare * 100)}% of risk</span>
      ) : null}
    </span>
  )
  const w = word(d.live)
  return (
    <Callout tone={w === 'paying' ? 'ok' : w === 'failing' ? 'warn' : 'info'} title="Is there an edge?">
      <span title="Paying: the 90% confidence band of R per trade is above zero. Failing: it is below zero. Undecided: it straddles zero, which is what a small sample looks like.">
        {book('Account', d.live)}
        {d.current ? <> · {book('Under current settings', d.current)}</> : null} · {book('Shadow', d.shadow)}
      </span>
    </Callout>
  )
}
