import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useMl } from '../api/queries'
import type { MlRule, MlScannerInsight } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { Empty, ErrorState, KpiTile, Loading, PageTitle, Panel, Pill, Time } from '../components/ui'
import { fmtPct } from '../lib/format'
import { useToast } from '../lib/toast'

/** Model probabilities are 0–1; show as a percentage with 1 decimal. */
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : fmtPct(v * 100))
const r = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`)

export function Learn() {
  const ml = useMl()
  const qc = useQueryClient()
  const toast = useToast()
  const [sel, setSel] = useState<string>('')
  const train = useMutation({
    mutationFn: () => api.mlTrain(),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['ml'] })
      toast.success('Models trained', `${s.samples} samples · ${s.scannersWithModel} scanner models`)
    },
    onError: (e) => toast.error('Training failed', (e as Error).message),
  })
  const d = ml.data
  const scanners = useMemo(() => (d?.scanners ?? []).filter((s) => s.samples > 0), [d])
  const current: MlScannerInsight | undefined = scanners.find((s) => s.scannerId === sel) ?? scanners[0]

  const cols = useMemo<Column<MlScannerInsight>[]>(
    () => [
      {
        key: 'name',
        header: 'Scanner',
        value: (s) => s.scannerName,
        render: (s) => (
          <Link to={`/scanners/${s.scannerId}`} className="strong" onClick={(e) => e.stopPropagation()}>
            {s.scannerName}
          </Link>
        ),
      },
      { key: 'samples', header: 'Samples', numeric: true, value: (s) => s.samples },
      { key: 'live', header: 'Live', numeric: true, value: (s) => s.liveSamples },
      { key: 'win', header: 'Win %', numeric: true, value: (s) => s.baseline.winRate, render: (s) => pct(s.baseline.winRate) },
      { key: 'avgR', header: 'Avg R', numeric: true, value: (s) => s.baseline.avgR, render: (s) => <span className={s.baseline.avgR >= 0 ? 'gain' : 'loss'}>{r(s.baseline.avgR)}</span> },
      { key: 'auc', header: 'Model AUC', numeric: true, value: (s) => s.model?.auc ?? null, render: (s) => (s.model ? s.model.auc.toFixed(2) : '–'), title: '0.5 = coin flip' },
      { key: 'acc', header: 'Accuracy', numeric: true, value: (s) => s.model?.accuracy ?? null, render: (s) => (s.model ? pct(s.model.accuracy) : '–') },
      {
        key: 'rule',
        header: 'Top rule',
        value: (s) => s.rules[0]?.text ?? '',
        render: (s) =>
          s.rules[0] ? (
            <span className="small">
              <Pill tone={s.rules[0].kind === 'prefer' ? 'ok' : 'danger'}>{s.rules[0].kind}</Pill> {s.rules[0].label} {s.rules[0].condition}
            </span>
          ) : (
            <span className="muted small">no rule clears the bar</span>
          ),
      },
    ],
    [],
  )

  return (
    <div className="page">
      <PageTitle pre="Every trade," accent="learned" post="from." sub="Entry-time features of every backtest and paper trade train a win-probability model per scanner; bucket analysis turns the data into concrete rules." />
      {ml.isLoading && !d && (
        <>
          <Loading kind="kpi" rows={5} />
          <div className="grid-2">
            <Panel title="Global feature weights">
              <Loading rows={6} />
            </Panel>
            <Panel title="Global rules">
              <Loading rows={3} />
            </Panel>
          </div>
        </>
      )}
      {ml.isError && !d && <ErrorState error={ml.error} onRetry={() => ml.refetch()} />}
      {d && (
        <>
          <div className="kpi-grid">
            <KpiTile label="Samples" value={String(d.samples)} sub={`${d.liveSamples} paper · ${d.samples - d.liveSamples} backtest`} />
            <KpiTile label="Scanner models" value={String(d.scannersWithModel)} sub="≥ 40 trades each" />
            <KpiTile label="Global accuracy" value={pct(d.global?.model?.accuracy)} sub={`holdout ${d.global?.model?.holdout ?? 0} · base ${pct(d.global?.model?.baseWinRate)}`} tone={(d.global?.model?.accuracy ?? 0) > (d.global?.model?.baseWinRate ?? 0) ? 'gain' : undefined} />
            <KpiTile label="Global AUC" value={d.global?.model ? d.global.model.auc.toFixed(2) : '–'} sub="0.5 = coin flip" tone={(d.global?.model?.auc ?? 0) > 0.58 ? 'gain' : (d.global?.model?.auc ?? 1) < 0.52 ? 'loss' : undefined} />
            <KpiTile label="Trained" value={d.trainedAt ? <Time t={d.trainedAt} mode="datetime" /> : 'never'} sub={d.config ? `gate ${d.config.minProb > 0 ? pct(d.config.minProb) : 'off'} · as score ${d.config.useAsScore ? 'on' : 'off'}` : ''} />
          </div>
          <div className="row gap">
            <button className="btn btn-cta" onClick={() => train.mutate()} disabled={train.isPending || d.samples < 30}>
              {train.isPending ? 'Training…' : 'Train now'}
            </button>
            <span className="muted small">Models retrain automatically 30 s after new samples arrive. Gate and score usage live in Settings → Machine learning.</span>
          </div>

          <div className="grid-2">
            <Panel title="Global feature weights">
              {d.global ? (
                <WeightBars items={d.global.importance.slice(0, 12)} />
              ) : (
                <Empty label="Not enough samples yet (need 30+)." hint="Backtests fill this in during warm-up." />
              )}
            </Panel>
            <Panel title="Global rules">
              <RuleList rules={d.global?.rules ?? []} baseline={d.global?.baseline} />
            </Panel>
          </div>

          <Panel
            title={
              <span>
                Per-scanner insights <span className="muted small">({scanners.length} with data)</span>
              </span>
            }
            right={<span className="muted small">click a row to inspect</span>}
            pad={false}
          >
            <DataTable
              columns={cols}
              rows={scanners}
              rowKey={(s) => s.scannerId}
              defaultSort={{ key: 'samples', dir: 'desc' }}
              onRowClick={(s) => setSel(s.scannerId)}
              rowClass={(s) => (current?.scannerId === s.scannerId ? 'row-active' : undefined)}
              maxHeight={520}
              caption="Per-scanner model insights"
              emptyLabel={
                <span>
                  No scanner has samples yet<span className="empty-hint">Run a backtest or let live scanners trade to collect samples.</span>
                </span>
              }
            />
          </Panel>

          {current && (
            <Panel
              title={
                <span>
                  How to improve <span className="accent">{current.scannerName}</span>
                </span>
              }
            >
              <div className="grid-2">
                <div>
                  <div className="muted small mb">
                    Baseline: {current.baseline.n} trades · win {pct(current.baseline.winRate)} · avg {r(current.baseline.avgR)}
                    {current.model ? ` · model AUC ${current.model.auc.toFixed(2)} on ${current.model.holdout} holdout trades` : ' · fewer than 40 trades, no model yet'}
                  </div>
                  <RuleList rules={current.rules} baseline={current.baseline} />
                </div>
                <div>
                  <div className="muted small mb">Feature weights (standardised; positive pushes toward a win)</div>
                  {current.importance.length ? <WeightBars items={current.importance} /> : <Empty label="No model for this scanner yet." hint="Needs 40+ trades." />}
                </div>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

function WeightBars({ items }: { items: { feature: string; label: string; weight: number }[] }) {
  return (
    <ul className="bars">
      {items.map((f) => (
        <li key={f.feature}>
          <span className="bars-label">{f.label}</span>
          <span className="bars-track">
            <span className={`bars-fill ${f.weight >= 0 ? 'gain-bg' : 'loss-bg'}`} style={{ width: `${Math.min(100, Math.abs(f.weight) * 60)}%` }} />
          </span>
          <span className={`mono small num ${f.weight >= 0 ? 'gain' : 'loss'}`}>
            {f.weight >= 0 ? '+' : '−'}
            {Math.abs(f.weight).toFixed(2)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RuleList({ rules, baseline }: { rules: MlRule[]; baseline?: { n: number; winRate: number; avgR: number } }) {
  if (!rules.length)
    return <Empty label="No rule improves expectancy by ≥ 0.15R with enough trades." hint={baseline ? `Baseline ${r(baseline.avgR)} over ${baseline.n} trades.` : undefined} />
  return (
    <ul className="rules">
      {rules.map((x, i) => (
        <li key={i} className="rule">
          <Pill tone={x.kind === 'prefer' ? 'ok' : 'danger'}>{x.kind}</Pill>
          <span className="rule-text">{x.text}</span>
          <span className="mono small muted">
            win {pct(x.winRate)} · {x.n} trades
          </span>
        </li>
      ))}
    </ul>
  )
}
