import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import {
  useBacktest,
  useConfig,
  useMarkets,
  useMl,
  useMlYardstick,
  useRunBacktest,
  useScannerIndex,
} from '../api/queries'
import type { BacktestResult, MlMetrics, MlSnapshot, Trade, YardBook } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { EquityChart } from '../components/charts'
import { DataTable, type Column } from '../components/DataTable'
import { Disclosure } from '../components/Disclosure'
import {
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  ExitReasonPill,
  Loading,
  PageHeader,
  Pill,
  Pnl,
  Section,
  SidePill,
  Stat,
  StatGrid,
  Time,
  ToggleGroup,
} from '../components/kit'
import { BookChip } from '../components/kit/books'
import { aucEvidence, mlState } from '../lib/mlPresentation'

import { fmtInt, fmtPct, fmtPrice, fmtProfitFactor, fmtR } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'
import '../styles/pages/lab.css'

/** One backtest made on this page since it was opened. The server keeps only the newest result per cell, not a history. */
interface SessionRun {
  key: number
  scannerId: string
  scannerName: string
  symbol: string
  tf: string
  at: number
  trades: number
  winRatePct: number | null
  profitFactor: number | null
  pnl: number | null
}

const R = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`
const prob = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : fmtPct(v * 100))
const tone = (v: number) => (v >= 0 ? 'gain' : 'loss')

export function Lab() {
  const { hash } = useLocation()
  const [runs, setRuns] = useState<SessionRun[]>([])

  // links arrive as /lab#ml; the router does not scroll to a hash by itself
  useEffect(() => {
    if (!hash) return
    const t = window.setTimeout(
      () => document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }),
      80,
    )
    return () => window.clearTimeout(t)
  }, [hash])

  return (
    <div className="page lab-page">
      <PageHeader
        title="Lab"
        subtitle="Backtest and train here. Backtests are simulations. Retraining changes future ML predictions; configured gates and risk rules remain in force."
        actions={
          <nav className="lab-jump" aria-label="Lab sections">
            <a href="#backtest" className="lab-jump-link">
              Backtest
            </a>
            <a href="#ml" className="lab-jump-link lab-jump-ml">
              ML workbench
            </a>
            <a href="#runs" className="lab-jump-link">
              Runs
            </a>
          </nav>
        }
      />
      <BacktestSection onRun={(r) => setRuns((l) => [r, ...l].slice(0, 20))} />
      <MlSection />
      <RunsSection runs={runs} />
      <p className="lab-links small muted">
        Per-scanner models and the go-live rule live on{' '}
        <Link to="/learn" className="link">
          Learn
        </Link>
        . A strategy that passes here goes to{' '}
        <Link to="/strategies" className="link">
          Strategies
        </Link>{' '}
        to start in shadow.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Backtest
// ---------------------------------------------------------------------------------------------------------------

function BacktestSection({ onRun }: { onRun: (r: SessionRun) => void }) {
  const index = useScannerIndex()
  const config = useConfig()
  const markets = useMarkets()
  const auth = useAuth()
  const toast = useToast()
  const [params] = useSearchParams()
  const runBt = useRunBacktest()

  const [filter, setFilter] = useState('')
  const [scannerSel, setScanner] = useState(() => params.get('scanner') ?? '')
  const [symbolSel, setSymbol] = useState('')
  const [tfSel, setTf] = useState('')

  const runnable = useMemo(
    () => (index.data ?? []).filter((s) => s.status === 'ok' && !s.hidden),
    [index.data],
  )
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? runnable.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
      : runnable
    const cut = list.slice(0, 250)
    const sel = runnable.find((s) => s.id === scannerSel)
    return sel && !cut.some((s) => s.id === sel.id) ? [sel, ...cut] : cut
  }, [runnable, filter, scannerSel])
  const scanner = runnable.find((s) => s.id === scannerSel)

  const symbols = useMemo(() => {
    const own = config.data?.resolvedSymbols?.length
      ? config.data.resolvedSymbols
      : (config.data?.symbols ?? [])
    return own.length ? own : (markets.data ?? []).map((m) => m.symbol).slice(0, 20)
  }, [config.data, markets.data])
  const symbol = symbolSel || symbols[0] || ''
  const tf = tfSel || config.data?.timeframes?.[0] || '15m'

  const stored = useBacktest(scanner?.id, symbol, tf)
  // a result from this page's own run wins while it still matches the form; otherwise the stored one for the cell
  const ranHere =
    runBt.data &&
    runBt.variables?.scanner === scanner?.id &&
    runBt.variables.symbol === symbol &&
    runBt.variables.tf === tf
  const result: BacktestResult | undefined = ranHere ? runBt.data : stored.data?.at ? stored.data : undefined
  const tick = markets.data?.find((m) => m.symbol === symbol)?.tickSize

  const canRun = auth.can('backtest')
  const disabled = !scanner || !symbol || !tf || runBt.isPending || !canRun

  const run = () => {
    if (!scanner) return
    runBt.mutate(
      { scanner: scanner.id, symbol, tf },
      {
        onSuccess: (r) => {
          toast.success('Backtest complete', `${r.trades?.length ?? 0} trades over ${r.bars} bars`)
          onRun({
            key: Date.now(),
            scannerId: scanner.id,
            scannerName: scanner.name,
            symbol,
            tf,
            at: r.at,
            trades: r.trades?.length ?? Number(r.stats?.trades ?? 0),
            winRatePct: num(r.stats?.winRatePct),
            profitFactor: num(r.stats?.profitFactor),
            pnl: num(r.stats?.pnl),
          })
        },
        onError: (e) => toast.error('Backtest failed', e.message),
      },
    )
  }

  return (
    <section id="backtest" className="lab-sec lab-sec-backtest" aria-labelledby="lab-bt-h">
      <div className="lab-sec-head">
        <h2 id="lab-bt-h" className="lab-sec-title">
          Backtest
        </h2>
        <BookChip book="backtest" />
        <span className="lab-sec-hint">
          Replay one script on one market and timeframe, with the bot&apos;s standard policy.
        </span>
      </div>
      <div className="lab-bt">
        <form
          className="lab-form"
          aria-label="New backtest"
          onSubmit={(e) => {
            e.preventDefault()
            if (!disabled) run()
          }}
        >
          <h3 className="lab-card-title">New backtest</h3>
          <div className="field">
            <label className="field-label" htmlFor="lab-scanner-filter">
              Scanner
            </label>
            <input
              id="lab-scanner-filter"
              className="input"
              type="search"
              placeholder={
                index.isLoading ? 'Loading scanners…' : `Filter ${fmtInt(runnable.length)} runnable scanners`
              }
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoComplete="off"
            />
            <select
              className="select"
              aria-label="Scanner"
              value={scannerSel}
              onChange={(e) => setScanner(e.target.value)}
              disabled={!shown.length && !scannerSel}
            >
              <option value="">
                {shown.length
                  ? 'Choose a scanner'
                  : index.isLoading
                    ? 'Loading…'
                    : 'No runnable scanner matches'}
              </option>
              {shown.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {runnable.length > shown.length && (
              <span className="lab-note">Showing the first {shown.length}: type to narrow.</span>
            )}
          </div>
          <div className="lab-form-row">
            <div className="field">
              <label className="field-label" htmlFor="lab-symbol">
                Market
              </label>
              <select
                id="lab-symbol"
                className="select"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={!symbols.length}
              >
                {symbols.length ? (
                  symbols.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))
                ) : (
                  <option value="">No markets</option>
                )}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="lab-tf">
                Timeframe
              </label>
              <select id="lab-tf" className="select" value={tf} onChange={(e) => setTf(e.target.value)}>
                {DELTA_TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="lab-costs">
            <b>Costs are charged as the backtest engine does today.</b>
            <span>
              The engine applies product-specific maker/taker fees and tax when available, otherwise
              configured fallbacks. Current product rates are a cost scenario, not historical fee
              reconstruction. Funding needs recorded settlements; spread and depth depend on data coverage.
            </span>
          </div>
          <button
            type="submit"
            className="btn btn-cta lab-run"
            disabled={disabled}
            title={
              !canRun ? 'Your role cannot run backtests' : !scanner ? 'Choose a scanner first' : undefined
            }
          >
            {runBt.isPending ? 'Running…' : 'Run backtest'}
          </button>
          {!canRun && (
            <span className="lab-note">Your account can look at results but not run a backtest.</span>
          )}
          <span className="lab-note">
            A run replaces the stored result for this scanner, market and timeframe. It places no order.
          </span>
        </form>

        <div className="lab-bt-main">
          <Callout tone="info" title="Backtest policy">
            This form runs the selected scanner under the configured backtest policy. Separate native-exit and
            execution comparisons are recorded as shadow research plans; they do not automatically change
            account exits. <Link to="/incubator">Review research plans</Link>.
          </Callout>
          <BacktestResultPanel
            scannerName={scanner?.name}
            symbol={symbol}
            tf={tf}
            chosen={!!scanner}
            result={result}
            loading={!!scanner && stored.isLoading && !result}
            pending={runBt.isPending}
            error={stored.isError && !result ? stored.error : null}
            tick={tick}
          />
        </div>
      </div>
    </section>
  )
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function BacktestResultPanel({
  scannerName,
  symbol,
  tf,
  chosen,
  result,
  loading,
  pending,
  error,
  tick,
}: {
  scannerName?: string
  symbol: string
  tf: string
  chosen: boolean
  result?: BacktestResult
  loading: boolean
  pending: boolean
  error: Error | null
  tick?: number
}) {
  const cols = useMemo<Column<Trade>[]>(
    () => [
      {
        key: 'exitAt',
        header: 'Closed',
        value: (t) => t.exitAt,
        render: (t) => <Time t={t.exitAt} mode="datetime" className="small muted" />,
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
      {
        key: 'pnl',
        header: 'Net PnL',
        numeric: true,
        value: (t) => t.pnl,
        render: (t) => <Pnl value={t.pnl} />,
      },
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
        header: 'Exit',
        value: (t) => t.exitReason,
        render: (t) => <ExitReasonPill reason={t.exitReason} />,
      },
    ],
    [tick],
  )

  const title = scannerName ? `${scannerName} · ${symbol} ${tf}` : 'Result'
  return (
    <Section
      variant="panel"
      title={<span className="lab-result-title">{title}</span>}
      actions={
        result ? (
          <span className="muted small">
            Run <Time t={result.at} mode="ago" />
          </span>
        ) : undefined
      }
    >
      {error && <ErrorState error={error} label="Could not load the stored result" />}
      {!error && (pending || loading) && <Loading rows={4} />}
      {!error && !pending && !loading && !chosen && (
        <EmptyState
          title="Choose a scanner to begin."
          hint="The result appears here, with the equity curve and every trade it made."
        />
      )}
      {!error && !pending && !loading && chosen && !result && (
        <EmptyState
          title={`No stored backtest for ${symbol} ${tf}.`}
          hint="Run one from the form. Nothing is stored until you do."
        />
      )}
      {!error && !pending && result && <ResultBody result={result} tick={tick} cols={cols} />}
    </Section>
  )
}

function ResultBody({ result, cols }: { result: BacktestResult; tick?: number; cols: Column<Trade>[] }) {
  const s = result.stats ?? {}
  const trades = result.trades ?? []
  const pnl = num(s.pnl)
  return (
    <div className="lab-result">
      {result.researchStatus === 'historical' && (
        <p className="muted" role="status">
          Historical research: this result is not verified against the current source, reader, policy and
          market costs. It is excluded from automatic tuning. Run a new backtest to refresh it.
        </p>
      )}
      <StatGrid min={130}>
        <Stat label="Trades" value={fmtInt(trades.length)} sub={`over ${fmtInt(result.bars)} bars`} />
        <Stat label="Win rate" value={num(s.winRatePct) === null ? '–' : fmtPct(num(s.winRatePct))} />
        <Stat
          label="Profit factor"
          value={num(s.profitFactor) === null ? '–' : fmtProfitFactor(num(s.profitFactor))}
        />
        <Stat
          label="Net"
          value={pnl === null ? '–' : <Pnl value={pnl} />}
          sub="after fees and slippage"
          tone={pnl === null ? undefined : pnl >= 0 ? 'gain' : 'loss'}
        />
        <Stat
          label="Max drawdown"
          value={num(s.maxDrawdownPct) === null ? '–' : fmtPct(num(s.maxDrawdownPct))}
        />
      </StatGrid>
      {result.equity?.length > 1 ? (
        <EquityChart
          data={result.equity.map((e) => ({ at: e.at, equity: e.equity, realized: 0, unrealized: 0 }))}
          height={170}
        />
      ) : (
        <p className="small muted">Too few closed trades to draw an equity curve.</p>
      )}
      <DataTable
        columns={cols}
        rows={trades}
        rowKey={(t) => t.id ?? `${t.positionId}-${t.exitAt}`}
        defaultSort={{ key: 'exitAt', dir: 'desc' }}
        emptyLabel="This run made no trades."
        maxHeight={300}
        caption="Backtest trades"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// ML workbench
// ---------------------------------------------------------------------------------------------------------------

function MlSection() {
  const ml = useMl()
  const auth = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [confirm, setConfirm] = useState(false)
  const train = useMutation({
    mutationFn: () => api.mlTrain(),
    onSuccess: (s: MlSnapshot) => {
      void qc.invalidateQueries({ queryKey: ['ml'] })
      setConfirm(false)
      toast.success('Models trained', `${s.samples} samples · ${s.scannersWithModel} scanner models`)
    },
    onError: (e) => {
      setConfirm(false)
      toast.error('Training failed', (e as Error).message)
    },
  })
  const d = ml.data
  const model = d?.global?.model ?? null
  const total = d ? (d.counts?.total ?? d.samples) : 0
  const canTrain = auth.canTrade && !!d && total >= 30
  const state = mlState(ml.isError ? undefined : d?.config)

  return (
    <section id="ml" className="lab-sec lab-sec-ml" aria-labelledby="lab-ml-h">
      <div className="lab-sec-head">
        <h2 id="lab-ml-h" className="lab-sec-title lab-ml-title">
          ML workbench
        </h2>
        <Pill tone="accent">{state.label}</Pill>
        <span className="lab-grow" />
        <button
          type="button"
          className="btn btn-cta"
          onClick={() => setConfirm(true)}
          disabled={!canTrain || train.isPending}
          title={
            !auth.canTrade
              ? 'Training needs trade permission'
              : !d
                ? undefined
                : total < 30
                  ? 'Needs at least 30 stored samples'
                  : 'Models also retrain by themselves within two minutes after new samples arrive'
          }
        >
          {train.isPending ? 'Training…' : 'Train now'}
        </button>
      </div>
      <p className="lab-sec-lede">
        {state.detail} Training replaces models used for future predictions; it does not automatically change
        gate or risk settings.
      </p>

      {ml.isLoading && !d && <Loading kind="cards" rows={3} />}
      {ml.isError && !d && <ErrorState error={ml.error} onRetry={() => ml.refetch()} />}
      {d && (
        <>
          <div className="lab-ml-grid">
            <ModelCard d={d} model={model} />
            <Reach model={model} />
          </div>
          <Calibration />
          <Importance items={d.global?.importance ?? []} />
          {!!d.global?.rules?.length && (
            <Disclosure
              id="ml-rules"
              title="Rules the model found"
              hint={` ${d.global.rules.length} rules over every stored trade`}
            >
              <ul className="lab-rules">
                {d.global.rules.map((r) => (
                  <li key={`${r.feature}-${r.condition}`}>
                    <Pill tone={r.kind === 'prefer' ? 'ok' : 'danger'}>{r.kind}</Pill>
                    <span className="lab-rule-text">
                      {r.label} {r.condition}
                    </span>
                    <span className="muted small mono">
                      {fmtInt(r.n)} trades · {prob(r.winRate)} won · {R(r.avgR)} vs {R(r.baselineAvgR)}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        title="Train the model now?"
        body={
          <>
            This retrains the model on the {fmtInt(total)} stored trades. It changes no trade by itself: the
            model only matters where &ldquo;use as score&rdquo; or the gate is set in Settings. Models retrain
            on their own within two minutes of new samples, so this only saves the wait.
          </>
        }
        confirmLabel="Train now"
        busy={train.isPending}
        onConfirm={() => train.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </section>
  )
}

function ModelCard({ d, model }: { d: MlSnapshot; model: MlMetrics | null }) {
  const eco = model?.economic
  const rows: Array<[string, React.ReactNode]> = [
    [
      'Trained',
      d.trainedAt ? (
        <>
          <Time t={d.trainedAt} mode="ago" />{' '}
          <span className="muted small">
            (<Time t={d.trainedAt} mode="datetime" />)
          </span>
        </>
      ) : (
        'never'
      ),
    ],
    [
      'Samples',
      <>
        {fmtInt(d.samples)}{' '}
        <span className="muted small">
          · {fmtInt(d.liveSamples)} from accounts, {fmtInt(d.samples - d.liveSamples)} from backtests
        </span>
      </>,
    ],
    ...(d.eligibility
      ? [
          [
            'Eligible',
            <>
              {fmtInt(d.eligibility.eligible)} of {fmtInt(d.eligibility.stored)} stored{' '}
              <span className="muted small">
                · {fmtInt(d.eligibility.excluded)} excluded or past the training limit
              </span>
            </>,
          ] as [string, React.ReactNode],
        ]
      : []),
    [
      'Scanner models',
      <>
        {fmtInt(d.scannersWithModel)} <span className="muted small">scanners with enough trades</span>
      </>,
    ],
    ...(model
      ? [
          [
            'Held out',
            <>
              {fmtInt(model.holdout)} trades{' '}
              <span className="muted small">
                · accuracy {prob(model.accuracy)} vs {prob(model.baseWinRate)} base win rate
              </span>
            </>,
          ] as [string, React.ReactNode],
        ]
      : []),
    ...(eco
      ? [
          [
            'Held-out net R',
            <>
              <span className={tone(eco.testNetR)}>{R(eco.testNetR)}</span>{' '}
              <span className="muted small">
                · at {prob(eco.threshold)}: keeps {fmtInt(eco.selectedN)} for {R(eco.selectedNetR)}, drops the
                rest for {R(eco.rejectedNetR)}
              </span>
            </>,
          ] as [string, React.ReactNode],
        ]
      : []),
    ['Settings', mlState(d.config).label],
  ]
  return (
    <div className="lab-card">
      <h3 className="lab-card-title">
        Model card <span className="lab-card-sub">global model, every scanner</span>
      </h3>
      {model ? null : <p className="small muted">No global model has been trained yet.</p>}
      <dl className="lab-dl">
        {rows.map(([k, val]) => (
          <div key={k} className="lab-dl-row">
            <dt>{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Reach({ model }: { model: MlMetrics | null }) {
  return (
    <div className="lab-card">
      <h3 className="lab-card-title">Evaluation limits</h3>
      <div className="lab-auc">
        <span className="lab-auc-num mono">{model ? model.auc.toFixed(2) : '–'}</span>
        <span className="lab-auc-label">Held-out ranking AUC</span>
      </div>
      <p className="lab-note">
        {aucEvidence(model?.auc)} Training, calibration and testing use separate chronological partitions; the
        test period is not necessarily whole weeks.
      </p>
      <p className="lab-note">
        There are no automatic Advise, Size or Gate tiers at 0.55, 0.58 or 0.62 AUC. Gate and score are
        independent configuration switches. A threshold selected from past trades requires a new frozen
        forward evaluation before use.
      </p>
    </div>
  )
}

function Calibration() {
  const q = useMlYardstick(60)
  const [book, setBook] = useState<'shadow' | 'live'>('shadow')
  const y = q.data
  return (
    <div className="lab-card lab-wide">
      <h3 className="lab-card-title">
        Calibration <span className="lab-card-sub">predicted score band, then what actually happened</span>
      </h3>
      {q.isLoading && !y && <Loading rows={4} />}
      {q.isError && !y && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {y &&
        (() => {
          const b: YardBook = y[book]
          const buckets = b.buckets
          return (
            <>
              <div className="lab-cal-bar">
                <ToggleGroup
                  ariaLabel="Book"
                  value={book}
                  onChange={(x) => setBook(x as 'shadow' | 'live')}
                  options={[
                    { value: 'shadow', label: `Shadow · ${fmtInt(y.shadow.trades)} trades` },
                    { value: 'live', label: `Account · ${fmtInt(y.live.trades)} trades` },
                  ]}
                />
                <span className="muted small">
                  last {y.windowDays} days · {fmtInt(b.scoredAtEntry)} with a saved entry score · ranking AUC{' '}
                  {b.auc?.toFixed(2) ?? '–'}
                </span>
              </div>
              {b.scoredAtEntry === 0 ? (
                <EmptyState
                  title="No trade here carries a saved entry score."
                  hint="The table fills as scored trades close."
                />
              ) : (
                <div className="lab-cal">
                  <div className="lab-table-wrap">
                    <table className="table small">
                      <thead>
                        <tr>
                          <th>Predicted P(win)</th>
                          <th className="num">Trades</th>
                          <th className="lab-bar-col">Share that won</th>
                          <th className="num">Avg R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {buckets.map((x) => (
                          <tr key={x.label}>
                            <td className="mono">{x.label}</td>
                            <td className="num">{fmtInt(x.n)}</td>
                            <td className="lab-bar-col">
                              {x.n ? (
                                <span className="lab-hbar" title={`${fmtPct(x.winRatePct)} won`}>
                                  <span
                                    className="lab-hbar-fill lab-ml-fill"
                                    style={{ width: `${Math.min(100, Math.max(0, x.winRatePct))}%` }}
                                  />
                                  <span className="mono small lab-hbar-val">{fmtPct(x.winRatePct)}</span>
                                </span>
                              ) : (
                                <span className="muted">–</span>
                              )}
                            </td>
                            <td className={`num ${x.n ? tone(x.avgR) : ''}`}>{x.n ? R(x.avgR) : '–'}</td>
                          </tr>
                        ))}
                        <tr>
                          <td className="muted">All</td>
                          <td className="num">{fmtInt(b.trades)}</td>
                          <td />
                          <td className={`num ${tone(b.allAvgR)}`}>{R(b.allAvgR)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="lab-table-wrap">
                    <table className="table small">
                      <thead>
                        <tr>
                          <th>Gate at</th>
                          <th className="num">Kept</th>
                          <th className="num">Kept avg R</th>
                          <th className="num">Dropped</th>
                          <th className="num">Dropped avg R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.thresholds.map((x) => (
                          <tr key={x.minProb}>
                            <td className="mono">{prob(x.minProb)}</td>
                            <td className="num">{fmtInt(x.kept)}</td>
                            <td className={`num ${tone(x.keptAvgR)}`}>{R(x.keptAvgR)}</td>
                            <td className="num">{fmtInt(x.dropped)}</td>
                            <td className={`num ${x.dropped ? tone(x.droppedAvgR) : ''}`}>
                              {x.dropped ? R(x.droppedAvgR) : '–'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <p className="lab-note">
                The tables describe saved entry scores. The research-candidate verdict below uses only
                verified model, feature, training-cutoff and policy receipts: {fmtInt(b.verifiedAtEntry ?? 0)}{' '}
                in this book. Unverified scores do not count toward that verdict.
              </p>
              <div className="lab-call">
                <b>Verified-entry evaluation:</b> <span>{y.call.text}</span>
              </div>
              <p className="lab-note">
                Built from the model score saved when each trade opened. A threshold read off this table still
                needs a forward test before it is used.
              </p>
            </>
          )
        })()}
    </div>
  )
}

function Importance({ items }: { items: Array<{ feature: string; label: string; weight: number }> }) {
  if (!items.length) return null
  const top = items.slice(0, 8)
  const max = Math.max(...items.map((i) => Math.abs(i.weight)))
  const small = max < 0.1
  return (
    <div className="lab-card lab-wide">
      <h3 className="lab-card-title">
        What the model looks at{' '}
        <span className="lab-card-sub">
          the {top.length} largest of {items.length} inputs, by size of weight
        </span>
      </h3>
      <div className="lab-imp">
        {top.map((i) => (
          <div key={i.feature} className="lab-imp-row">
            <span className="lab-imp-label">{i.label}</span>
            <span className="lab-hbar" aria-hidden>
              <span
                className="lab-hbar-fill lab-ml-fill"
                style={{ width: `${max > 0 ? (Math.abs(i.weight) / max) * 100 : 0}%` }}
              />
            </span>
            <span className="mono small lab-imp-val">
              {i.weight >= 0 ? '+' : '−'}
              {Math.abs(i.weight).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
      <p className="lab-note">
        {small ? (
          <>
            The largest weight is only {max.toFixed(2)}, so no single input separates winners from losers.
            Weights are signed and measured on standardised inputs.
          </>
        ) : (
          <>
            The largest weight is {max.toFixed(2)} ({items.find((i) => Math.abs(i.weight) === max)?.label}). A
            weight shows what the model leans on, not that it predicts well: check the AUC above. Weights are
            signed and measured on standardised inputs.
          </>
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------

function RunsSection({ runs }: { runs: SessionRun[] }) {
  return (
    <section id="runs" className="lab-sec" aria-labelledby="lab-runs-h">
      <Section
        title={<span id="lab-runs-h">Runs on this page</span>}
        hint="The server keeps only the newest backtest per scanner, market and timeframe, so this list holds the runs made here since the page was opened."
      >
        {runs.length === 0 ? (
          <EmptyState title="No backtest run on this page yet." hint="Run one above and it is listed here." />
        ) : (
          <div className="lab-table-wrap">
            <table className="table small">
              <thead>
                <tr>
                  <th>Scanner</th>
                  <th>Market</th>
                  <th className="num">Trades</th>
                  <th className="num">Win rate</th>
                  <th className="num">Profit factor</th>
                  <th className="num">Net</th>
                  <th className="num">Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <Link to={`/scanners/${r.scannerId}`} className="strong">
                        {r.scannerName}
                      </Link>
                    </td>
                    <td className="mono">
                      {r.symbol} {r.tf}
                    </td>
                    <td className="num">{fmtInt(r.trades)}</td>
                    <td className="num">{r.winRatePct === null ? '–' : fmtPct(r.winRatePct)}</td>
                    <td className="num">{r.profitFactor === null ? '–' : fmtProfitFactor(r.profitFactor)}</td>
                    <td className="num">{r.pnl === null ? '–' : <Pnl value={r.pnl} />}</td>
                    <td className="num muted">
                      <Time t={r.at} mode="ago" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </section>
  )
}
