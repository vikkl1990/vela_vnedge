import { useMemo, useState } from 'react'
import { useConfig, useMarkets, useUpdateConfig } from '../api/queries'
import type { Config, PaperConfig } from '../api/types'
import { ChipSelect, ErrorState, Loading, PageTitle, Panel, Pill, SymbolPicker } from '../components/ui'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useToast } from '../lib/toast'

type Form = {
  symbols: string[]
  universe?: { mode: 'list' | 'top' | 'all'; top: number; exclude: string[] }
  ml?: { minProb: number; useAsScore: boolean }
  autoTune?: { enabled: boolean; minTrades: number; minProfitFactor: number; intervalHours: number }
  timeframes: string[]
  historyBars: number
  paper: PaperConfig
}

function toForm(c: Config): Form {
  return {
    symbols: [...(c.symbols ?? [])],
    universe: c.universe ? { ...c.universe, exclude: [...(c.universe.exclude ?? [])] } : { mode: 'list' as const, top: 20, exclude: [] },
    ml: { minProb: c.ml?.minProb ?? 0, useAsScore: c.ml?.useAsScore ?? false },
    autoTune: { enabled: c.autoTune?.enabled ?? true, minTrades: c.autoTune?.minTrades ?? 3, minProfitFactor: c.autoTune?.minProfitFactor ?? 1, intervalHours: c.autoTune?.intervalHours ?? 6 },
    timeframes: [...(c.timeframes ?? [])],
    historyBars: c.historyBars,
    paper: {
      ...c.paper,
      tpSplit: [...(c.paper?.tpSplit ?? [0.4, 0.3, 0.3])] as [number, number, number],
      fallbackRR: [...(c.paper?.fallbackRR ?? [1, 2, 3])] as [number, number, number],
    },
  }
}

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {}
  if (!f.symbols.length) e.symbols = 'Pick at least one symbol'
  if (!f.timeframes.length) e.timeframes = 'Pick at least one timeframe'
  if (!(f.historyBars >= 100 && f.historyBars <= 20000)) e.historyBars = '100 – 20000'
  const p = f.paper
  if (!(p.initialEquity > 0)) e.initialEquity = 'Must be > 0'
  if (!(p.riskPerTradePct > 0 && p.riskPerTradePct <= 100)) e.riskPerTradePct = '0 < x ≤ 100'
  if (!(p.maxLeverage >= 1 && p.maxLeverage <= 200)) e.maxLeverage = '1 – 200'
  if (!(p.feeRatePct >= 0 && p.feeRatePct < 5)) e.feeRatePct = '0 ≤ x < 5'
  if (!(p.slippageBps >= 0 && p.slippageBps < 1000)) e.slippageBps = '0 ≤ x < 1000'
  if (p.tpSplit.some((x) => !(x >= 0 && x <= 1))) e.tpSplit = 'Each 0 – 1'
  else if (Math.abs(p.tpSplit.reduce((a, b) => a + b, 0) - 1) > 0.001) e.tpSplit = 'Must sum to 1'
  if (!(p.fallbackAtrSl > 0)) e.fallbackAtrSl = 'Must be > 0'
  if (p.fallbackRR.some((x) => !(x > 0))) e.fallbackRR = 'Each > 0'
  else if (!(p.fallbackRR[0] <= p.fallbackRR[1] && p.fallbackRR[1] <= p.fallbackRR[2])) e.fallbackRR = 'Must be ascending'
  if (!(p.maxOpenPositions >= 1 && p.maxOpenPositions <= 500)) e.maxOpenPositions = '1 – 500'
  return e
}

const num = (v: string) => (v === '' ? NaN : Number(v))

function NumField({
  label,
  value,
  error,
  step = 'any',
  hint,
  onChange,
}: {
  label: string
  value: number
  error?: string
  step?: string
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <label className={`field ${error ? 'field-error' : ''}`}>
      <span className="field-label">
        {label}
        {hint && <span className="muted"> · {hint}</span>}
      </span>
      <input className="input mono" type="number" step={step} value={Number.isNaN(value) ? '' : String(value)} onChange={(e) => onChange(num(e.target.value))} />
      {error && <span className="field-err">{error}</span>}
    </label>
  )
}

