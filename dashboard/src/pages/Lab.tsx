import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useBacktest, useConfig, useMarkets, useMl, useMlYardstick, useRunBacktest, useScannerIndex } from '../api/queries'
import type { BacktestResult, MlMetrics, MlSnapshot, Trade, YardBook } from '../api/types'
import { useAuth } from '../auth/AuthGate'
import { EquityChart } from '../components/charts'
import { DataTable, type Column } from '../components/DataTable'
import { Disclosure } from '../components/Disclosure'
import { BookChip } from '../components/kit/books'
import { Callout, EmptyState, PageHeader, Section, Stat, StatGrid } from '../components/kit'
import { ConfirmDialog, ErrorState, ExitReasonPill, Loading, Panel, Pill, Pnl, Segmented, SidePill, Time } from '../components/ui'
import { fmtInt, fmtPct, fmtPrice, fmtProfitFactor, fmtR } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'
import '../styles/pages/lab.css'

/** One backtest made on this page since it was opened. The server keeps only the newest result per cell, not a history. */
interface SessionRun { key: number; scannerId: string; scannerName: string; symbol: string; tf: string; at: number; trades: number; winRatePct: number | null; profitFactor: number | null; pnl: number | null }

/** The proposed rule for this redesign: how good the model must be, on weeks it never saw, before it may do each job. */
const PROPOSED_MODES = [
  { id: 'off', name: 'Off', what: 'Every signal at full size', auc: 0 },
  { id: 'advise', name: 'Advise', what: 'Shows a score; changes nothing', auc: 0.55 },
  { id: 'size', name: 'Size', what: 'Scales size with confidence, never above the cap', auc: 0.58 },
  { id: 'gate', name: 'Gate', what: 'Skips signals it expects to lose', auc: 0.62 },
] as const

