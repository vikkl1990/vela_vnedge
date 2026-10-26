import { useMemo, useState, type ReactNode } from 'react'
import { useConfig, useConfigDefaults, useMarkets, useUpdateConfig } from '../api/queries'
import type { ConfigPatch } from '../api/types'
import { ChipSelect, ConfirmDialog, ErrorState, Loading, PageTitle, Panel, Pill, SymbolPicker } from '../components/ui'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { MEASURED } from '../lib/measured'
import { useToast } from '../lib/toast'

/**
 * Decision 119: every number the system runs on, grouped by what it can cost, each shown against the value the
 * decisions log measured. A change to a high-risk section is listed back, with the decision it overrides, before
 * it is saved. The server validates every patch; this page sends only the paths that changed.
 */

type Risk = 'high' | 'medium' | 'low'
const RISK_LABEL: Record<Risk, string> = { high: 'can lose money', medium: 'changes what trades', low: 'housekeeping' }
const RISK_TONE: Record<Risk, 'danger' | 'warn' | 'muted'> = { high: 'danger', medium: 'warn', low: 'muted' }

interface FieldDef { path: string; label: string; kind: 'number' | 'bool' | 'select' | 'tfs'; step?: string; hint?: string; options?: Array<[string, string]>; validate?: (v: unknown) => string | null }
interface Section { key: string; title: string; risk: Risk; intro: string; fields: FieldDef[] }

