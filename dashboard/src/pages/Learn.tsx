import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useMl } from '../api/queries'
import type { MlRule, MlScannerInsight } from '../api/types'
import { ErrorState, KpiTile, Loading, PageTitle, Panel, Pill } from '../components/ui'
import { useToast } from '../lib/toast'
import { fmtDateTime } from '../lib/format'

const pct = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(d)}%`)
const r = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)

export function Learn() {
  const ml = useMl()
  const qc = useQueryClient()
  const toast = useToast()
  const [sel, setSel] = useState<string>('')
  const train = useMutation({
    mutationFn: () => api.mlTrain(),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: ['ml'] }); toast.success('Models trained', `${s.samples} samples · ${s.scannersWithModel} scanner models`) },
    onError: (e) => toast.error('Training failed', (e as Error).message),
  })
  const d = ml.data
  const scanners = useMemo(() => (d?.scanners ?? []).filter((s) => s.samples > 0), [d])
  const current: MlScannerInsight | undefined = scanners.find((s) => s.scannerId === sel) ?? scanners[0]

  return (
    <div className="page">
      <PageTitle pre="Every trade," accent="learned" post="from." sub="Entry-time features of every backtest and live trade train a win-probability model per scanner; bucket analysis turns the data into concrete rules." />
      {ml.isLoading && <Loading />}
      {ml.isError && <ErrorState error={ml.error} onRetry={() => ml.refetch()} />}
      {d && (
        <>
          <div className="kpi-grid">
            <KpiTile label="Samples" value={String(d.samples)} sub={`${d.liveSamples} live · ${d.samples - d.liveSamples} backtest`} />
            <KpiTile label="Scanner models" value={String(d.scannersWithModel)} sub="≥ 40 trades each" />
            <KpiTile label="Global accuracy" value={pct(d.global?.model?.accuracy)} sub={`holdout ${d.global?.model?.holdout ?? 0} · base ${pct(d.global?.model?.baseWinRate)}`} tone={(d.global?.model?.accuracy ?? 0) > (d.global?.model?.baseWinRate ?? 0) ? 'gain' : undefined} />
            <KpiTile label="Global AUC" value={d.global?.model ? d.global.model.auc.toFixed(2) : '–'} sub="0.5 = coin flip" tone={(d.global?.model?.auc ?? 0) > 0.58 ? 'gain' : (d.global?.model?.auc ?? 1) < 0.52 ? 'loss' : undefined} />
            <KpiTile label="Trained" value={d.trainedAt ? fmtDateTime(d.trainedAt) : 'never'} sub={d.config ? `gate ${d.config.minProb > 0 ? pct(d.config.minProb) : 'off'} · as score ${d.config.useAsScore ? 'on' : 'off'}` : ''} />
          </div>
          <div className="row gap">
            <button className="btn btn-cta" onClick={() => train.mutate()} disabled={train.isPending || d.samples < 30}>
              {train.isPending ? 'Training…' : 'Train now'}
            </button>
            <span className="muted small">Models retrain automatically within 30 s of new samples arriving. Gate and score usage live in Settings → Machine learning.</span>
          </div>

          <div className="grid-2">
            <Panel title="Global feature weights">
              {d.global ? (
                <ul className="bars">
                  {d.global.importance.slice(0, 12).map((f) => (
                    <li key={f.feature}>
                      <span className="bars-label">{f.label}</span>
                      <span className="bars-track"><span className={`bars-fill ${f.weight >= 0 ? 'gain-bg' : 'loss-bg'}`} style={{ width: `${Math.min(100, Math.abs(f.weight) * 60)}%` }} /></span>
                      <span className={`mono small ${f.weight >= 0 ? 'gain' : 'loss'}`}>{f.weight >= 0 ? '+' : ''}{f.weight.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="state muted">Not enough samples yet (need 30+). Backtests fill this in during warm-up.</div>
              )}
            </Panel>
            <Panel title="Global rules">
              <RuleList rules={d.global?.rules ?? []} baseline={d.global?.baseline} />
            </Panel>
          </div>

          <Panel title={<span>Per-scanner insights <span className="muted small">({scanners.length} with data)</span></span>}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Scanner</th><th className="num">Samples</th><th className="num">Live</th><th className="num">Win %</th><th className="num">Avg R</th><th className="num">Model AUC</th><th className="num">Accuracy</th><th>Top rule</th></tr>
                </thead>
                <tbody>
                  {scanners.map((s) => (
                    <tr key={s.scannerId} className={current?.scannerId === s.scannerId ? 'row-active' : ''} onClick={() => setSel(s.scannerId)} style={{ cursor: 'pointer' }}>
                      <td><Link to={`/scanners/${s.scannerId}`} className="strong">{s.scannerName}</Link></td>
                      <td className="num mono">{s.samples}</td>
                      <td className="num mono">{s.liveSamples}</td>
                      <td className="num mono">{pct(s.baseline.winRate)}</td>
                      <td className={`num mono ${s.baseline.avgR >= 0 ? 'gain' : 'loss'}`}>{r(s.baseline.avgR)}</td>
                      <td className="num mono">{s.model ? s.model.auc.toFixed(2) : '–'}</td>
                      <td className="num mono">{s.model ? pct(s.model.accuracy) : '–'}</td>
                      <td className="small">{s.rules[0] ? <><Pill tone={s.rules[0].kind === 'prefer' ? 'ok' : 'danger'}>{s.rules[0].kind}</Pill> {s.rules[0].label} {s.rules[0].condition}</> : <span className="muted">no rule clears the bar</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {current && (
            <Panel title={<span>How to improve <span className="accent">{current.scannerName}</span></span>}>
              <div className="grid-2">
                <div>
                  <div className="muted small mb">Baseline: {current.baseline.n} trades · win {pct(current.baseline.winRate)} · avg {r(current.baseline.avgR)}{current.model ? ` · model AUC ${current.model.auc.toFixed(2)} on ${current.model.holdout} holdout trades` : ' · fewer than 40 trades, no model yet'}</div>
                  <RuleList rules={current.rules} baseline={current.baseline} />
                </div>
                <div>
                  <div className="muted small mb">Feature weights (standardised; positive pushes toward a win)</div>
                  {current.importance.length ? (
                    <ul className="bars">
                      {current.importance.map((f) => (
                        <li key={f.feature}>
                          <span className="bars-label">{f.label}</span>
                          <span className="bars-track"><span className={`bars-fill ${f.weight >= 0 ? 'gain-bg' : 'loss-bg'}`} style={{ width: `${Math.min(100, Math.abs(f.weight) * 60)}%` }} /></span>
                          <span className={`mono small ${f.weight >= 0 ? 'gain' : 'loss'}`}>{f.weight >= 0 ? '+' : ''}{f.weight.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="state muted">No model for this scanner yet.</div>}
                </div>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

function RuleList({ rules, baseline }: { rules: MlRule[]; baseline?: { n: number; winRate: number; avgR: number } }) {
  if (!rules.length) return <div className="state muted">No rule improves expectancy by ≥ 0.15R with enough trades{baseline ? ` (baseline ${r(baseline.avgR)} over ${baseline.n})` : ''}.</div>
  return (
    <ul className="rules">
      {rules.map((x, i) => (
        <li key={i} className="rule">
          <Pill tone={x.kind === 'prefer' ? 'ok' : 'danger'}>{x.kind}</Pill>
          <span className="rule-text">{x.text}</span>
          <span className="mono small muted">win {pct(x.winRate)} · {x.n} trades</span>
        </li>
      ))}
    </ul>
  )
}
