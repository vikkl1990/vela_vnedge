import { MarketScopeNote } from '../components/MarketScopeNote'
import { useMarketScope } from '../lib/marketScope'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../api/client'
import { useMarkets, useScannerIndex } from '../api/queries'
import { REFRESH } from '../api/refreshPolicy'
import type { PerformanceGroup, PerformanceStats } from '../api/types'
import { EvidenceBadge } from '../components/EvidenceBadge'
import {
  ASSET_GROUPS,
  ASSET_SECTORS,
  groupLabel,
  matchesClass,
  sectorLabel,
} from '../../../shared/assetClass'
import { AllocationAuditPanel } from '../components/AllocationAudit'
import { AssetClassBreakdown } from '../components/AssetClassBreakdown'
import { classRows } from '../lib/assetClass'
import { useClassOf } from '../lib/assetClass'
import { DataTable, type Column } from '../components/DataTable'
import { LearningSection } from '../components/Learning'
import { PolicyHealthPanel } from '../components/PolicyHealth'
import {
  Callout,
  EmptyState,
  ErrorState,
  Loading,
  RouteHeader,
  Section,
  TabPanel,
  Tabs,
  Time,
  Toolbar,
} from '../components/kit'

import { fmtInt, fmtMoney, fmtPct, fmtPnl, fmtR } from '../lib/format'
import { JOURNAL_PERIODS, journalFilters, updateJournalFilters } from '../lib/journalFilters'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useNow } from '../lib/useNow'
import '../styles/pages/analytics.css'

