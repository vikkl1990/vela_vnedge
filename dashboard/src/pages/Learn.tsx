import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useMl, useMlYardstick } from '../api/queries'
import type { MlRule, MlScannerInsight, YardBook } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { Empty, ErrorState, Loading, PageTitle, Panel, Pill, Segmented, Time } from '../components/ui'
import { Callout, EmptyState, Stat, StatGrid, TabPanel, Tabs } from '../components/kit'
import { fmtPct } from '../lib/format'
import { useToast } from '../lib/toast'
import '../styles/pages/learn.css'

/** Model probabilities are 0–1; show as a percentage with 1 decimal. */
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : fmtPct(v * 100))
const r = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`)

export function Learn() {
  const ml = useMl()
  const qc = useQueryClient()
  const toast = useToast()
  const [sel, setSel] = useState<string>('')
  const [tab, setTab] = useState<'scanners' | 'gate' | 'global' | 'tf'>('scanners')
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
      { key: 'live', header: 'Account (all time)', numeric: true, value: (s) => s.liveSamples },
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
      <PageTitle
        sub="A win-probability model per scanner, trained on the entry features of every backtest and account trade. The buckets turn that data into plain rules."
        actions={d ? (
          <button className="btn btn-cta" onClick={() => train.mutate()} disabled={train.isPending || (d.counts?.total ?? d.samples) < 30} title="Models also retrain by themselves within two minutes after new samples arrive">
            {train.isPending ? 'Training…' : 'Train now'}
          </button>
        ) : undefined}
      />
      {d?.config && d.config.minProb > 0 ? (
        <Callout tone="warn" title={<>The gate is on at <span className="mono">{pct(d.config.minProb)}</span></>}>
          Entries the model rates below it are refused. The yardstick is exploratory; it does not certify that setting.
        </Callout>
      ) : (
        <Callout tone="info" title="Advisory only">
          The model gates nothing (<span className="mono">ml.minProb 0</span>). Threshold comparisons use saved entry predictions on trades that were eligible and executed. A threshold picked here needs a frozen forward test before use. Gate and score settings are in Settings, Machine learning.
        </Callout>
      )}
      {ml.isLoading && !d && (
        <>
          <Loading kind="kpi" rows={5} />
          <Panel title="Scanners">
            <Loading rows={6} />
          </Panel>
        </>
      )}
      {ml.isError && !d && <ErrorState error={ml.error} onRetry={() => ml.refetch()} />}
      {d && (
        <>
          <StatGrid min={200}>
            <Stat label="Samples" value={String(d.samples)} sub={`${d.liveSinceReset} account since the reset · ${d.liveSamples - d.liveSinceReset} from earlier accounts · ${d.samples - d.liveSamples} backtest`} />
            <Stat label="Scanner models" value={String(d.scannersWithModel)} sub="Scanners with 40 or more trades" />
            <Stat label="Global accuracy" value={pct(d.global?.model?.accuracy)} sub={`holdout ${d.global?.model?.holdout ?? 0} · base ${pct(d.global?.model?.baseWinRate)}`} tone={(d.global?.model?.accuracy ?? 0) > (d.global?.model?.baseWinRate ?? 0) ? 'gain' : undefined} />
            <Stat label="Global AUC" value={d.global?.model ? d.global.model.auc.toFixed(2) : '–'} sub="0.5 is a coin flip" tone={(d.global?.model?.auc ?? 0) > 0.58 ? 'gain' : (d.global?.model?.auc ?? 1) < 0.52 ? 'loss' : undefined} />
            <Stat label="Trained" title={d.trainedAt ? new Date(d.trainedAt).toISOString() : undefined} value={d.trainedAt ? <Time t={d.trainedAt} mode="ago" /> : 'never'} sub={d.config ? `gate ${d.config.minProb > 0 ? pct(d.config.minProb) : 'off'} · as score ${d.config.useAsScore ? 'on' : 'off'}` : ''} />
          </StatGrid>
          {d.eligibility && <p className="small muted learn-note">Training eligibility: {d.eligibility.eligible} of {d.eligibility.stored} stored samples; {d.eligibility.excluded} excluded or outside the training limit. Outcomes need a recorded resolution time.</p>}

          <Tabs
            idPrefix="learn"
            label="Learning views"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'scanners', label: 'By scanner', count: scanners.length },
              { id: 'gate', label: 'Would the gate have paid?' },
              { id: 'global', label: 'Global model' },
              ...(d.timeframeModels?.length ? [{ id: 'tf' as const, label: 'Timeframe models', count: d.timeframeModels.length }] : []),
            ]}
          />

          <TabPanel idPrefix="learn" id="scanners" value={tab}>
            <div className="stack">
              <Panel
                title={<span>Per-scanner insights <span className="muted small">({scanners.length} with data)</span></span>}
                right={<span className="muted small">Click a row to inspect</span>}
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
              {current ? (
                <Panel title={<span>How to improve <span className="accent">{current.scannerName}</span></span>}>
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
              ) : (
                <EmptyState title="No scanner has samples yet" hint="Run a backtest or let live scanners trade. Samples appear here as trades close." />
              )}
            </div>
          </TabPanel>

          <TabPanel idPrefix="learn" id="gate" value={tab}>
            <Yardstick />
          </TabPanel>

          <TabPanel idPrefix="learn" id="global" value={tab}>
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
          </TabPanel>

          {!!d.timeframeModels?.length && (
            <TabPanel idPrefix="learn" id="tf" value={tab}>
              <Panel title="Timeframe models used for entry scoring" pad={false}>
                <p className="small muted learn-note-in">Each horizon uses its own model. The fixed 55% cutoff below is for diagnosis only. Net R comes from untouched test trades and does not model portfolio reuse. Positive probability skill beats a constant training-period win rate.</p>
                <div className="table-wrap"><table className="table small"><thead><tr><th>Scanner</th><th>TF</th><th>Test trades</th><th>AUC</th><th>Probability skill</th><th>All net R</th><th>55% kept</th><th>Kept net R</th><th>Rejected net R</th></tr></thead><tbody>{d.timeframeModels.map(m => <tr key={`${m.scannerId}:${m.tf}`}><td>{m.scannerId ? scanners.find(s => s.scannerId === m.scannerId)?.scannerName ?? m.scannerId : 'Timeframe fallback'}</td><td>{m.tf}</td><td>{m.model.holdout}</td><td>{m.model.auc.toFixed(2)}</td><td>{pct(m.model.economic?.calibratedBrierSkill)}</td><td>{r(m.model.economic?.testNetR)}</td><td>{m.model.economic?.selectedN ?? '–'}</td><td>{r(m.model.economic?.selectedNetR)}</td><td>{r(m.model.economic?.rejectedNetR)}</td></tr>)}</tbody></table></div>
              </Panel>
            </TabPanel>
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

/** Would the gate have paid (decision 108)? Both books, bucketed by the probability each trade had at entry. */
function Yardstick() {
  const q = useMlYardstick(60)
  const [book, setBook] = useState<'shadow' | 'live'>('shadow')
  const y = q.data
  if (q.isLoading && !y) return <Panel title="Would the gate have paid?"><Loading rows={4} /></Panel>
  if (q.isError && !y) return <Panel title="Would the gate have paid?"><ErrorState error={q.error} onRetry={() => q.refetch()} /></Panel>
  if (!y) return null
  const b: YardBook = y[book]
  return (
    <Panel
      title={<span>Would the gate have paid? <Pill tone="warn">{y.call.candidateMinProb != null ? `research candidate ${pct(y.call.candidateMinProb)}` : 'no candidate'}</Pill></span>}
      right={<span className="muted small">last {y.windowDays} days · model trained {y.model.trainedAt ? <Time t={y.model.trainedAt} mode="datetime" /> : 'never'} · holdout AUC {y.model.holdoutAuc?.toFixed(2) ?? '–'}</span>}
    >
      <p className="small" style={{ marginTop: 0 }}>{y.call.text}</p>
      <div className="row gap mb">
        <Segmented
          ariaLabel="Book"
          value={book}
          onChange={(v) => setBook(v as 'shadow' | 'live')}
          options={[
            { value: 'shadow', label: `Shadow book · ${y.shadow.trades} trades` },
            { value: 'live', label: `Account · ${y.live.trades} trades` },
          ]}
        />
        <span className="muted small">
          Saved entry predictions only · {b.scoredAtEntry} scored, {b.unscored} without an entry score (kept by every hypothetical gate) · ranking AUC {b.auc?.toFixed(2) ?? '–'}
        </span>
      </div>
      <p className="small muted">{b.verifiedAtEntry??0} entry predictions have verified model, training-cutoff, feature and policy receipts. Only these can propose a research candidate. Older saved scores remain descriptive; missing provenance is not reconstructed. No candidate becomes a gate without a frozen forward evaluation.</p>
      {!!b.later?.trades && <details className="mb"><summary>Later rescoring · {b.later.trades} trades · excluded from threshold evaluation</summary><p className="small muted">These probabilities were calculated after entry with a later model. They are exploratory and cannot establish an executable historical gate. Ranking AUC {b.later.auc?.toFixed(2) ?? '–'}.</p><table className="table small"><thead><tr><th>Later P(win)</th><th>Trades</th><th>Average R</th></tr></thead><tbody>{b.later.buckets.map(x=><tr key={x.label}><td>{x.label}</td><td>{x.n}</td><td>{x.n?r(x.avgR):'–'}</td></tr>)}</tbody></table></details>}
      <div className="grid-2">
        <div>
          <div className="muted small mb">By the probability at entry</div>
          <table className="table small">
            <thead><tr><th>P(win)</th><th className="num">trades</th><th className="num">win %</th><th className="num">avg R</th><th className="num">ΣR</th></tr></thead>
            <tbody>
              {b.buckets.map((x) => (
                <tr key={x.label}><td className="mono">{x.label}</td><td className="num">{x.n}</td><td className="num">{x.n ? fmtPct(x.winRatePct) : '–'}</td><td className={`num ${x.avgR >= 0 ? 'gain' : 'loss'}`}>{x.n ? r(x.avgR) : '–'}</td><td className={`num ${x.sumR >= 0 ? 'gain' : 'loss'}`}>{x.n ? r(x.sumR) : '–'}</td></tr>
              ))}
              <tr><td className="muted">all</td><td className="num">{b.trades}</td><td className="num"></td><td className={`num ${b.allAvgR >= 0 ? 'gain' : 'loss'}`}>{r(b.allAvgR)}</td><td className={`num ${b.allSumR >= 0 ? 'gain' : 'loss'}`}>{r(b.allSumR)}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="muted small mb">A gate at … would have</div>
          <table className="table small">
            <thead><tr><th>min P</th><th className="num">dropped</th><th className="num">their ΣR</th><th className="num">kept</th><th className="num">kept avg</th><th className="num">book Δ</th></tr></thead>
            <tbody>
              {b.thresholds.map((x) => (
                <tr key={x.minProb} className={b.verdict.minProb === x.minProb ? 'row-active' : undefined}>
                  <td className="mono">{pct(x.minProb)}</td><td className="num">{x.dropped}</td><td className={`num ${x.droppedSumR <= 0 ? 'gain' : 'loss'}`}>{x.dropped ? r(x.droppedSumR) : '–'}</td><td className="num">{x.kept}</td><td className={`num ${x.keptAvgR >= 0 ? 'gain' : 'loss'}`}>{r(x.keptAvgR)}</td><td className={`num ${x.deltaSumR >= 0 ? 'gain' : 'loss'}`}>{r(x.deltaSumR)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{b.verdict.text}. A gate pays only when what it drops is a losing set of 20+ trades worth −2R or more at −0.1R each; raising the average by discarding winners does not count.</p>
        </div>
      </div>
    </Panel>
  )
}