const num = (lo: number, hi: number) => (v: unknown) => (typeof v === 'number' && v >= lo && v <= hi ? null : `${lo} – ${hi}`)
const SECTIONS: Section[] = [
 { key:'funding',title:'Funding protection · paper',risk:'high',intro:'Experimental budgets, not an optimized strategy. Uses fresh current funding estimates and fresh exit quotes. Blocks costly entries and closes paying positions before settlement. Off by default pending forward evaluation. Exchange execution is not supported.',fields:[
 {path:'paper.fundingGuard.enabled',label:'Enable funding protection',kind:'bool'},
 {path:'paper.fundingGuard.leadMinutes',label:'Minutes before settlement',kind:'number',validate:num(1,60)},
 {path:'paper.fundingGuard.maxAgeSec',label:'Maximum funding age (seconds)',kind:'number',validate:num(10,600)},
 {path:'paper.fundingGuard.scalpMaxR',label:'Scalp funding budget (R)',kind:'number',step:'0.01',validate:num(0.01,2)},
 {path:'paper.fundingGuard.swingMaxR',label:'Swing funding budget (R)',kind:'number',step:'0.01',validate:num(0.01,2)}]},
  {
    key: 'sizing', title: 'Account and sizing', risk: 'high', intro: 'What one trade can lose and how many can be open. The risk per trade is what every R is measured against.',
    fields: [
      { path: 'paper.initialEquity', label: 'Initial equity (USD)', kind: 'number', step: '100', validate: num(1, 1e9) },
      { path: 'paper.riskPerTradePct', label: 'Risk per trade (% of equity)', kind: 'number', step: '0.1', validate: num(0.01, 100) },
      { path: 'paper.maxLeverage', label: 'Max leverage', kind: 'number', step: '1', hint: 'or the market\'s own ceiling, whichever is lower', validate: num(1, 200) },
      { path: 'paper.maxOpenPositions', label: 'Max open positions (engine)', kind: 'number', step: '1', validate: num(1, 500) },
      { path: 'risk.maxPositionsTotal', label: 'Max open positions (risk layer)', kind: 'number', step: '1', validate: num(1, 500) },
      { path: 'risk.maxPositionsPerSymbol', label: 'Positions per market', kind: 'number', step: '1', validate: num(1, 20) },
      { path: 'risk.perScannerMaxPositions', label: 'Positions per scanner', kind: 'number', step: '1', validate: num(1, 50) },
      { path: 'paper.liquidation', label: 'Model isolated-margin liquidation', kind: 'bool' },
    ],
  },
  {
    key: 'limits', title: 'Loss limits and guards', risk: 'high', intro: 'The kill switches and the guards against re-entering a loss.',
    fields: [
      { path: 'risk.enabled', label: 'Risk layer on', kind: 'bool' },
      { path: 'risk.maxDailyLossPct', label: 'Daily loss limit (% of equity)', kind: 'number', step: '0.5', validate: num(0.5, 100) },
      { path: 'risk.maxWeeklyLossPct', label: 'Weekly loss limit (%)', kind: 'number', step: '0.5', validate: num(0.5, 100) },
      { path: 'risk.reentryCooldownMinutes', label: 'Re-entry cooldown after a stop (min)', kind: 'number', step: '5', validate: num(0, 1440) },
      { path: 'risk.burstWindowSec', label: 'Burst guard window (s)', kind: 'number', step: '10', hint: 'one entry per side inside the window', validate: num(0, 3600) },
    ],
  },
  {
    key: 'costs', title: 'Costs and fills', risk: 'high', intro: 'What a round trip costs and the rule that refuses a stop too tight to pay it. The cost rule is the filter the account\'s loss is made of.',
    fields: [
      { path: 'paper.feeRatePct', label: 'Taker fee (%)', kind: 'number', step: '0.01', validate: num(0, 5) },
      { path: 'paper.makerFeeRatePct', label: 'Maker fee (%)', kind: 'number', step: '0.01', validate: num(0, 5) },
      { path: 'paper.feeTaxPct', label: 'Tax on fees (%)', kind: 'number', step: '1', hint: 'GST', validate: num(0, 100) },
      { path: 'paper.slippageBps', label: 'Slippage (bps)', kind: 'number', step: '1', hint: 'on top of the measured book cost', validate: num(0, 1000) },
      { path: 'paper.minRiskFeeRatio', label: 'Stop must cover this many round trips', kind: 'number', step: '0.5', hint: '0 turns the cost rule off', validate: num(0, 50) },
      { path: 'paper.requireQuote', label: 'Require an executable quote to enter', kind: 'bool' },
    ],
  },
  {
    key: 'gates', title: 'Gates', risk: 'high', intro: 'The regime and market gates every entry must clear. The efficiency floor is the one filter that measured as paying.',
    fields: [
      { path: 'risk.regime.enabled', label: 'Regime gate on', kind: 'bool' },
      { path: 'risk.regime.minEr', label: 'Efficiency ratio floor (20 bars)', kind: 'number', step: '0.05', hint: '0 = off', validate: num(0, 1) },
      { path: 'risk.regime.minAtrPct', label: 'ATR floor (% of price)', kind: 'number', step: '0.05', validate: num(0, 10) },
      { path: 'risk.regime.noWeekend', label: 'No entries on weekends', kind: 'bool' },
      { path: 'risk.marketGate.enabled', label: 'Market gate on', kind: 'bool' },
      { path: 'risk.marketGate.minTurnoverUsd', label: 'Turnover floor (USD, 24 h)', kind: 'number', step: '10000', validate: num(0, 1e9) },
      { path: 'risk.marketGate.maxBookCostPct', label: 'Max book cost (% round trip)', kind: 'number', step: '0.01', validate: num(0, 5) },
      { path: 'risk.marketGate.probeNotionalUsd', label: 'Probe notional (USD)', kind: 'number', step: '50', hint: 'Base order: $150 margin × 5 leverage = $750; larger orders need a larger depth check', validate: num(100, 1e6) },
    ],
  },
  {
    key: 'exits', title: 'Exits', risk: 'medium', intro: 'Where the stop sits when a script publishes none, how the trail and the floor move it, and the targets.',
    fields: [
      { path: 'paper.fallbackAtrSl', label: 'Fallback stop (× ATR)', kind: 'number', step: '0.1', validate: num(0.1, 10) },
      { path: 'paper.scriptDisasterStopAtr', label: 'Disaster stop under exit mode script (× ATR)', kind: 'number', step: '0.5', validate: num(0.5, 10) },
      { path: 'paper.trailAfterR', label: 'Trail arms at (R)', kind: 'number', step: '0.1', hint: '0 = no trail', validate: num(0, 20) },
      { path: 'paper.trailGiveBackPct', label: 'Trail gives back (% of peak)', kind: 'number', step: '5', validate: num(0, 95) },
      { path: 'paper.floorAtR', label: 'Floor arms at (R)', kind: 'number', step: '0.1', hint: '0 = no floor', validate: num(0, 20) },
      { path: 'paper.floorKeepR', label: 'Floor keeps (R)', kind: 'number', step: '0.05', validate: num(0, 20) },
      { path: 'paper.breakEvenAfterTp1', label: 'Stop to break-even after TP1', kind: 'bool' },
      { path: 'paper.allowReversal', label: 'Opposite signal closes and flips', kind: 'bool' },
    ],
  },
  {
    key: 'incubator', title: 'Incubator', risk: 'medium', intro: 'How the library becomes the fleet: the screen, the shadow book, the gate, the clocks. The mirror is the one switch here that changes what the account trades.',
    fields: [
      { path: 'incubator.mirror.enabled', label: 'Mirror: the account takes every shadow pair\'s signals under its own gates', kind: 'bool' },
      { path: 'incubator.tfs', label: 'Screen timeframes', kind: 'tfs' },
      { path: 'incubator.maxShadow', label: 'Shadow book cap (pairs)', kind: 'number', step: '10', validate: num(1, 2000) },
      { path: 'incubator.promote.maxFleet', label: 'Fleet cap (cells)', kind: 'number', step: '1', validate: num(1, 1000) },
      { path: 'incubator.promote.maxPerWeek', label: 'Promotions per week', kind: 'number', step: '1', validate: num(0, 100) },
      { path: 'incubator.promote.maxPerMarket', label: 'Live cells per market', kind: 'number', step: '1', validate: num(1, 20) },
      { path: 'incubator.promote.maxPerScanner', label: 'Live cells per scanner', kind: 'number', step: '1', validate: num(1, 50) },
      { path: 'incubator.gate.minTrades', label: 'Gate: shadow trades', kind: 'number', step: '1', validate: num(1, 500) },
      { path: 'incubator.gate.minDays', label: 'Gate: days', kind: 'number', step: '1', validate: num(0, 365) },
      { path: 'incubator.gate.minPfR', label: 'Gate: profit factor in R', kind: 'number', step: '0.05', validate: num(0.5, 10) },
      { path: 'incubator.gate.minAvgR', label: 'Gate: R per trade', kind: 'number', step: '0.05', validate: num(-1, 5) },
      { path: 'incubator.gate.minWeeks', label: 'Gate: positive weeks judged from (weeks)', kind: 'number', step: '1', validate: num(0, 12) },
      { path: 'incubator.gate.staleDays', label: 'Stale shadow pair after (days, 15m)', kind: 'number', step: '1', validate: num(1, 365) },
      { path: 'incubator.demote.silentDays', label: 'Silent live cell after (days)', kind: 'number', step: '1', validate: num(0, 365) },
      { path: 'incubator.demote.marketOutDays', label: 'Market out for (days) proposes demotion', kind: 'number', step: '1', validate: num(1, 60) },
      { path: 'incubator.demote.costStarvedRefusals', label: 'Cost-rule refusals that propose demotion', kind: 'number', step: '1', validate: num(0, 1000) },
    ],
  },
  {
    key: 'model', title: 'Model', risk: 'low', intro: 'Advisory. The Learn page\'s yardstick says whether a gate would have paid; today it would not.',
    fields: [
      { path: 'ml.minProb', label: 'Refuse entries under P(win)', kind: 'number', step: '0.05', hint: '0 = no gate', validate: num(0, 0.95) },
      { path: 'ml.useAsScore', label: 'Use P(win) as the score for sizing', kind: 'bool' },
    ],
  },
  {
    key: 'data', title: 'Market data', risk: 'low', intro: 'What the live engine subscribes to and how far back it warms up. Changing symbols or timeframes re-subscribes the feed.',
    fields: [
      { path: 'universe.mode', label: 'Symbol universe', kind: 'select', options: [['list', 'Fixed list'], ['top', 'Top N Delta perpetuals by 24 h volume'], ['all', 'All live Delta perpetuals']] },
      { path: 'universe.top', label: 'Top N', kind: 'number', step: '1', validate: num(1, 300) },
      { path: 'timeframes', label: 'Timeframes', kind: 'tfs' },
      { path: 'historyBars', label: 'History bars (warm-up per symbol and timeframe)', kind: 'number', step: '100', validate: num(100, 20000) },
    ],
  },
  {
    key: 'autotune', title: 'Auto-tune', risk: 'low', intro: 'Off on the account since the incubator owns the fleet (decision 112).',
    fields: [
      { path: 'autoTune.enabled', label: 'Auto-tune on', kind: 'bool' },
      { path: 'autoTune.minTrades', label: 'Min trades per symbol', kind: 'number', step: '1', validate: num(1, 1000) },
      { path: 'autoTune.minProfitFactor', label: 'Min profit factor', kind: 'number', step: '0.1', validate: num(0, 10) },
      { path: 'autoTune.intervalHours', label: 'Re-tune every (hours)', kind: 'number', step: '1', validate: num(1, 168) },
    ],
  },
]

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o)
function setPath(o: Record<string, unknown>, path: string, v: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.')
  const child = o[head]
  return { ...o, [head]: rest.length ? setPath(child && typeof child === 'object' ? (child as Record<string, unknown>) : {}, rest.join('.'), v) : v }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const show = (v: unknown) => (v === undefined || v === null ? 'unset' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'number' ? (Math.abs(v) >= 10_000 ? v.toLocaleString() : String(v)) : String(v))

export function Settings() {
  const config = useConfig()
  const defaults = useConfigDefaults()
  const markets = useMarkets()
  const update = useUpdateConfig()
  const toast = useToast()
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const [confirm, setConfirm] = useState(false)

  const server = config.data as unknown as Record<string, unknown> | undefined
  const form = draft ?? server
  const changes = useMemo(() => {
    if (!form || !server) return [] as Array<{ path: string; from: unknown; to: unknown; section: Section; field: FieldDef }>
    const out: Array<{ path: string; from: unknown; to: unknown; section: Section; field: FieldDef }> = []
    for (const sec of SECTIONS) for (const f of sec.fields) { const from = getPath(server, f.path), to = getPath(form, f.path); if (!same(from, to)) out.push({ path: f.path, from, to, section: sec, field: f }) }
    return out
  }, [form, server])
  const errors = useMemo(() => {
    const e: Record<string, string> = {}
    if (!form) return e
    for (const sec of SECTIONS) for (const f of sec.fields) { const v = getPath(form, f.path); if (f.kind === 'number' && f.validate && v !== undefined && v !== null) { const p = f.validate(v); if (p) e[f.path] = p } }
    if (Array.isArray(getPath(form, 'timeframes')) && !(getPath(form, 'timeframes') as unknown[]).length) e.timeframes = 'Pick at least one timeframe'
    if ((getPath(form, 'universe.mode') ?? 'list') === 'list' && !((getPath(form, 'symbols') as string[] | undefined)?.length)) e.symbols = 'Pick at least one symbol'
    return e
  }, [form])
  const symbolOptions = useMemo(() => { const set = new Set<string>(config.data?.symbols ?? []); for (const m of markets.data ?? []) set.add(m.symbol); return Array.from(set) }, [config.data, markets.data])
  const dirty = changes.length > 0 || (!!draft && !!server && !same(getPath(draft, 'symbols'), getPath(server, 'symbols')))
  const highRisk = changes.filter((c) => c.section.risk === 'high' || c.path === 'incubator.mirror.enabled')

  if (config.isLoading && !config.data) return <div className="page"><PageTitle pre="Every number" accent="the system" post="runs on." /><Loading rows={8} /></div>
  if (config.isError && !config.data) return <ErrorState error={config.error} onRetry={() => config.refetch()} />
  if (!form || !server) return <Loading rows={6} />

  const edit = (path: string, v: unknown) => setDraft(setPath(draft ?? server, path, v))
  const measuredFor = (path: string) => { const m = MEASURED[path]; if (m) return { value: m.value, decision: m.decision, note: m.note }; const d = getPath(defaults.data, path); return d === undefined ? null : { value: d, decision: null as number | null, note: 'the code\'s default' } }

  const buildPatch = (): ConfigPatch => {
    let patch: Record<string, unknown> = {}
    for (const c of changes) patch = setPath(patch, c.path, c.to)
    if (!same(getPath(draft, 'symbols'), getPath(server, 'symbols'))) patch.symbols = getPath(draft, 'symbols')
    return patch as ConfigPatch
  }
  const doSave = () => {
    update.mutate(buildPatch(), {
      onSuccess: () => { setDraft(null); setConfirm(false); toast.success('Settings saved', `${changes.length} change${changes.length === 1 ? '' : 's'} applied`) },
      onError: (e) => { setConfirm(false); toast.error('Save failed', e.message) },
    })
  }
  const save = () => {
    if (Object.keys(errors).length) return toast.error('Fix the fields marked first')
    if (highRisk.length) setConfirm(true); else doSave()
  }

  const field = (f: FieldDef) => {
    const v = getPath(form, f.path)
    const m = measuredFor(f.path)
    const changed = !same(getPath(server, f.path), v)
    const offMeasured = m !== null && !same(m.value, v)
    const err = errors[f.path]
    const diff = (
      <span className="field-diff small">
        {changed && <span className="warn">was {show(getPath(server, f.path))} · </span>}
        {m ? (offMeasured ? <span className={m.decision ? 'warn' : 'muted'} title={m.note}>measured {show(m.value)}{m.decision ? ` (decision ${m.decision})` : ''}</span> : <span className="muted" title={m.note}>as measured{m.decision ? ` · decision ${m.decision}` : ''}</span>) : null}
      </span>
    )
    let control: ReactNode
    if (f.kind === 'bool') control = <input type="checkbox" checked={Boolean(v)} onChange={(e) => edit(f.path, e.target.checked)} />
    else if (f.kind === 'select') control = <select className="input" value={String(v ?? f.options?.[0]?.[0] ?? '')} onChange={(e) => edit(f.path, e.target.value)}>{f.options?.map(([val, label]) => <option key={val} value={val}>{label}</option>)}</select>
    else if (f.kind === 'tfs') control = <ChipSelect options={[...DELTA_TIMEFRAMES]} value={(v as string[] | undefined) ?? []} onChange={(x) => edit(f.path, x)} emptyLabel="none" />
    else control = <input className="input mono" type="number" step={f.step ?? 'any'} value={typeof v === 'number' && Number.isFinite(v) ? String(v) : ''} onChange={(e) => edit(f.path, e.target.value === '' ? undefined : Number(e.target.value))} />
    if (f.kind === 'bool') return (
      <label key={f.path} className={`check settings-row ${changed ? 'settings-changed' : ''}`}>
        {control} <span>{f.label}{f.hint && <span className="muted"> · {f.hint}</span>}</span> {diff}
      </label>
    )
    return (
      <label key={f.path} className={`field settings-row ${err ? 'field-error' : ''} ${changed ? 'settings-changed' : ''}`}>
        <span className="field-label">{f.label}{f.hint && <span className="muted"> · {f.hint}</span>}</span>
        {control}
        {err ? <span className="field-err">{err}</span> : diff}
      </label>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <PageTitle pre="Every number" accent="the system" post="runs on." sub="Grouped by what a change can cost. Each value is shown against what the decisions log measured; a change in a red section is read back to you before it is saved." />
        <div className="page-actions">
          <Pill tone="muted">execution: {config.data?.execution?.mode ?? 'paper'}</Pill>
          {dirty && <Pill tone="warn">{changes.length} unsaved change{changes.length === 1 ? '' : 's'}</Pill>}
          <button className="btn" onClick={() => setDraft(null)} disabled={!dirty || update.isPending}>Revert</button>
          <button className="btn btn-cta" onClick={save} disabled={!dirty || update.isPending || Object.keys(errors).length > 0}>{update.isPending ? 'Saving…' : highRisk.length ? 'Review and save' : 'Save settings'}</button>
        </div>
      </div>

      <div className="settings-grid">
        {SECTIONS.map((sec) => (
          <Panel key={sec.key} title={<span>{sec.title} <Pill tone={RISK_TONE[sec.risk]}>{RISK_LABEL[sec.risk]}</Pill></span>} right={changes.some((c) => c.section.key === sec.key) ? <Pill tone="warn">edited</Pill> : undefined}>
            <p className="muted small" style={{ marginTop: 0 }}>{sec.intro}</p>
            <div className="form form-2">
              {sec.fields.filter((f) => !(f.path === 'universe.top' && (getPath(form, 'universe.mode') ?? 'list') !== 'top')).map(field)}
              {sec.key === 'data' && (
                <div className={`field ${errors.symbols ? 'field-error' : ''}`} style={{ gridColumn: '1 / -1' }}>
                  <span className="field-label">Symbols{(getPath(form, 'universe.mode') ?? 'list') !== 'list' && <span className="muted"> · used when the universe is a fixed list</span>}</span>
                  <SymbolPicker options={symbolOptions} value={(getPath(form, 'symbols') as string[] | undefined) ?? []} onChange={(v) => edit('symbols', v)} />
                  {errors.symbols && <span className="field-err">{errors.symbols}</span>}
                  {config.data?.resolvedSymbols && <span className="muted small">scanning {config.data.resolvedSymbols.length} symbols now</span>}
                </div>
              )}
            </div>
          </Panel>
        ))}
      </div>

      <Panel title="Per-scanner overrides" right={<span className="muted small">edited on each scanner's page and on the Scanners page</span>}>
        <div className="muted small">{Object.keys(config.data?.scanners ?? {}).length} scanner override(s) stored: reading, exit mode, pairs, inputs. They layer over the sections above.</div>
      </Panel>

      <ConfirmDialog
        open={confirm}
        title={`Save ${changes.length} change${changes.length === 1 ? '' : 's'}, ${highRisk.length} of them in a section that can lose money?`}
        body={
          <div className="small">
            <table className="table small">
              <thead><tr><th>setting</th><th>was</th><th>becomes</th><th>measured</th></tr></thead>
              <tbody>
                {changes.map((c) => { const m = measuredFor(c.path); return (
                  <tr key={c.path} className={c.section.risk === 'high' ? 'loss' : ''}>
                    <td>{c.field.label} <span className="muted">· {c.section.title}</span></td>
                    <td className="mono">{show(c.from)}</td><td className="mono">{show(c.to)}</td>
                    <td className="muted">{m ? <>{show(m.value)}{m.decision ? ` (decision ${m.decision})` : ''}{m.decision && !same(m.value, c.to) ? ' — this overrides a measured value' : ''}</> : '—'}</td>
                  </tr>) })}
              </tbody>
            </table>
            <p className="muted">Nothing here reaches an exchange: the account is paper. The decisions log is the place to record why, if the change stays.</p>
          </div>
        }
        confirmLabel="Save these changes"
        danger
        busy={update.isPending}
        onConfirm={doSave}
        onCancel={() => setConfirm(false)}
      />
    </div>
  )
}