export function Settings() {
  const config = useConfig()
  const markets = useMarkets()
  const update = useUpdateConfig()
  const toast = useToast()
  /** Local edits; `null` means "mirror the server config". */
  const [draft, setDraft] = useState<Form | null>(null)

  const serverForm = useMemo(() => (config.data ? toForm(config.data) : null), [config.data])
  const form = draft ?? serverForm
  const errors = useMemo(() => (form ? validate(form) : {}), [form])
  const dirty = !!draft && !!serverForm && JSON.stringify(draft) !== JSON.stringify(serverForm)
  const symbolOptions = useMemo(() => {
    const set = new Set<string>(config.data?.symbols ?? [])
    for (const m of markets.data ?? []) set.add(m.symbol)
    return Array.from(set)
  }, [config.data, markets.data])

  if (config.isLoading && !config.data) return <Loading label="Loading config…" />
  if (config.isError && !config.data) return <ErrorState error={config.error} onRetry={() => config.refetch()} />
  if (!form || !config.data) return <Loading />

  const edit = (fn: (f: Form) => Form) => setDraft(fn(draft ?? form))
  const setPaper = <K extends keyof PaperConfig>(k: K, v: PaperConfig[K]) => edit((f) => ({ ...f, paper: { ...f.paper, [k]: v } }))
  const setTriple = (k: 'tpSplit' | 'fallbackRR', i: number, v: number) =>
    edit((f) => {
      const arr = [...f.paper[k]] as [number, number, number]
      arr[i] = v
      return { ...f, paper: { ...f.paper, [k]: arr } }
    })
  const numField = (k: keyof PaperConfig, label: string, step?: string, hint?: string) => (
    <NumField label={label} value={form.paper[k] as number} error={errors[k]} step={step} hint={hint} onChange={(v) => setPaper(k, v as never)} />
  )

  const save = () => {
    if (Object.keys(errors).length) return toast.error('Fix validation errors first')
    update.mutate(
      { symbols: form.symbols, universe: form.universe, ml: form.ml, autoTune: form.autoTune, timeframes: form.timeframes, historyBars: form.historyBars, paper: form.paper },
      {
        onSuccess: () => {
          setDraft(null)
          toast.success('Settings saved', 'Feed re-subscribed and scanners re-warmed if needed.')
        },
        onError: (e) => toast.error('Save failed', e.message),
      },
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <PageTitle pre="Tune the" accent="engine," post="not the noise." sub="Bound to GET/PUT /api/config. Changing symbols or timeframes re-subscribes the feed and re-warms scanners." />
        <div className="page-actions">
          <Pill tone="muted">execution: {config.data.execution?.mode ?? 'paper'}</Pill>
          <button className="btn" onClick={() => setDraft(null)} disabled={!dirty || update.isPending}>
            Revert
          </button>
          <button className="btn btn-cta" onClick={save} disabled={!dirty || update.isPending || Object.keys(errors).length > 0}>
            {update.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <div className="grid-2">
        <Panel title="Market data">
          <div className="form">
            <label className="field">
              <span className="field-label">Symbol universe</span>
              <select className="input" value={form.universe?.mode ?? 'list'} onChange={(e) => edit((f) => ({ ...f, universe: { mode: e.target.value as 'list' | 'top' | 'all', top: f.universe?.top ?? 20, exclude: f.universe?.exclude ?? [] } }))}>
                <option value="list">Fixed list (below)</option>
                <option value="top">Top N Delta perpetuals by 24h volume</option>
                <option value="all">All live Delta perpetuals (heavy)</option>
              </select>
              {config.data.resolvedSymbols && (
                <span className="muted small">currently scanning {config.data.resolvedSymbols.length} symbols: {config.data.resolvedSymbols.slice(0, 12).join(', ')}{config.data.resolvedSymbols.length > 12 ? '…' : ''}</span>
              )}
            </label>
            {(form.universe?.mode ?? 'list') === 'top' && (
              <label className="field">
                <span className="field-label">Top N</span>
                <input className="input mono" type="number" min={1} max={300} step={1} value={form.universe?.top ?? 20} onChange={(e) => edit((f) => ({ ...f, universe: { mode: 'top', top: Number(e.target.value), exclude: f.universe?.exclude ?? [] } }))} />
              </label>
            )}
            <div className={`field ${errors.symbols ? 'field-error' : ''}`}>
              <span className="field-label">{(form.universe?.mode ?? 'list') === 'list' ? 'Symbols' : 'Symbols (used when universe = fixed list)'}</span>
              <SymbolPicker options={symbolOptions} value={form.symbols} onChange={(v) => edit((f) => ({ ...f, symbols: v }))} />
              {errors.symbols && <span className="field-err">{errors.symbols}</span>}
              {markets.isError && <span className="muted small">markets endpoint unavailable — showing configured symbols only</span>}
            </div>
            <div className={`field ${errors.timeframes ? 'field-error' : ''}`}>
              <span className="field-label">Timeframes</span>
              <ChipSelect options={[...DELTA_TIMEFRAMES]} value={form.timeframes} onChange={(v) => edit((f) => ({ ...f, timeframes: v }))} emptyLabel="none" />
              {errors.timeframes && <span className="field-err">{errors.timeframes}</span>}
            </div>
            <NumField label="History bars" hint="warm-up depth per symbol/tf" step="1" value={form.historyBars} error={errors.historyBars} onChange={(v) => edit((f) => ({ ...f, historyBars: v }))} />
            <label className="field">
              <span className="field-label">Execution mode</span>
              <input className="input mono" value={config.data.execution?.mode ?? 'paper'} readOnly disabled />
            </label>
          </div>
        </Panel>

        <Panel title="Auto-tune">
          <div className="form form-2">
            <label className="check">
              <input type="checkbox" checked={form.autoTune?.enabled ?? true} onChange={(e) => edit((f) => ({ ...f, autoTune: { ...(f.autoTune ?? { minTrades: 3, minProfitFactor: 1, intervalHours: 6 }), enabled: e.target.checked } }))} /> Keep each scanner only on symbols where its backtest is profitable (after warm-up and on a schedule)
            </label>
            <label className="field"><span className="field-label">Min trades per symbol</span><input className="input mono" type="number" min={1} step={1} value={form.autoTune?.minTrades ?? 3} onChange={(e) => edit((f) => ({ ...f, autoTune: { ...(f.autoTune ?? { enabled: true, minProfitFactor: 1, intervalHours: 6 }), minTrades: Number(e.target.value) } }))} /></label>
            <label className="field"><span className="field-label">Min profit factor</span><input className="input mono" type="number" min={0} step={0.1} value={form.autoTune?.minProfitFactor ?? 1} onChange={(e) => edit((f) => ({ ...f, autoTune: { ...(f.autoTune ?? { enabled: true, minTrades: 3, intervalHours: 6 }), minProfitFactor: Number(e.target.value) } }))} /></label>
            <label className="field"><span className="field-label">Re-backtest and re-tune every (hours)</span><input className="input mono" type="number" min={1} step={1} value={form.autoTune?.intervalHours ?? 6} onChange={(e) => edit((f) => ({ ...f, autoTune: { ...(f.autoTune ?? { enabled: true, minTrades: 3, minProfitFactor: 1 }), intervalHours: Number(e.target.value) } }))} /></label>
          </div>
        </Panel>

        <Panel title="Machine learning">
          <div className="form form-2">
            <label className="field">
              <span className="field-label">Minimum win probability <span className="muted">· 0 = no gate</span></span>
              <input className="input mono" type="number" min={0} max={0.95} step={0.05} value={form.ml?.minProb ?? 0} onChange={(e) => edit((f) => ({ ...f, ml: { minProb: Number(e.target.value), useAsScore: f.ml?.useAsScore ?? false } }))} />
              <span className="muted small">entries whose predicted P(win) is below this are skipped and logged as rejected</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.ml?.useAsScore ?? false} onChange={(e) => edit((f) => ({ ...f, ml: { minProb: f.ml?.minProb ?? 0, useAsScore: e.target.checked } }))} /> Use P(win) as the quality score for leverage when the script publishes none
            </label>
          </div>
        </Panel>

        <Panel title="Paper engine">
          <div className="form form-2">
            {numField('initialEquity', 'Initial equity', '100')}
            <label className="field">
              <span className="field-label">Sizing mode</span>
              <select className="input" value={form.paper.sizingMode ?? 'risk'} onChange={(e) => setPaper('sizingMode', e.target.value as PaperConfig['sizingMode'])}>
                <option value="risk">Risk % of equity per trade</option>
                <option value="quality">Quality leverage (min→max by signal score)</option>
              </select>
            </label>
            {numField('riskPerTradePct', 'Risk per trade %', '0.1', 'risk mode only')}
            {numField('minLeverage', 'Min leverage', '1', 'quality mode: unscored / score 0')}
            {numField('maxLeverage', 'Max leverage', '1', 'risk mode: isolated leverage · quality mode: score 100 · account exposure cap')}
            {numField('maintenanceMarginPct', 'Maintenance margin %', '0.1', 'for liquidation modelling')}
            {numField('minRiskFeeRatio', 'Min stop ÷ round-trip fee', '0.5', 'skip entries whose stop is tighter than this × fees (0 = off)')}
            {numField('feeRatePct', 'Fee rate %', '0.01')}
            {numField('slippageBps', 'Slippage (bps)', '1')}
            {numField('maxOpenPositions', 'Max open positions', '1')}
            {numField('fallbackAtrSl', 'Fallback ATR SL', '0.1', '× ATR when script has no SL')}
            <div className={`field ${errors.tpSplit ? 'field-error' : ''}`}>
              <span className="field-label">
                TP split <span className="muted">· fractions, sum 1</span>
              </span>
              <div className="triple">
                {[0, 1, 2].map((i) => (
                  <input
                    key={i}
                    className="input mono"
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    aria-label={`TP${i + 1} split`}
                    value={Number.isNaN(form.paper.tpSplit[i]) ? '' : form.paper.tpSplit[i]}
                    onChange={(e) => setTriple('tpSplit', i, num(e.target.value))}
                  />
                ))}
              </div>
              {errors.tpSplit && <span className="field-err">{errors.tpSplit}</span>}
            </div>
            <div className={`field ${errors.fallbackRR ? 'field-error' : ''}`}>
              <span className="field-label">
                Fallback RR <span className="muted">· TP1/2/3 in R</span>
              </span>
              <div className="triple">
                {[0, 1, 2].map((i) => (
                  <input
                    key={i}
                    className="input mono"
                    type="number"
                    step="0.5"
                    min="0"
                    aria-label={`Fallback RR ${i + 1}`}
                    value={Number.isNaN(form.paper.fallbackRR[i]) ? '' : form.paper.fallbackRR[i]}
                    onChange={(e) => setTriple('fallbackRR', i, num(e.target.value))}
                  />
                ))}
              </div>
              {errors.fallbackRR && <span className="field-err">{errors.fallbackRR}</span>}
            </div>
            <label className="check">
              <input type="checkbox" checked={form.paper.breakEvenAfterTp1} onChange={(e) => setPaper('breakEvenAfterTp1', e.target.checked)} /> Move SL to break-even after TP1
            </label>
            <label className="check">
              <input type="checkbox" checked={form.paper.allowReversal} onChange={(e) => setPaper('allowReversal', e.target.checked)} /> Allow reversal (opposite signal closes & flips)
            </label>
            <label className="check">
              <input type="checkbox" checked={form.paper.liquidation ?? true} onChange={(e) => setPaper('liquidation', e.target.checked)} /> Model approximate isolated liquidation (fixed maintenance rate; candle prices)
            </label>
          </div>
        </Panel>
      </div>

      <Panel title="Per-scanner overrides" right={<span className="muted small">edited on the Scanners page</span>}>
        <div className="muted small">
          {Object.keys(config.data.scanners ?? {}).length} scanner override(s) stored. Symbols/timeframes set to <code>null</code> inherit the global lists above.
        </div>
      </Panel>
    </div>
  )
}
