import { useState } from 'react'
import type { PairTakeProfit, PaperConfig } from '../api/types'
import { Panel } from './ui'

type Policies = NonNullable<PaperConfig['takeProfitBySymbol']>
export function pairTpError(policies: Policies): string | null {
  for (const [symbol, p] of Object.entries(policies)) {
    if (p === null) continue
    if (!/^[A-Z0-9]+$/.test(symbol)) return 'Use uppercase exchange symbols, e.g. BTCUSD.'
    if (!['fallback', 'override'].includes(p.mode)) return `${symbol}: choose a target mode.`
    if (p.rr.length !== 3 || p.rr.some((v, i) => !Number.isFinite(v) || v <= 0 || (i > 0 && v <= p.rr[i - 1]))) return `${symbol}: target R values must be positive and strictly increasing.`
    if (p.split.length !== 3 || p.split.some(v => !Number.isFinite(v) || v < 0 || v > 1) || Math.abs(p.split.reduce((a, b) => a + b, 0) - 1) > 1e-6) return `${symbol}: allocations must be 0–100% and total 100%.`
  }
  return null
}

export function PairTakeProfits({ value, onChange, defaultRR, defaultSplit }: {
  value: Policies; onChange: (value: Policies) => void; defaultRR: PairTakeProfit['rr']; defaultSplit: PairTakeProfit['split']
}) {
  const [symbol, setSymbol] = useState('')
  const update = (key: string, p: PairTakeProfit) => onChange({ ...value, [key]: p })
  const error = pairTpError(value)
  return <Panel title="Pair take-profits">
    <p className="muted small">Set targets per exchange pair. 1R is the entry-to-stop price distance, before costs. Unlisted pairs use global settings. Existing positions keep their targets and allocated contracts.</p>
    <div className="row gap">
      <label className="field"><span className="field-label">Exchange symbol</span><input className="input mono" placeholder="BTCUSD" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().trim())} /></label>
      <button className="btn" disabled={!/^[A-Z0-9]+$/.test(symbol) || !!value[symbol]} onClick={() => { update(symbol, { mode: 'fallback', rr: [...defaultRR], split: [...defaultSplit] }); setSymbol('') }}>Add pair</button>
    </div>
    {Object.entries(value).filter((entry): entry is [string, PairTakeProfit] => entry[1] !== null).map(([key, p]) => <fieldset key={key} className="form form-2">
      <legend>{key}</legend>
      <label className="field"><span className="field-label">Target source</span><select className="input" value={p.mode} onChange={e => update(key, { ...p, mode: e.target.value as PairTakeProfit['mode'] })}>
        <option value="fallback">Use pair targets when script targets are missing</option><option value="override">Replace script targets with pair targets</option>
      </select></label>
      <button className="btn" onClick={() => onChange({ ...value, [key]: null })}>Remove {key} override</button>
      {[0, 1, 2].map(i => <label className="field" key={`r${i}`}><span className="field-label">TP{i + 1} distance (R)</span><input className="input mono" type="number" min="0.01" step="0.25" value={Number.isFinite(p.rr[i]) ? p.rr[i] : ''} onChange={e => { const rr = [...p.rr] as PairTakeProfit['rr']; rr[i] = e.target.value === '' ? NaN : Number(e.target.value); update(key, { ...p, rr }) }} /></label>)}
      {[0, 1, 2].map(i => <label className="field" key={`s${i}`}><span className="field-label">TP{i + 1} allocation (%)</span><input className="input mono" type="number" min="0" max="100" step="5" value={Number.isFinite(p.split[i]) ? Math.round(p.split[i] * 10000) / 100 : ''} onChange={e => { const split = [...p.split] as PairTakeProfit['split']; split[i] = e.target.value === '' ? NaN : Number(e.target.value) / 100; update(key, { ...p, split }) }} /></label>)}
    </fieldset>)}
    {error && <p role="alert" className="field-err">{error}</p>}
    <p className="muted small">One-contract trades close at the earliest funded target. Larger positions use whole-contract allocation; the Positions page shows the actual allocation. Script exits and trailing stops can still close a trade before its targets. Changes apply when you save Settings.</p>
  </Panel>
}