const GROUPS = [
  ['byGroup', 'Asset class', 'group'],
  ['bySector', 'Sector', 'sector'],
  ['byTf', 'Timeframe', 'tf'],
  ['bySymbol', 'Market', 'symbol'],
  ['byScanner', 'Scanner', 'scanner'],
  ['byExit', 'Exit reason', 'reason'],
] as const
const EXITS: Record<string, string> = {
  sl: 'Stop loss',
  trail: 'Trailing stop',
  be: 'Break-even',
  tp1: 'Take profit 1',
  tp2: 'Take profit 2',
  tp3: 'Take profit 3',
  manual: 'Manual',
  reversal: 'Reversal',
  script_exit: 'Script exit',
  'funding-avoid': 'Funding avoidance',
  'time-exit': 'Time exit',
}
const tone = (v: number | null) => (v === null || v === 0 ? '' : v > 0 ? 'gain' : 'loss')
const avgR = (v: number | null) => (v === null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}R`)
const day = (t: number) => new Date(t).toISOString().slice(0, 10)

function BookCard({
  title,
  sub,
  stats: s,
  shadow = false,
}: {
  title: string
  sub: string
  stats: PerformanceStats
  shadow?: boolean
}) {
  return (
    <section
      className={`performance-book ${shadow ? 'performance-shadow' : 'performance-paper'}`}
      aria-label={`${title} performance`}
    >
      <div className="performance-book-head">
        <div>
          <h2>{title}</h2>
          <p className="muted small">{sub}</p>
        </div>
        <span className="pill">{fmtInt(s.trades)} closed</span>
      </div>
      <div className="performance-edge">
        <span className="muted small">NET R / TRADE</span>
        <strong className={`mono ${tone(s.avgR)}`}>
          {avgR(s.avgR)}
          <EvidenceBadge stats={s} />
        </strong>
        <span className="muted small">
          {s.trades === 0
            ? 'No closes in this selection'
            : `${fmtR(s.sumR)} total · ${fmtInt(s.rTrades)} trades with recorded risk`}
        </span>
      </div>
      <dl className="performance-metrics">
        <div>
          <dt>{shadow ? 'Net P&L · simulated USD' : 'Net P&L · USD'}</dt>
          <dd className={`mono ${tone(s.net)}`}>{fmtPnl(s.net)}</dd>
        </div>
        <div>
          <dt>Win rate · after costs</dt>
          <dd className="mono">{s.trades ? fmtPct(s.winRate) : '–'}</dd>
        </div>
        <div>
          <dt>Stop losses</dt>
          <dd className="mono">
            {fmtInt(s.stops)} <small className="muted">/ {s.trades ? fmtPct(s.stopRate) : '–'}</small>
          </dd>
        </div>
        <div>
          <dt>Profit factor · USD</dt>
          <dd className="mono">
            {!s.trades
              ? '–'
              : s.noLosses
                ? 'No losses'
                : s.profitFactor === null
                  ? '–'
                  : s.profitFactor.toFixed(2)}
          </dd>
        </div>
      </dl>
      <div className="performance-costs" aria-label={`${title} cost breakdown`}>
        <div className="performance-cost-r">
          <span>Commission / trade</span>
          <b className="mono">{s.avgCommissionR === null ? '–' : `${s.avgCommissionR.toFixed(3)}R`}</b>
        </div>
        <div>
          <span>Trading P&L · {shadow ? 'sim. $' : '$'}</span>
          <b className="mono">{s.fundingUnknown ? 'Unavailable' : fmtPnl(s.grossTrading)}</b>
        </div>
        <div>
          <span>
            Commission <small>(deducted)</small>
          </span>
          <b className="mono">{fmtMoney(s.commission)}</b>
        </div>
        <div>
          <span>
            Funding <small>(signed)</small>
          </span>
          <b className={`mono ${s.fundingUnknown ? '' : tone(s.funding)}`}>
            {s.fundingUnknown ? 'Unavailable' : fmtPnl(s.funding)}
          </b>
        </div>
      </div>
      {s.rTrades < s.trades && (
        <p className="small muted">
          {fmtInt(s.trades - s.rTrades)} trades lack valid initial risk and are excluded from R metrics.
        </p>
      )}
      {s.fundingUnknown > 0 && (
        <p className="small muted">
          Funding detail is missing for {s.fundingUnknown} trades. Net P&L and commission still include every
          close.
        </p>
      )}
    </section>
  )
}

function ComparisonRows({
  rows,
  group,
  onChoose,
}: {
  rows: PerformanceGroup[]
  group: string
  onChoose: (key: string) => void
}) {
  const mobile = useMediaQuery('(max-width: 900px)')
  const label = (r: PerformanceGroup) =>
    group === 'byExit'
      ? (EXITS[r.key] ?? r.label)
      : group === 'byGroup'
        ? groupLabel(r.key)
        : group === 'bySector'
          ? sectorLabel(r.key)
          : r.label
  const cols: Column<PerformanceGroup>[] = [
    {
      key: 'label',
      header: 'Group · click to filter',
      value: (r) => label(r),
      render: (r) => (
        <button className="link performance-group-link" onClick={() => onChoose(r.key)}>
          {label(r)}
        </button>
      ),
    },
    ...(['paper', 'shadow'] as const).flatMap((book) => {
      const title = book === 'paper' ? 'Paper' : 'Shadow'
      return [
        {
          key: `${book}-trades`,
          header: `${title} trades`,
          numeric: true,
          value: (r: PerformanceGroup) => r[book].trades,
          render: (r: PerformanceGroup) => fmtInt(r[book].trades),
        },
        {
          key: `${book}-r`,
          header: `${title} R / trade`,
          numeric: true,
          value: (r: PerformanceGroup) => r[book].avgR,
          render: (r: PerformanceGroup) => (
            <span className={tone(r[book].avgR)}>
              {avgR(r[book].avgR)}
              <EvidenceBadge stats={r[book]} />
            </span>
          ),
        },
        {
          key: `${book}-net`,
          header: `${title} net $`,
          numeric: true,
          value: (r: PerformanceGroup) => r[book].net,
          render: (r: PerformanceGroup) => <span className={tone(r[book].net)}>{fmtPnl(r[book].net)}</span>,
        },
        {
          key: `${book}-sl`,
          header: `${title} SL %`,
          numeric: true,
          value: (r: PerformanceGroup) => r[book].stopRate,
          render: (r: PerformanceGroup) => (
            <span title={`${r[book].stops} stop-loss exits`}>{fmtPct(r[book].stopRate)}</span>
          ),
        },
      ]
    }),
  ]
  if (!rows.length)
    return (
      <EmptyState
        title="No closed trades match this selection"
        hint="Widen the period or clear a filter above, or clear the group search."
      />
    )
  if (!mobile)
    return (
      <DataTable
        key={group}
        columns={cols}
        rows={rows}
        rowKey={(r) => r.key}
        defaultSort={{ key: 'paper-trades', dir: 'desc' }}
        caption="Paper and shadow performance by group"
        maxHeight={580}
      />
    )
  return (
    <div className="performance-groups">
      {[...rows]
        .sort((a, b) => b.paper.trades - a.paper.trades || b.shadow.trades - a.shadow.trades)
        .map((r) => (
          <article key={r.key} className="performance-group-card">
            <button className="link performance-group-link" onClick={() => onChoose(r.key)}>
              {label(r)} →
            </button>
            <div className="performance-group-books">
              {(['paper', 'shadow'] as const).map((book) => (
                <div key={book}>
                  <b className="small">{book === 'paper' ? 'Paper' : 'Shadow'}</b>
                  <strong className={`mono ${tone(r[book].avgR)}`}>
                    {avgR(r[book].avgR)} <small>/ trade</small>
                    <EvidenceBadge stats={r[book]} />
                  </strong>
                  <span>
                    {fmtInt(r[book].trades)} trades · {fmtPct(r[book].stopRate)} SL
                  </span>
                  <span className={tone(r[book].net)}>{fmtPnl(r[book].net)} USD net</span>
                </div>
              ))}
            </div>
          </article>
        ))}
    </div>
  )
}

export function Analytics() {
  const [params, setParams] = useSearchParams()
  const effective = new URLSearchParams(params)
  if (!effective.has('period')) effective.set('period', '7d')
  const [marketScope] = useMarketScope()
  const f = journalFilters(effective, useNow(60_000), marketScope)
  const { scanner, symbol, tf, side, reason, from, to, group: assetGroup, sector: assetSector } = f.query
  const filter = { scanner, symbol, tf, side, reason, from, to, group: assetGroup, sector: assetSector }
  const update = (v: Record<string, string>) => setParams(updateJournalFilters(effective, v))
  const q = useQuery({
    queryKey: ['analytics', 'performance', filter],
    queryFn: () => api.performance(filter),
    enabled: !f.error,
    staleTime: 20_000,
    refetchInterval: REFRESH.slow,
    retry: 1,
  })
  const d = f.error ? undefined : q.data
  const markets = useMarkets(),
    scanners = useScannerIndex()
  const [scannerSearch, setScannerSearch] = useState('')
  const [group, setGroup] = useState<(typeof GROUPS)[number][0]>('byGroup')
  const classOf = useClassOf()
  const [search, setSearch] = useState('')
  const [chartMetric, setChartMetric] = useState<'avgR' | 'trades'>('avgR')
  const [tab, setTab] = useState<'breakdown' | 'daily' | 'advanced'>('breakdown')
  const symbols = [
    ...new Set([
      ...(markets.data ?? []).map((m) => m.symbol),
      ...(d?.bySymbol ?? []).map((r) => r.key),
      ...(f.symbol ? [f.symbol] : []),
    ]),
  ]
    .filter((s) => s === f.symbol || matchesClass(classOf(s), f.group, f.sector))
    .sort()
  const rows = (d?.[group] ?? []).filter((r) => r.label.toLowerCase().includes(search.toLowerCase()))
  const journalParams = new URLSearchParams(effective)
  journalParams.delete('page')
  const includesToday = d && (from === undefined || from <= d.at) && (to === undefined || to > d.at)
  const periodText = d
    ? `${from === undefined ? 'All available history' : day(from)} → ${day((to ?? d.to) - 1)} UTC${includesToday ? ' · today partial' : ''}`
    : ''
  const resetFilters = () => {
    setParams({ period: '7d' })
    setScannerSearch('')
    setSearch('')
  }
  const filtered = Boolean(
    f.symbol ||
    f.tf ||
    f.side ||
    f.reason ||
    f.scanner ||
    (f.group && !f.groupFromScope) ||
    f.sector ||
    f.period !== '7d',
  )
  return (
    <div className="page performance-page">
      {f.groupFromScope && <MarketScopeNote scope={marketScope} />}
      <RouteHeader
        sub="Paper account and shadow research over one closing period, after costs. Then see which markets, timeframes and scanners add to it."
        actions={
          <>
            <Link className="btn btn-sm" to="/daily">
              Daily report
            </Link>
            <button className="btn btn-sm" onClick={resetFilters} disabled={!filtered}>
              Reset filters
            </button>
          </>
        }
      />
      <div className="perf-filterbar">
        <Toolbar
          end={
            <div className="perf-scope small muted" role="status">
              {d ? (
                <>
                  <b>{periodText}</b>
                  <span>
                    Updated <Time t={d.at} />
                    {q.isFetching ? ' · refreshing…' : ''}
                  </span>
                </>
              ) : (
                'Both books use the same filters. Closing dates are UTC.'
              )}
            </div>
          }
        >
          <label className="perf-field">
            Closed in
            <select
              className="select"
              aria-label="Performance period"
              value={f.period}
              onChange={(e) => update({ period: e.target.value })}
            >
              {JOURNAL_PERIODS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="perf-field">
            Asset class
            <select
              className="select"
              aria-label="Performance asset class"
              value={f.group || 'all'}
              onChange={(e) => update({ group: e.target.value })}
            >
              <option value="all">All classes</option>
              {ASSET_GROUPS.map((g) => (
                <option key={g.key} value={g.key} title={g.hint}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="perf-field">
            Sector
            <select
              className="select"
              aria-label="Performance sector"
              value={f.sector}
              onChange={(e) => update({ sector: e.target.value })}
            >
              <option value="">All sectors</option>
              {ASSET_SECTORS.filter((s) => s.key !== 'other').map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="perf-field">
            Market
            <select
              className="select"
              aria-label="Performance market"
              value={f.symbol}
              onChange={(e) => update({ symbol: e.target.value })}
            >
              <option value="">All markets</option>
              {symbols.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="perf-field">
            Timeframe
            <select
              className="select"
              aria-label="Performance timeframe"
              value={f.tf}
              onChange={(e) => update({ tf: e.target.value })}
            >
              <option value="">All timeframes</option>
              {f.tf && !DELTA_TIMEFRAMES.some((t) => t === f.tf) && <option>{f.tf}</option>}
              {DELTA_TIMEFRAMES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="perf-field">
            Direction
            <select
              className="select"
              aria-label="Performance direction"
              value={f.side}
              onChange={(e) => update({ side: e.target.value })}
            >
              <option value="">All directions</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
          <label className="perf-field">
            Exit
            <select
              className="select"
              aria-label="Performance exit"
              value={f.reason}
              onChange={(e) => update({ reason: e.target.value })}
            >
              <option value="">All exits</option>
              {[
                ...new Set([
                  ...Object.keys(EXITS),
                  ...(d?.byExit ?? []).map((r) => r.key),
                  ...(f.reason ? [f.reason] : []),
                ]),
              ].map((r) => (
                <option key={r} value={r}>
                  {EXITS[r] ?? r}
                </option>
              ))}
            </select>
          </label>
        </Toolbar>
        <details className="performance-scanner">
          <summary>
            Scanner:{' '}
            {f.scanner ? (scanners.data?.find((s) => s.id === f.scanner)?.name ?? f.scanner) : 'All scanners'}
          </summary>
          <div className="perf-scanner-fields">
            <label className="perf-field">
              Find scanner
              <input
                className="input"
                type="search"
                value={scannerSearch}
                placeholder="Search scanner names…"
                onChange={(e) => setScannerSearch(e.target.value)}
              />
            </label>
            <label className="perf-field">
              Scanner
              <select
                className="select"
                aria-label="Performance scanner"
                value={f.scanner}
                onChange={(e) => update({ scanner: e.target.value })}
              >
                <option value="">All scanners</option>
                {f.scanner && !scanners.data?.some((s) => s.id === f.scanner) && (
                  <option value={f.scanner}>{f.scanner}</option>
                )}
                {(scanners.data ?? [])
                  .filter(
                    (s) =>
                      s.id === f.scanner ||
                      `${s.name} ${s.id}`.toLowerCase().includes(scannerSearch.toLowerCase()),
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </details>
        {f.period === 'custom' && (
          <div className="performance-dates">
            <label className="perf-field">
              From (UTC)
              <input
                className="input"
                type="date"
                aria-label="Performance start date"
                value={f.start}
                onChange={(e) => update({ start: e.target.value })}
              />
            </label>
            <label className="perf-field">
              Through (UTC)
              <input
                className="input"
                type="date"
                aria-label="Performance end date"
                value={f.end}
                min={f.start || undefined}
                onChange={(e) => update({ end: e.target.value })}
              />
            </label>
          </div>
        )}
      </div>
      {f.error && (
        <Callout tone="warn" title="Check the filters">
          {f.error}
        </Callout>
      )}
      {!f.error && q.isLoading && <Loading kind="table" rows={4} cols={2} />}
      {!f.error && q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && (
        <>
          <div className="performance-books">
            <BookCard title="Paper account" sub="Account trades · recorded position sizes" stats={d.paper} />
            <BookCard
              title="Shadow research"
              sub="Incubator trades · independent simulated sizes"
              stats={d.shadow}
              shadow
            />
          </div>
          <Section
            variant="panel"
            title="By asset class"
            actions={
              <span className="small muted">
                majors · large-cap alts · alts · meme · stocks &amp; metals · other
              </span>
            }
          >
            <div className="performance-books">
              <div>
                <b className="small">Paper account</b>
                <AssetClassBreakdown
                  rows={classRows(d.byGroup, 'paper')}
                  book="paper"
                  onChoose={(key) => update({ group: key })}
                />
              </div>
              <div>
                <b className="small">Shadow research</b>
                <AssetClassBreakdown
                  rows={classRows(d.byGroup, 'shadow')}
                  book="shadow"
                  onChoose={(key) => update({ group: key })}
                />
              </div>
            </div>
          </Section>
          <Callout tone="info" title="How to read this">
            R is net P&L divided by the initial stop-risk budget. Net is trading P&L minus commission plus
            signed funding. The books trade different opportunities and sizes, so shadow dollars are not
            account returns.
          </Callout>
          <details className="perf-more small muted">
            <summary>What is counted</summary>
            <p>
              Commission per trade uses each trade’s initial risk, averaged over trades with valid risk. Open
              positions, backtests, watch-only orders and experimental plans are excluded. Each order keeps
              its reporting category even if its scanner later moves. Older categories were inferred once at
              the 31 October migration.
            </p>
          </details>
        </>
      )}
      <Tabs
        idPrefix="perf"
        label="Performance views"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'breakdown', label: 'Where results come from', count: d ? rows.length : undefined },
          { id: 'daily', label: 'Day by day', count: d ? d.daily.length : undefined },
          { id: 'advanced', label: 'Advanced diagnostics' },
        ]}
      />
      {d && (
        <>
          <TabPanel idPrefix="perf" id="breakdown" value={tab}>
            <Section
              variant="panel"
              title="Where results come from"
              pad={false}
              actions={
                <Link className="btn btn-sm" to={`/trades?${journalParams}`}>
                  Paper journal →
                </Link>
              }
            >
              <div className="performance-breakdown-controls">
                <label>
                  Compare by
                  <select
                    className="select"
                    value={group}
                    onChange={(e) => {
                      setGroup(e.target.value as typeof group)
                      setSearch('')
                    }}
                  >
                    {GROUPS.map(([v, label]) => (
                      <option value={v} key={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Find group
                  <input
                    className="input"
                    type="search"
                    value={search}
                    placeholder="Filter these rows…"
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <span className="small muted">{rows.length} groups · same filters as above</span>
              </div>
              <ComparisonRows
                rows={rows}
                group={group}
                onChoose={(key) => {
                  update({ [GROUPS.find((g) => g[0] === group)![2]]: key })
                  setSearch('')
                }}
              />
              <p className="small muted performance-note">
                SL % counts exits labelled stop loss. Trailing stops and break-even exits are separate. Small
                samples can be noisy; a positive average is not a promotion recommendation.
              </p>
            </Section>
          </TabPanel>
          <TabPanel idPrefix="perf" id="daily" value={tab}>
            <Section
              variant="panel"
              title="Day by day"
              actions={
                <select
                  className="select"
                  aria-label="Daily chart metric"
                  value={chartMetric}
                  onChange={(e) => setChartMetric(e.target.value as typeof chartMetric)}
                >
                  <option value="avgR">Net R / trade</option>
                  <option value="trades">Closed trade count</option>
                </select>
              }
            >
              <p className="small muted performance-chart-note">
                UTC closing days with trades.{' '}
                {chartMetric === 'avgR'
                  ? 'Each bar is that day’s average net R; days without closes in a book have no bar.'
                  : 'Closed trades per book, including stops and other exits.'}
                {includesToday ? ' Today is partial.' : ''}
              </p>
              {!d.daily.length ? (
                <EmptyState
                  title="No closed trades to chart"
                  hint="Pick a longer period or clear a filter."
                />
              ) : (
                <>
                  <div
                    className="performance-chart"
                    role="img"
                    aria-label={`Daily paper versus shadow ${chartMetric === 'avgR' ? 'net R per trade' : 'closed trade counts'}. Exact values are in the daily values table below.`}
                  >
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={d.daily} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--border)" vertical={false} />
                        <XAxis
                          dataKey="key"
                          tickFormatter={(v) => String(v).slice(5)}
                          minTickGap={30}
                          fontSize={11}
                          stroke="var(--muted)"
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          width={58}
                          fontSize={11}
                          stroke="var(--muted)"
                          tickLine={false}
                          axisLine={false}
                          allowDecimals={chartMetric === 'avgR'}
                          tickFormatter={(v) =>
                            chartMetric === 'avgR'
                              ? `${Number(v).toLocaleString(undefined, { maximumSignificantDigits: 3 })}R`
                              : fmtInt(Number(v))
                          }
                        />
                        <ReferenceLine y={0} stroke="var(--muted-2)" />
                        <Legend />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--surface)',
                            border: '1px solid var(--border)',
                            borderRadius: 8,
                            color: 'var(--text)',
                          }}
                          labelFormatter={(v) => `${v} · UTC`}
                          formatter={(value, name) => [
                            chartMetric === 'avgR' ? avgR(Number(value)) : fmtInt(Number(value)),
                            String(name),
                          ]}
                        />
                        <Bar
                          dataKey={`paper.${chartMetric}`}
                          name="Paper"
                          fill="var(--accent)"
                          maxBarSize={28}
                          isAnimationActive={false}
                        />
                        <Bar
                          dataKey={`shadow.${chartMetric}`}
                          name="Shadow"
                          fill="var(--performance-shadow)"
                          maxBarSize={28}
                          isAnimationActive={false}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <details className="performance-daily-values">
                    <summary>View daily values</summary>
                    <div className="table-wrap">
                      <table className="table">
                        <caption className="sr-only">Daily paper and shadow values, UTC</caption>
                        <thead>
                          <tr>
                            <th>UTC day</th>
                            <th>Paper trades</th>
                            <th>Paper R / trade</th>
                            <th>Paper net $</th>
                            <th>Shadow trades</th>
                            <th>Shadow R / trade</th>
                            <th>Shadow net $</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...d.daily].reverse().map((r) => (
                            <tr key={r.key}>
                              <td>
                                {r.key}
                                {r.key === day(d.at) ? ' · partial' : ''}
                              </td>
                              <td>{r.paper.trades}</td>
                              <td>{avgR(r.paper.avgR)}</td>
                              <td>{fmtPnl(r.paper.net)}</td>
                              <td>{r.shadow.trades}</td>
                              <td>{avgR(r.shadow.avgR)}</td>
                              <td>{fmtPnl(r.shadow.net)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </>
              )}
            </Section>
          </TabPanel>
        </>
      )}
      <TabPanel idPrefix="perf" id="advanced" value={tab}>
        <Section
          title="Advanced diagnostics"
          hint="Separate research views with their own windows; the filters above do not apply."
        >
          <Callout tone="info">
            Learning uses up to 5,000 paper closes and up to 20,000 shadow closes from the last 30 days.
            Allocation uses its own evidence windows.
          </Callout>
          <div className="stack">
            <PolicyHealthPanel />
            <AllocationAuditPanel />
            <LearningSection />
          </div>
        </Section>
      </TabPanel>
    </div>
  )
}