const R = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`)
const prob = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : fmtPct(v * 100))
const tone = (v: number) => (v >= 0 ? 'gain' : 'loss')

export function Lab() {
  const { hash } = useLocation()
  const [runs, setRuns] = useState<SessionRun[]>([])

  // links arrive as /lab#ml; the router does not scroll to a hash by itself
  useEffect(() => {
    if (!hash) return
    const t = window.setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' }), 80)
    return () => window.clearTimeout(t)
  }, [hash])

  return (
    <div className="page lab-page">
      <PageHeader
        title="Lab"
        subtitle="Backtest and train here. Nothing in the Lab can trade: a result matters only when it climbs the ladder from backtest to shadow to paper to live."
        actions={
          <nav className="lab-jump" aria-label="Lab sections">
            <a href="#backtest" className="lab-jump-link">Backtest</a>
            <a href="#ml" className="lab-jump-link lab-jump-ml">ML workbench</a>
            <a href="#runs" className="lab-jump-link">Runs</a>
          </nav>
        }
      />
      <BacktestSection onRun={(r) => setRuns((l) => [r, ...l].slice(0, 20))} />
      <MlSection />
      <RunsSection runs={runs} />
      <p className="lab-links small muted">
        Per-scanner models and the go-live rule live on <Link to="/learn" className="link">Learn</Link>. A strategy that passes here goes to <Link to="/strategies" className="link">Strategies</Link> to start in shadow.
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

  const runnable = useMemo(() => (index.data ?? []).filter((s) => s.status === 'ok' && !s.hidden), [index.data])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? runnable.filter((s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : runnable
    const cut = list.slice(0, 250)
    const sel = runnable.find((s) => s.id === scannerSel)
    return sel && !cut.some((s) => s.id === sel.id) ? [sel, ...cut] : cut
  }, [runnable, filter, scannerSel])
  const scanner = runnable.find((s) => s.id === scannerSel)

  const symbols = useMemo(() => {
    const own = config.data?.resolvedSymbols?.length ? config.data.resolvedSymbols : (config.data?.symbols ?? [])
    return own.length ? own : (markets.data ?? []).map((m) => m.symbol).slice(0, 20)
  }, [config.data, markets.data])
  const symbol = symbolSel || symbols[0] || ''
  const tf = tfSel || config.data?.timeframes?.[0] || '15m'

  const stored = useBacktest(scanner?.id, symbol, tf)
  // a result from this page's own run wins while it still matches the form; otherwise the stored one for the cell
  const ranHere = runBt.data && runBt.variables?.scanner === scanner?.id && runBt.variables.symbol === symbol && runBt.variables.tf === tf
  const result: BacktestResult | undefined = ranHere ? runBt.data : stored.data?.at ? stored.data : undefined
  const tick = markets.data?.find((m) => m.symbol === symbol)?.tickSize

  const canRun = auth.can('backtest')
  const disabled = !scanner || !symbol || !tf || runBt.isPending || !canRun
  const paper = config.data?.paper
  const fee = paper ? `${paper.feeRatePct}%${paper.feeTaxPct ? ` plus ${paper.feeTaxPct}% tax` : ''}` : null

  const run = () => {
    if (!scanner) return
    runBt.mutate(
      { scanner: scanner.id, symbol, tf },
      {
        onSuccess: (r) => {
          toast.success('Backtest complete', `${r.trades?.length ?? 0} trades over ${r.bars} bars`)
          onRun({ key: Date.now(), scannerId: scanner.id, scannerName: scanner.name, symbol, tf, at: r.at, trades: r.trades?.length ?? Number(r.stats?.trades ?? 0), winRatePct: num(r.stats?.winRatePct), profitFactor: num(r.stats?.profitFactor), pnl: num(r.stats?.pnl) })
        },
        onError: (e) => toast.error('Backtest failed', e.message),
      },
    )
  }

  return (
    <section id="backtest" className="lab-sec lab-sec-backtest" aria-labelledby="lab-bt-h">
      <div className="lab-sec-head">
        <h2 id="lab-bt-h" className="lab-sec-title">Backtest</h2>
        <BookChip book="backtest" />
        <span className="lab-sec-hint">Replay one script on one market and timeframe, with the bot&apos;s standard policy.</span>
      </div>
      <div className="lab-bt">
        <form className="lab-form" aria-label="New backtest" onSubmit={(e) => { e.preventDefault(); if (!disabled) run() }}>
          <h3 className="lab-card-title">New backtest</h3>
          <div className="field">
            <label className="field-label" htmlFor="lab-scanner-filter">Scanner</label>
            <input id="lab-scanner-filter" className="input" type="search" placeholder={index.isLoading ? 'Loading scanners…' : `Filter ${fmtInt(runnable.length)} runnable scanners`} value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" />
            <select className="select" aria-label="Scanner" value={scannerSel} onChange={(e) => setScanner(e.target.value)} disabled={!shown.length && !scannerSel}>
              <option value="">{shown.length ? 'Choose a scanner' : index.isLoading ? 'Loading…' : 'No runnable scanner matches'}</option>
              {shown.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {runnable.length > shown.length && <span className="lab-note">Showing the first {shown.length}: type to narrow.</span>}
          </div>
          <div className="lab-form-row">
            <div className="field">
              <label className="field-label" htmlFor="lab-symbol">Market</label>
              <select id="lab-symbol" className="select" value={symbol} onChange={(e) => setSymbol(e.target.value)} disabled={!symbols.length}>
                {symbols.length ? symbols.map((s) => <option key={s} value={s}>{s}</option>) : <option value="">No markets</option>}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="lab-tf">Timeframe</label>
              <select id="lab-tf" className="select" value={tf} onChange={(e) => setTf(e.target.value)}>
                {DELTA_TIMEFRAMES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="lab-costs">
            <b>Costs are charged as the backtest engine does today.</b>
            <span>{fee ? <>Every fill pays the paper account&apos;s commission ({fee}) and slippage ({paper?.slippageBps} bps, or the book&apos;s observed crossing when it is known); funding is not modelled.</> : 'Every fill pays the paper account’s commission and tax and slippage; funding is not modelled.'}</span>
          </div>
          <button type="submit" className="btn btn-cta lab-run" disabled={disabled} title={!canRun ? 'Your role cannot run backtests' : !scanner ? 'Choose a scanner first' : undefined}>
            {runBt.isPending ? 'Running…' : 'Run backtest'}
          </button>
          {!canRun && <span className="lab-note">Your account can look at results but not run a backtest.</span>}
          <span className="lab-note">A run replaces the stored result for this scanner, market and timeframe. It places no order.</span>
        </form>

        <div className="lab-bt-main">
          <Callout tone="info" title="Planned">
            Run a strategy with its own exits and stress-test it. Today the Lab runs the bot&apos;s standard backtest. The design is in <span className="mono">docs/research/script-perspective-2026-11-14/README.md</span>.
          </Callout>
          <BacktestResultPanel scannerName={scanner?.name} symbol={symbol} tf={tf} chosen={!!scanner} result={result} loading={!!scanner && stored.isLoading && !result} pending={runBt.isPending} error={stored.isError && !result ? stored.error : null} tick={tick} />
        </div>
      </div>
    </section>
  )
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function BacktestResultPanel({ scannerName, symbol, tf, chosen, result, loading, pending, error, tick }: { scannerName?: string; symbol: string; tf: string; chosen: boolean; result?: BacktestResult; loading: boolean; pending: boolean; error: Error | null; tick?: number }) {
  const cols = useMemo<Column<Trade>[]>(() => [
    { key: 'exitAt', header: 'Closed', value: (t) => t.exitAt, render: (t) => <Time t={t.exitAt} mode="datetime" className="small muted" /> },
    { key: 'side', header: 'Side', value: (t) => t.side, render: (t) => <SidePill side={t.side} /> },
    { key: 'entry', header: 'Entry', numeric: true, value: (t) => t.entryPrice, render: (t) => fmtPrice(t.entryPrice, tick) },
    { key: 'exit', header: 'Exit', numeric: true, value: (t) => t.exitPrice, render: (t) => fmtPrice(t.exitPrice, tick) },
    { key: 'pnl', header: 'Net PnL', numeric: true, value: (t) => t.pnl, render: (t) => <Pnl value={t.pnl} /> },
    { key: 'r', header: 'R', numeric: true, value: (t) => t.rMultiple, render: (t) => <span className={t.rMultiple >= 0 ? 'gain' : 'loss'}>{fmtR(t.rMultiple)}</span> },
    { key: 'reason', header: 'Exit', value: (t) => t.exitReason, render: (t) => <ExitReasonPill reason={t.exitReason} /> },
  ], [tick])

  const title = scannerName ? `${scannerName} · ${symbol} ${tf}` : 'Result'
  return (
    <Panel title={<span className="lab-result-title">{title}</span>} right={result ? <span className="muted small">Run <Time t={result.at} mode="ago" /></span> : undefined}>
      {error && <ErrorState error={error} label="Could not load the stored result" />}
      {!error && (pending || loading) && <Loading rows={4} />}
      {!error && !pending && !loading && !chosen && <EmptyState title="Choose a scanner to begin." hint="The result appears here, with the equity curve and every trade it made." />}
      {!error && !pending && !loading && chosen && !result && <EmptyState title={`No stored backtest for ${symbol} ${tf}.`} hint="Run one from the form. Nothing is stored until you do." />}
      {!error && !pending && result && <ResultBody result={result} tick={tick} cols={cols} />}
    </Panel>
  )
}

function ResultBody({ result, cols }: { result: BacktestResult; tick?: number; cols: Column<Trade>[] }) {
  const s = result.stats ?? {}
  const trades = result.trades ?? []
  const pnl = num(s.pnl)
  return (
    <div className="lab-result">
      <StatGrid min={130}>
        <Stat label="Trades" value={fmtInt(trades.length)} sub={`over ${fmtInt(result.bars)} bars`} />
        <Stat label="Win rate" value={num(s.winRatePct) === null ? '–' : fmtPct(num(s.winRatePct))} />
        <Stat label="Profit factor" value={num(s.profitFactor) === null ? '–' : fmtProfitFactor(num(s.profitFactor))} />
        <Stat label="Net" value={pnl === null ? '–' : <Pnl value={pnl} />} sub="after fees and slippage" tone={pnl === null ? undefined : pnl >= 0 ? 'gain' : 'loss'} />
        <Stat label="Max drawdown" value={num(s.maxDrawdownPct) === null ? '–' : fmtPct(num(s.maxDrawdownPct))} />
      </StatGrid>
      {result.equity?.length > 1 ? <EquityChart data={result.equity.map((e) => ({ at: e.at, equity: e.equity, realized: 0, unrealized: 0 }))} height={170} /> : <p className="small muted">Too few closed trades to draw an equity curve.</p>}
      <DataTable columns={cols} rows={trades} rowKey={(t) => t.id ?? `${t.positionId}-${t.exitAt}`} defaultSort={{ key: 'exitAt', dir: 'desc' }} emptyLabel="This run made no trades." maxHeight={300} caption="Backtest trades" />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// ML workbench
// ---------------------------------------------------------------------------------------------------------------

/** The model's headline AUC in plain words. 0.5 is a coin flip. */
function verdict(auc: number | null): { text: string; tone: 'loss' | 'warn' | 'gain' | 'muted'; reached: number } {
  if (auc === null) return { text: 'No model yet', tone: 'muted', reached: -1 }
  const reached = PROPOSED_MODES.reduce((k, m, i) => (auc >= m.auc ? i : k), 0)
  if (reached === 0) return { text: 'No skill yet: a coin flip', tone: 'loss', reached }
  if (reached === 1) return { text: 'Enough to advise, not to size or gate', tone: 'warn', reached }
  if (reached === 2) return { text: 'Enough to size, not to gate', tone: 'warn', reached }
  return { text: 'Enough to gate', tone: 'gain', reached }
}

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
    onError: (e) => { setConfirm(false); toast.error('Training failed', (e as Error).message) },
  })
  const d = ml.data
  const model = d?.global?.model ?? null
  const v = verdict(model ? model.auc : null)
  const gateOn = (d?.config?.minProb ?? 0) > 0
  const scoreOn = !!d?.config?.useAsScore
  const total = d ? (d.counts?.total ?? d.samples) : 0
  const canTrain = auth.canTrade && !!d && total >= 30
  const nowMode = gateOn || scoreOn ? 'gate' : 'off'

  return (
    <section id="ml" className="lab-sec lab-sec-ml" aria-labelledby="lab-ml-h">
      <div className="lab-sec-head">
        <h2 id="lab-ml-h" className="lab-sec-title lab-ml-title">ML workbench</h2>
        <Pill tone="accent">{nowMode === 'off' ? 'Advisor off' : gateOn ? `Gate at ${prob(d?.config?.minProb)}` : 'Score on'}{model && v.reached === 0 ? ' · no skill' : ''}</Pill>
        <span className="lab-grow" />
        <button type="button" className="btn btn-cta" onClick={() => setConfirm(true)} disabled={!canTrain || train.isPending} title={!auth.canTrade ? 'Training needs trade permission' : !d ? undefined : total < 30 ? 'Needs at least 30 stored samples' : 'Models also retrain by themselves within two minutes after new samples arrive'}>
          {train.isPending ? 'Training…' : 'Train now'}
        </button>
      </div>
      <p className="lab-sec-lede">A model may advise, size or gate a trade only after it beats &ldquo;take every signal&rdquo; on weeks it never saw. Nothing below changes a trade until then.</p>

      {ml.isLoading && !d && <Loading kind="cards" rows={3} />}
      {ml.isError && !d && <ErrorState error={ml.error} onRetry={() => ml.refetch()} />}
      {d && (
        <>
          <div className="lab-ml-grid">
            <ModelCard d={d} model={model} />
            <Reach model={model} v={v} nowMode={nowMode} gateOn={gateOn} scoreOn={scoreOn} minProb={d.config?.minProb ?? 0} />
          </div>
          <Calibration />
          <Importance items={d.global?.importance ?? []} />
          {!!d.global?.rules?.length && (
            <Disclosure id="ml-rules" title="Rules the model found" hint={` ${d.global.rules.length} rules over every stored trade`}>
              <ul className="lab-rules">
                {d.global.rules.map((r) => (
                  <li key={`${r.feature}-${r.condition}`}>
                    <Pill tone={r.kind === 'prefer' ? 'ok' : 'danger'}>{r.kind}</Pill>
                    <span className="lab-rule-text">{r.label} {r.condition}</span>
                    <span className="muted small mono">{fmtInt(r.n)} trades · {prob(r.winRate)} won · {R(r.avgR)} vs {R(r.baselineAvgR)}</span>
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
        body={<>This retrains the model on the {fmtInt(total)} stored trades. It changes no trade by itself: the model only matters where &ldquo;use as score&rdquo; or the gate is set in Settings. Models retrain on their own within two minutes of new samples, so this only saves the wait.</>}
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
    ['Trained', d.trainedAt ? <><Time t={d.trainedAt} mode="ago" /> <span className="muted small">(<Time t={d.trainedAt} mode="datetime" />)</span></> : 'never'],
    ['Samples', <>{fmtInt(d.samples)} <span className="muted small">· {fmtInt(d.liveSamples)} from accounts, {fmtInt(d.samples - d.liveSamples)} from backtests</span></>],
    ...(d.eligibility ? [['Eligible', <>{fmtInt(d.eligibility.eligible)} of {fmtInt(d.eligibility.stored)} stored <span className="muted small">· {fmtInt(d.eligibility.excluded)} excluded or past the training limit</span></>] as [string, React.ReactNode]] : []),
    ['Scanner models', <>{fmtInt(d.scannersWithModel)} <span className="muted small">scanners with enough trades</span></>],
    ...(model ? [
      ['Held out', <>{fmtInt(model.holdout)} trades <span className="muted small">· accuracy {prob(model.accuracy)} vs {prob(model.baseWinRate)} base win rate</span></>] as [string, React.ReactNode],
    ] : []),
    ...(eco ? [
      ['Held-out net R', <><span className={tone(eco.testNetR)}>{R(eco.testNetR)}</span> <span className="muted small">· at {prob(eco.threshold)}: keeps {fmtInt(eco.selectedN)} for {R(eco.selectedNetR)}, drops the rest for {R(eco.rejectedNetR)}</span></>] as [string, React.ReactNode],
    ] : []),
    ['Settings', <>gate {d.config && d.config.minProb > 0 ? prob(d.config.minProb) : 'off'} <span className="muted small">· use as score {d.config?.useAsScore ? 'on' : 'off'}</span></>],
  ]
  return (
    <div className="lab-card">
      <h3 className="lab-card-title">Model card <span className="lab-card-sub">global model, every scanner</span></h3>
      {model ? null : <p className="small muted">No global model has been trained yet.</p>}
      <dl className="lab-dl">
        {rows.map(([k, val]) => <div key={k} className="lab-dl-row"><dt>{k}</dt><dd>{val}</dd></div>)}
      </dl>
    </div>
  )
}

function Reach({ model, v, nowMode, gateOn, scoreOn, minProb }: { model: MlMetrics | null; v: ReturnType<typeof verdict>; nowMode: string; gateOn: boolean; scoreOn: boolean; minProb: number }) {
  const lo = 0.4, hi = 0.7
  const at = (x: number) => `${Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100))}%`
  return (
    <div className="lab-card">
      <h3 className="lab-card-title">What it has to reach <span className="lab-proposed">proposed rule</span></h3>
      <div className="lab-auc">
        <span className={`lab-auc-num mono tone-${v.tone}`}>{model ? model.auc.toFixed(2) : '–'}</span>
        <span className="lab-auc-label">AUC on held-out trades<br /><b className={`tone-${v.tone}`}>{v.text}</b></span>
      </div>
      <div className="lab-scale" role="img" aria-label={`AUC ${model ? model.auc.toFixed(2) : 'not available'} on a scale from ${lo} to ${hi}; the proposed bars are 0.55, 0.58 and 0.62`}>
        <span className="lab-scale-fill" style={{ width: model ? at(model.auc) : '0%' }} />
        {PROPOSED_MODES.slice(1).map((m) => <span key={m.id} className="lab-scale-tick" style={{ left: at(m.auc) }} />)}
        <span className="lab-scale-tick lab-scale-coin" style={{ left: at(0.5) }} />
      </div>
      <div className="lab-scale-ends mono"><span>{lo.toFixed(2)}</span><span>0.50 coin flip</span><span>{hi.toFixed(2)}</span></div>
      <ul className="lab-modes">
        {PROPOSED_MODES.map((m, i) => {
          const reached = v.reached >= i && model !== null
          const state = nowMode === m.id ? (m.id === 'gate' && !gateOn && scoreOn ? 'now: score on' : 'now') : m.id === 'off' ? '' : reached ? 'reached' : `needs ${m.auc.toFixed(2)}`
          return (
            <li key={m.id} className={nowMode === m.id ? 'on' : ''}>
              <b>{m.name}</b><span className="lab-mode-what">{m.what}</span><span className={`mono small ${reached && m.id !== 'off' ? 'gain' : 'muted'}`}>{state}</span>
            </li>
          )
        })}
      </ul>
      <p className="lab-note">The 0.55, 0.58 and 0.62 bars are a proposed rule, not a setting. Today the model only acts as a score when &ldquo;use as score&rdquo; is on ({scoreOn ? 'on' : 'off'}), and as a hard gate when the gate is above zero ({gateOn ? prob(minProb) : 'off'}); there is no advise or size mode yet.</p>
    </div>
  )
}

function Calibration() {
  const q = useMlYardstick(60)
  const [book, setBook] = useState<'shadow' | 'live'>('shadow')
  const y = q.data
  return (
    <div className="lab-card lab-wide">
      <h3 className="lab-card-title">Calibration <span className="lab-card-sub">predicted score band, then what actually happened</span></h3>
      {q.isLoading && !y && <Loading rows={4} />}
      {q.isError && !y && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {y && (() => {
        const b: YardBook = y[book]
        const buckets = b.buckets
        return (
          <>
            <div className="lab-cal-bar">
              <Segmented ariaLabel="Book" value={book} onChange={(x) => setBook(x as 'shadow' | 'live')} options={[{ value: 'shadow', label: `Shadow · ${fmtInt(y.shadow.trades)} trades` }, { value: 'live', label: `Account · ${fmtInt(y.live.trades)} trades` }]} />
              <span className="muted small">last {y.windowDays} days · {fmtInt(b.scoredAtEntry)} with a saved entry score · ranking AUC {b.auc?.toFixed(2) ?? '–'}</span>
            </div>
            {b.scoredAtEntry === 0 ? (
              <EmptyState title="No trade here carries a saved entry score." hint="The table fills as scored trades close." />
            ) : (
              <div className="lab-cal">
                <div className="lab-table-wrap">
                  <table className="table small">
                    <thead><tr><th>Predicted P(win)</th><th className="num">Trades</th><th className="lab-bar-col">Share that won</th><th className="num">Avg R</th></tr></thead>
                    <tbody>
                      {buckets.map((x) => (
                        <tr key={x.label}>
                          <td className="mono">{x.label}</td>
                          <td className="num">{fmtInt(x.n)}</td>
                          <td className="lab-bar-col">{x.n ? <span className="lab-hbar" title={`${fmtPct(x.winRatePct)} won`}><span className="lab-hbar-fill lab-ml-fill" style={{ width: `${Math.min(100, Math.max(0, x.winRatePct))}%` }} /><span className="mono small lab-hbar-val">{fmtPct(x.winRatePct)}</span></span> : <span className="muted">–</span>}</td>
                          <td className={`num ${x.n ? tone(x.avgR) : ''}`}>{x.n ? R(x.avgR) : '–'}</td>
                        </tr>
                      ))}
                      <tr><td className="muted">All</td><td className="num">{fmtInt(b.trades)}</td><td /><td className={`num ${tone(b.allAvgR)}`}>{R(b.allAvgR)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="lab-table-wrap">
                  <table className="table small">
                    <thead><tr><th>Gate at</th><th className="num">Kept</th><th className="num">Kept avg R</th><th className="num">Dropped</th><th className="num">Dropped avg R</th></tr></thead>
                    <tbody>
                      {b.thresholds.map((x) => (
                        <tr key={x.minProb}>
                          <td className="mono">{prob(x.minProb)}</td><td className="num">{fmtInt(x.kept)}</td><td className={`num ${tone(x.keptAvgR)}`}>{R(x.keptAvgR)}</td><td className="num">{fmtInt(x.dropped)}</td><td className={`num ${x.dropped ? tone(x.droppedAvgR) : ''}`}>{x.dropped ? R(x.droppedAvgR) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="lab-call"><b>Would the gate have paid?</b> <span>{y.call.text}</span></div>
            <p className="lab-note">Built from the model score saved when each trade opened. A threshold read off this table still needs a forward test before it is used.</p>
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
      <h3 className="lab-card-title">What the model looks at <span className="lab-card-sub">the {top.length} largest of {items.length} inputs, by size of weight</span></h3>
      <div className="lab-imp">
        {top.map((i) => (
          <div key={i.feature} className="lab-imp-row">
            <span className="lab-imp-label">{i.label}</span>
            <span className="lab-hbar" aria-hidden><span className="lab-hbar-fill lab-ml-fill" style={{ width: `${max > 0 ? (Math.abs(i.weight) / max) * 100 : 0}%` }} /></span>
            <span className="mono small lab-imp-val">{i.weight >= 0 ? '+' : '−'}{Math.abs(i.weight).toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="lab-note">
        {small
          ? <>The largest weight is only {max.toFixed(2)}, so no single input separates winners from losers. Weights are signed and measured on standardised inputs.</>
          : <>The largest weight is {max.toFixed(2)} ({items.find((i) => Math.abs(i.weight) === max)?.label}). A weight shows what the model leans on, not that it predicts well: check the AUC above. Weights are signed and measured on standardised inputs.</>}
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
      <Section title={<span id="lab-runs-h">Runs on this page</span>} hint="The server keeps only the newest backtest per scanner, market and timeframe, so this list holds the runs made here since the page was opened.">
        {runs.length === 0 ? (
          <EmptyState title="No backtest run on this page yet." hint="Run one above and it is listed here." />
        ) : (
          <div className="lab-table-wrap">
            <table className="table small">
              <thead><tr><th>Scanner</th><th>Market</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Profit factor</th><th className="num">Net</th><th className="num">Run</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.key}>
                    <td><Link to={`/scanners/${r.scannerId}`} className="strong">{r.scannerName}</Link></td>
                    <td className="mono">{r.symbol} {r.tf}</td>
                    <td className="num">{fmtInt(r.trades)}</td>
                    <td className="num">{r.winRatePct === null ? '–' : fmtPct(r.winRatePct)}</td>
                    <td className="num">{r.profitFactor === null ? '–' : fmtProfitFactor(r.profitFactor)}</td>
                    <td className="num">{r.pnl === null ? '–' : <Pnl value={r.pnl} />}</td>
                    <td className="num muted"><Time t={r.at} mode="ago" /></td>
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
