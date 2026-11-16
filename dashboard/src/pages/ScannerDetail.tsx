import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  useBacktest,
  useConfig,
  useEquity,
  useMarkets,
  useProfileScanner,
  useReleaseScanner,
  useRunBacktest,
  useRunScanner,
  useScannerProfile,
  useScannerSource,
  useScanners,
  useSignals,
  useTrades,
  useUpdateScanner,
} from '../api/queries'
import type { EntrySource, Trade } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { scannerActivity } from '../lib/scannerPresentation'
import { ChartFrames } from '../chart/ChartFrames'
import { VelaChart, type ChartScript } from '../chart/VelaChart'
import { EquityChart } from '../components/charts'
import { DataTable, type Column } from '../components/DataTable'
import { IconExternal, IconPlay } from '../components/Icons'
import {
  Callout,
  ChipSelect,
  EmptyState,
  ErrorState,
  ExitReasonPill,
  Loading,
  PageHeader,
  Pill,
  Pnl,
  QueryState,
  ScannerStatusPill,
  Section,
  SidePill,
  Stat,
  StatGrid,
  TabPanel,
  Tabs,
  Time,
  ToggleGroup,
  Toolbar,
} from '../components/kit'
import { ScreenNow } from '../components/ScreenNow'

import { fmtInt, fmtMs, fmtPct, fmtPrice, fmtProfitFactor, fmtR } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'
import '../styles/pages/scanners.css'
import { SignalsTable } from './Signals'
import { StrategyBooks } from './StrategyBooks'

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
  const tfs = useMemo(
    () =>
      s?.timeframes?.length
        ? s.timeframes
        : config.data?.timeframes?.length
          ? config.data.timeframes
          : ['15m'],
    [s, config.data],
  )

  const [symbolSel, setSymbol] = useState('')
  const [tfSel, setTf] = useState('')
  const symbol = symbolSel && symbols.includes(symbolSel) ? symbolSel : (symbols[0] ?? '')
  const tf = tfSel && tfs.includes(tfSel) ? tfSel : (tfs[0] ?? '')

  const [showScript, setShowScript] = useState(false)
  // the scanner's drawing on every timeframe it is traded on, side by side (decision 97)
  const [framesView, setFramesView] = useState(false)
  const source = useScannerSource(showScript ? id : undefined)
  const scripts = useMemo<ChartScript[]>(() => {
    if (!showScript || !s || !source.data?.patched) return []
    return [
      {
        id: s.id,
        title: s.name,
        source: source.data.patched,
        overlay: s.overlay,
        inputs: source.data.inputs,
        sourceHash: source.data.sourceHash,
        timezone: source.data.timezone,
      },
    ]
  }, [showScript, s, source.data])

  const signals = useSignals({ scanner: id, limit: 100 })
  const trades = useTrades({ scanner: id, limit: 200 })
  const equity = useEquity(id)
  const auth = useAuth()
  const run = useRunScanner()
  const release = useReleaseScanner()
  const [tab, setTab] = useState<DetailTab>('books')
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
  if (scanners.isError && !scanners.data)
    return <ErrorState error={scanners.error} onRetry={() => scanners.refetch()} />
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

  const h = s.health
  const factPills: Array<[string, ReactNode]> = [
    ['Exits', s.exitMode],
    ['Paper cells', s.scheduledCells ?? 0],
    ['Protection', s.entryProtection ?? 'inherit'],
    ['ATR floor', `${s.minAtrPct ?? '–'}%`],
    ...(s.entryLimit
      ? [['Maker', `${s.entryLimit.atr} ATR · ${s.entryLimit.minutes}m expiry`] as [string, ReactNode]]
      : []),
    [
      'Source',
      <span className="mono" key="src">
        v{s.pineVersion} · {s.lines} lines
      </span>,
    ],
  ]
  const lr = s.lastRun
  const tabItems = [
    { id: 'books' as const, label: 'Books' },
    { id: 'overview' as const, label: 'Overview' },
    { id: 'chart' as const, label: 'Chart' },
    {
      id: 'activity' as const,
      label: 'Signals and trades',
      count: signals.data ? signals.data.length : undefined,
    },
    { id: 'backtest' as const, label: 'Backtest' },
    { id: 'reading' as const, label: 'How it is read', attention: !!h?.quarantined },
    { id: 'source' as const, label: 'Source' },
  ]

  return (
    <div className="page sc-page">
      <PageHeader
        title={s.name}
        subtitle={`Entry signals, results and settings for this scanner. File ${s.file}.`}
        meta={
          <>
            <ScannerStatusPill status={s.status} reason={s.reason} />
            <Pill tone={s.enabled ? 'ok' : 'muted'}>{s.enabled ? 'On' : 'Off'}</Pill>
            {h?.quarantined && (
              <Pill tone="danger" title={h.lastError}>
                Quarantined
              </Pill>
            )}
          </>
        }
        actions={
          <>
            {s.status === 'ok' && <ScreenNow ids={[s.id]} label={s.name} />}
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="btn"
              aria-label={`Open ${s.name} on TradingView`}
            >
              TradingView <IconExternal size={13} />
            </a>
            <button
              className="btn btn-cta"
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
          </>
        }
      />

      {h?.quarantined && (
        <Callout
          tone="danger"
          title="Quarantined."
          actions={
            auth.canTrade ? (
              <button
                className="btn btn-sm btn-danger-outline"
                onClick={() =>
                  release.mutate(s.id, {
                    onSuccess: () => toast.success('Released: it runs again from its next bar'),
                    onError: (e) => toast.error(String((e as Error).message ?? e)),
                  })
                }
                disabled={release.isPending}
                title="Lift the quarantine; a repeat failure quarantines it again"
              >
                {release.isPending ? 'Releasing…' : 'Release'}
              </button>
            ) : undefined
          }
        >
          {h.reason ?? 'It failed repeatedly'}, so it is not scheduled. Release it to try again; a repeat
          failure quarantines it again.
        </Callout>
      )}
      {s.reason && !h?.quarantined && (
        <Callout tone="danger" title="Cannot run.">
          {s.reason}
        </Callout>
      )}
      {s.enabled && s.scheduledCells === 0 && (
        <Callout tone="warn" title={scannerActivity(s).label}>
          {scannerActivity(s).detail}{' '}
          <Link to={`/incubator?q=${encodeURIComponent(s.id)}`}>Review evidence and allocations</Link>
        </Callout>
      )}

      <Tabs value={tab} onChange={setTab} items={tabItems} label="Scanner sections" idPrefix="sd" />

      <TabPanel id="books" value={tab} idPrefix="sd">
        <StrategyBooks id={id} s={s} onOpenReading={() => setTab('reading')} />
      </TabPanel>

      <TabPanel id="overview" value={tab} idPrefix="sd">
        <div className="sc-page">
          <div className="sd-stats">
            <StatGrid min={150}>
              <Stat label="Signals" value={fmtInt(st?.signals)} />
              <Stat label="Trades" value={fmtInt(st?.trades)} sub={`${st?.open ?? 0} open`} />
              <Stat
                label="Win rate"
                value={fmtPct(st?.winRatePct)}
                sub={`${st?.wins ?? 0}W / ${st?.losses ?? 0}L`}
              />
              <Stat
                label="Profit factor"
                value={fmtProfitFactor(st?.profitFactor)}
                tone={st?.profitFactor == null ? undefined : st.profitFactor >= 1 ? 'gain' : 'loss'}
              />
              <Stat label="PnL" value={<Pnl value={st?.pnl} />} sub={fmtPct(st?.pnlPct, 1, true)} />
              <Stat
                label="Average R"
                value={fmtR(st?.avgR)}
                tone={st?.avgR == null ? undefined : st.avgR >= 0 ? 'gain' : 'loss'}
              />
              <Stat
                label="Max drawdown"
                value={`−${fmtPct(Math.abs(st?.maxDrawdownPct ?? 0))}`}
                tone="loss"
              />
              <Stat
                label="Backtest PF"
                value={bt ? fmtProfitFactor(bt.profitFactor) : '–'}
                sub={
                  bt ? (
                    <>
                      {bt.trades} trades · {fmtPct(bt.winRatePct)}
                    </>
                  ) : (
                    'No warm backtest'
                  )
                }
                title="Backtest profit factor"
              />
            </StatGrid>
          </div>

          <Section variant="panel" title="Equity curve">
            <QueryState
              {...equity}
              data={equity.data}
              empty="No equity points for this scanner."
              hint="The curve starts with its first closed trade."
              skeleton="chart"
              skeletonHeight={200}
              onRetry={() => equity.refetch()}
            >
              {(d) => <EquityChart data={d} height={220} />}
            </QueryState>
          </Section>

          <Section variant="panel" title="Setup and last run">
            <div className="sd-facts" style={{ marginBottom: 10 }}>
              {factPills.map(([k, v]) => (
                <span className="sd-fact" key={k}>
                  {k} <b>{v}</b>
                </span>
              ))}
            </div>
            <div className="sd-lastrun">
              {lr ? (
                <span>
                  Last run <Time t={lr.at} mode="ago" /> on{' '}
                  <span className="mono">
                    {lr.symbol} {lr.tf}
                  </span>{' '}
                  in <span className="mono">{fmtMs(lr.ms)}</span>
                  {lr.error && <span className="loss"> · {lr.error}</span>}
                </span>
              ) : (
                <span>This scanner has not run yet.</span>
              )}
              {lr?.funnel && (
                <span title="What the last live run produced and where it emptied: raw script outputs, then events the reader kept, then outputs dropped with the reason, then what became of this bar's signals">
                  Funnel: {lr.funnel.raw.alerts} alert() · {lr.funnel.raw.conditions} conditions ·{' '}
                  {lr.funnel.raw.shapes} shapes · {lr.funnel.raw.labels} labels
                  {' → '}
                  {lr.funnel.events.entries} entries, {lr.funnel.events.exits} exits, {lr.funnel.events.info}{' '}
                  info
                  {Object.keys(lr.funnel.drops).length > 0 && (
                    <>
                      {' '}
                      · dropped:{' '}
                      {Object.entries(lr.funnel.drops)
                        .map(([k, n]) => `${k} ×${n}`)
                        .join(', ')}
                    </>
                  )}
                  {Object.keys(lr.funnel.actions).length > 0 && (
                    <>
                      {' '}
                      →{' '}
                      {Object.entries(lr.funnel.actions)
                        .map(([k, n]) => `${k} ×${n}`)
                        .join(', ')}
                    </>
                  )}
                  {lr.funnel.note && <> · {lr.funnel.note}</>}
                </span>
              )}
              {!!s.reads?.labels?.length && <span>Accepted entry labels: {s.reads.labels.join(', ')}</span>}
            </div>
          </Section>
        </div>
      </TabPanel>

      <TabPanel id="chart" value={tab} idPrefix="sd">
        <div className="sc-page">
          <Toolbar>
            <ToggleGroup ariaLabel="Symbol" value={symbol} onChange={setSymbol} options={symbols} />
            <ToggleGroup
              ariaLabel="Timeframe"
              value={tf}
              onChange={setTf}
              options={tfs.length ? tfs : [...DELTA_TIMEFRAMES]}
            />
            <label className="check">
              <input type="checkbox" checked={showScript} onChange={(e) => setShowScript(e.target.checked)} />{' '}
              Show script on chart
            </label>
            <label
              className="check"
              title="Every timeframe this scanner trades, side by side, each drawing the script"
            >
              <input type="checkbox" checked={framesView} onChange={(e) => setFramesView(e.target.checked)} />{' '}
              Frames
            </label>
            {showScript && source.isLoading && <span className="muted small">Loading source…</span>}
            {showScript && source.isError && <span className="loss small">Source unavailable</span>}
          </Toolbar>
          <Section variant="panel" pad={false}>
            {symbol && tf ? (
              // The chart swallows the wheel to zoom, which traps the page under the mouse. Here the page scrolls; hold Shift to zoom.
              <div
                onWheelCapture={(e) => {
                  if (!e.shiftKey) e.stopPropagation()
                }}
                title="Scroll moves the page; hold Shift to zoom the chart"
              >
                {framesView ? (
                  <ChartFrames
                    symbol={symbol}
                    tfs={(tfs.length ? tfs : ['15m', '1h', '4h']).slice(0, 4)}
                    scripts={scripts}
                    tickSize={tick}
                    height={tfs.length > 2 ? 760 : 420}
                  />
                ) : (
                  <VelaChart symbol={symbol} tf={tf} height={520} scripts={scripts} tickSize={tick} />
                )}
              </div>
            ) : (
              <Loading kind="chart" height={520} />
            )}
          </Section>
        </div>
      </TabPanel>

      <TabPanel id="activity" value={tab} idPrefix="sd">
        <div className="sc-page">
          <Section
            variant="panel"
            title="Signals"
            actions={<span className="muted small">{signals.data?.length ?? 0} latest</span>}
            pad={false}
          >
            <QueryState
              {...signals}
              data={signals.data}
              empty="No signals from this scanner."
              hint="Signals appear after the next closed bar once it is enabled."
              skeleton="table"
              skeletonRows={5}
              skeletonCols={9}
              onRetry={() => signals.refetch()}
            >
              {(d) => <SignalsTable signals={d} hideScanner maxHeight={360} />}
            </QueryState>
          </Section>
          <Section variant="panel" title="Closed trades" pad={false}>
            <QueryState
              {...trades}
              data={trades.data}
              empty="No closed trades from this scanner."
              hint="Trades land here once a TP, SL or script exit fires."
              skeleton="table"
              skeletonRows={5}
              skeletonCols={8}
              onRetry={() => trades.refetch()}
            >
              {(d) => <TradesMini trades={d} tick={tick} maxHeight={360} />}
            </QueryState>
          </Section>
        </div>
      </TabPanel>

      <TabPanel id="backtest" value={tab} idPrefix="sd">
        <div className="sc-page">
          <Toolbar>
            <ToggleGroup ariaLabel="Symbol" value={symbol} onChange={setSymbol} options={symbols} />
            <ToggleGroup
              ariaLabel="Timeframe"
              value={tf}
              onChange={setTf}
              options={tfs.length ? tfs : [...DELTA_TIMEFRAMES]}
            />
          </Toolbar>
          <Section
            variant="panel"
            title={`Backtest ${symbol} ${tf}`}
            actions={
              <button
                className="btn btn-sm btn-cta"
                disabled={!symbol || !tf || runBt.isPending}
                onClick={() =>
                  runBt.mutate(
                    { scanner: s.id, symbol, tf },
                    {
                      onSuccess: (r) =>
                        toast.success(
                          'Backtest complete',
                          `${r.trades?.length ?? 0} trades over ${r.bars} bars`,
                        ),
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
            {!btRes && !backtest.isLoading && (
              <EmptyState
                title={`No backtest for ${symbol} ${tf} yet.`}
                hint="Run one with the button above."
              />
            )}
            {btRes && (
              <div className="bt">
                <div className="sd-stats sd-stats-3">
                  <StatGrid min={120}>
                    <Stat label="Bars" value={fmtInt(btRes.bars)} />
                    <Stat
                      label="Trades"
                      value={fmtInt(btRes.trades?.length ?? (btRes.stats?.trades as number))}
                    />
                    <Stat label="Win rate" value={fmtPct(btRes.stats?.winRatePct as number)} />
                    <Stat
                      label="Profit factor"
                      value={fmtProfitFactor(btRes.stats?.profitFactor as number)}
                    />
                    <Stat label="PnL" value={<Pnl value={btRes.stats?.pnl as number} />} />
                    <Stat
                      label="Max drawdown"
                      value={fmtPct(btRes.stats?.maxDrawdownPct as number)}
                      sub={
                        <>
                          Run <Time t={btRes.at} mode="datetime" />
                        </>
                      }
                    />
                  </StatGrid>
                </div>
                {btRes.equity?.length > 1 && (
                  <EquityChart
                    data={btRes.equity.map((e) => ({
                      at: e.at,
                      equity: e.equity,
                      realized: 0,
                      unrealized: 0,
                    }))}
                    height={160}
                  />
                )}
                <TradesMini trades={btRes.trades ?? []} tick={tick} maxHeight={300} />
              </div>
            )}
          </Section>
        </div>
      </TabPanel>

      <TabPanel id="reading" value={tab} idPrefix="sd">
        <ReadingPanel s={s} />
      </TabPanel>

      <TabPanel id="source" value={tab} idPrefix="sd">
        <Section variant="panel" title="Source">
          <SourceViewer id={id} />
        </Section>
      </TabPanel>
    </div>
  )
}

type DetailTab = 'books' | 'overview' | 'chart' | 'activity' | 'backtest' | 'reading' | 'source'

function TradesMini({ trades, tick, maxHeight }: { trades: Trade[]; tick?: number; maxHeight?: number }) {
  const cols = useMemo<Column<Trade>[]>(
    () => [
      {
        key: 'exitAt',
        header: 'Closed',
        value: (t) => t.exitAt,
        render: (t) => <Time t={t.exitAt} mode="datetime" className="small muted" />,
      },
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
      {
        key: 'entry',
        header: 'Entry',
        numeric: true,
        value: (t) => t.entryPrice,
        render: (t) => fmtPrice(t.entryPrice, tick),
      },
      {
        key: 'exit',
        header: 'Exit',
        numeric: true,
        value: (t) => t.exitPrice,
        render: (t) => fmtPrice(t.exitPrice, tick),
      },
      { key: 'pnl', header: 'PnL', numeric: true, value: (t) => t.pnl, render: (t) => <Pnl value={t.pnl} /> },
      {
        key: 'r',
        header: 'R',
        numeric: true,
        value: (t) => t.rMultiple,
        render: (t) => (
          <span className={t.rMultiple == null ? 'neutral' : t.rMultiple >= 0 ? 'gain' : 'loss'}>
            {fmtR(t.rMultiple)}
          </span>
        ),
      },
      {
        key: 'reason',
        header: 'Exit reason',
        value: (t) => t.exitReason,
        render: (t) => <ExitReasonPill reason={t.exitReason} />,
      },
    ],
    [tick],
  )
  return (
    <DataTable
      columns={cols}
      rows={trades}
      rowKey={(t) => t.id ?? `${t.positionId}-${t.exitAt}`}
      defaultSort={{ key: 'exitAt', dir: 'desc' }}
      emptyLabel="No trades"
      maxHeight={maxHeight}
      caption="Trades"
    />
  )
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
        <ToggleGroup
          ariaLabel="Source version"
          value={tab}
          onChange={setTab}
          options={['patched', 'original']}
        />
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

const KIND_TONE: Record<string, 'ok' | 'accent' | 'muted' | 'warn' | 'danger'> = {
  plan: 'ok',
  signal: 'accent',
  exits: 'muted',
  levels: 'muted',
  silent: 'warn',
  broken: 'danger',
}
const SOURCES: EntrySource[] = ['alert', 'alertcondition', 'shape', 'derived', 'label']

/**
 * How this script is read, and what it produced when last profiled (decision 48). The entry
 * channel, timezone and derivation rule are editable here; a profile run shows the counts the
 * classification rests on so an over-read script is visible as such.
 */
function ReadingPanel({ s }: { s: NonNullable<ReturnType<typeof useScanners>['data']>[number] }) {
  const auth = useAuth()
  const update = useUpdateScanner()
  const profile = useProfileScanner()
  const rows = useScannerProfile(s.id)
  const toast = useToast()
  const [sources, setSources] = useState<EntrySource[]>(s.reads?.sources ?? [])
  const [timezone, setTimezone] = useState(s.reads?.timezone ?? '')
  const [rule, setRule] = useState<string>(s.reads?.rule ?? '')
  const [labels, setLabels] = useState<string>((s.reads?.labels ?? []).join(', '))
  const [invert, setInvert] = useState<boolean>(Boolean(s.reads?.invert))
  const labelList = labels
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const dirty =
    JSON.stringify(sources) !== JSON.stringify(s.reads?.sources ?? []) ||
    timezone !== (s.reads?.timezone ?? '') ||
    rule !== (s.reads?.rule ?? '') ||
    JSON.stringify(labelList) !== JSON.stringify(s.reads?.labels ?? []) ||
    invert !== Boolean(s.reads?.invert)
  const save = () =>
    update.mutate(
      {
        id: s.id,
        body: {
          sources: sources.length ? sources : null,
          timezone: timezone || null,
          rule: (rule || null) as 'trailing' | 'oscillator' | null,
          labels: labelList.length ? labelList : null,
          invert,
        },
      },
      {
        onSuccess: () => toast.success('Saved how this script is read'),
        onError: (e) => toast.error(String((e as Error).message ?? e)),
      },
    )
  const h = s.health
  return (
    <Section
      variant="panel"
      title="How it is read"
      actions={
        <div className="row gap">
          {s.kind ? (
            <Pill
              tone={KIND_TONE[s.kind]}
              title={s.profiledAt ? `profiled ${new Date(s.profiledAt).toUTCString()}` : ''}
            >
              {s.kind}
            </Pill>
          ) : (
            <span className="muted small">not profiled yet</span>
          )}
          <button
            className="btn btn-sm"
            onClick={() =>
              profile.mutate({ id: s.id }, { onError: (e) => toast.error(String((e as Error).message ?? e)) })
            }
            disabled={profile.isPending || s.status !== 'ok'}
            title="Run the script on ETHUSD 15m/1h/4h and classify what it produces"
          >
            {profile.isPending ? 'Profiling…' : 'Profile now'}
          </button>
        </div>
      }
    >
      {(s.reads?.sides || s.reads?.variantOf) && (
        <Callout tone="info" title="Reading contract.">
          {s.reads?.variantOf && (
            <>
              A variant of{' '}
              <a className="link" href={`/scanners/${s.reads.variantOf}`}>
                {s.reads.variantOf}
              </a>
              : the same Pine source, read its own way, with its own record.{' '}
            </>
          )}
          {s.reads?.sides && (
            <>
              The account reads these outputs as written here, not as the chart's wording or arrows suggest:{' '}
              {Object.entries(s.reads.sides).map(([t, v], i) => (
                <span key={t}>
                  {i ? ' · ' : ''}
                  <span className="mono">{t}</span> → <b>{v === 'none' ? 'not an entry' : v}</b>
                </span>
              ))}
              .
            </>
          )}
        </Callout>
      )}
      <div className="sd-read-grid">
        <div>
          <ChipSelect
            label="Entry channel"
            options={SOURCES}
            value={sources}
            onChange={(v) => setSources(v as EntrySource[])}
            emptyLabel="all channels"
            disabled={!auth.canTrade}
          />
          <p className="muted small">
            Which of the script's outputs may open a trade. A plan script should read <b>alert</b> only;
            shapes and alertconditions on the same bars are markers, not trade calls.
          </p>
          <label className="field">
            <span className="field-label">Signal labels allowed</span>
            <input
              className="input mono"
              value={labels}
              placeholder="every label · e.g. Bull Spike, 🟢 BREAK UP"
              onChange={(e) => setLabels(e.target.value)}
              disabled={!auth.canTrade}
            />
          </label>
          <p className="muted small">
            Comma-separated prefixes. Only entries whose label starts with one of them open a trade; the
            scanner test (decision 67) found one channel of a script paying while its siblings lose. Empty =
            every label.
          </p>
          <label className="row gap small">
            <input
              type="checkbox"
              checked={invert}
              onChange={(e) => setInvert(e.target.checked)}
              disabled={!auth.canTrade}
            />{' '}
            Read every entry the other way{' '}
            <span className="muted">
              (for scripts whose signal names describe what just happened — a rejection, an exhaustion — not
              the trade to take)
            </span>
          </label>
          <div className="row gap wrap">
            <label className="field">
              <span className="field-label">Timezone</span>
              <input
                className="input mono"
                value={timezone}
                placeholder="Etc/UTC"
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!auth.canTrade}
              />
            </label>
            <label className="field">
              <span className="field-label">Derived rule</span>
              <select
                className="select"
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                disabled={!auth.canTrade}
              >
                <option value="">none</option>
                <option value="trailing">trailing (close crosses the trail)</option>
                <option value="oscillator">oscillator (zero / OB-OS cross)</option>
              </select>
            </label>
            {auth.canTrade && (
              <button className="btn btn-cta btn-sm" onClick={save} disabled={!dirty || update.isPending}>
                {update.isPending ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
          {s.reads?.inputs && Object.keys(s.reads.inputs).length > 0 && (
            <p className="muted small mono">inputs: {JSON.stringify(s.reads.inputs)}</p>
          )}
          {s.reads?.exit && Object.keys(s.reads.exit).length > 0 && (
            <p className="muted small mono">exit overrides: {JSON.stringify(s.reads.exit)}</p>
          )}
          {h && !h.quarantined && h.fails > 0 && (
            <p className="muted small">
              {h.fails} permanent-looking failure(s), last: {h.lastError}
            </p>
          )}
        </div>
        <div>
          {rows.data?.rows?.length ? (
            <div className="sd-profile-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>tf</th>
                    <th>kind</th>
                    <th className="num">entries</th>
                    <th className="num">with plan</th>
                    <th className="num">from alert</th>
                    <th className="num">alertconds</th>
                    <th className="num">shapes</th>
                    <th className="num">labels</th>
                    <th className="num">plots</th>
                    <th className="num">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.data.rows.map((r) => (
                    <tr key={`${r.market}-${r.tf}`} title={r.error ?? r.labelTexts.join(' | ')}>
                      <td className="mono">{r.tf}</td>
                      <td>
                        <Pill tone={KIND_TONE[r.kind]}>{r.kind}</Pill>
                      </td>
                      <td className="num mono">{r.entries}</td>
                      <td className="num mono">{Math.max(r.withSl, r.withTp)}</td>
                      <td className="num mono">{r.alertEntries}</td>
                      <td className="num mono">{r.alertconds}</td>
                      <td className="num mono">{r.shapes}</td>
                      <td className="num mono">{r.labels}</td>
                      <td className="num mono">{r.plots}</td>
                      <td className="num mono muted">{r.ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">
              No profile yet. "Profile now" runs the script on ETHUSD across 15m, 1h and 4h and reports what
              it emits — the numbers the kind badge rests on.
            </p>
          )}
          {rows.data?.rows?.some((r) => r.entries > r.alertEntries && !s.reads?.sources?.length) && (
            <Callout tone="warn" title="More entries than trade calls.">
              Shapes or alertconditions are being read as entries. Lock the entry channel to <b>alert</b>{' '}
              unless that is intended.
            </Callout>
          )}
        </div>
      </div>
    </Section>
  )
}
