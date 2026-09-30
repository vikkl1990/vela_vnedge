import { useMemo, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useLearning } from '../api/queries'
import type { BookLearning, EdgeRow, LearnBucket } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { Empty, KpiTile, Loading, Panel, Pill, Segmented } from '../components/ui'
import { fmtMoney, fmtPct } from '../lib/format'

/**
 * What the journal teaches (decision 63). Everything is in R so the live book and the shadow book
 * read the same way; the questions are the ones the first week of paper trading kept raising:
 * is the expectancy real or noise, what win rate does the exit policy need, what do costs take,
 * how many stops never moved, how much of the peak the trail gives back, and where the R comes from.
 */
const r = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}R`)
const tone = (v: number | null | undefined) => (v == null ? 'muted' : v > 0 ? 'ok' : v < 0 ? 'danger' : 'muted')
const verdictTone = { paying: 'ok', undecided: 'warn', failing: 'danger' } as const

export function LearningSection() {
  const q = useLearning()
  const [book, setBook] = useState<'live' | 'shadow'>('live')
  const [group, setGroup] = useState<'byScanner' | 'byPair' | 'byTf'>('byScanner')
  const d = q.data
  const L: BookLearning | undefined = d ? d[book] : undefined
  const edgeCols = useMemo<Column<EdgeRow>[]>(
    () => [
      { key: 'label', header: group === 'byPair' ? 'Pair' : group === 'byTf' ? 'Timeframe' : 'Scanner', value: (x) => x.label, render: (x) => <span className="strong">{x.label}</span> },
      { key: 'n', header: 'Trades', numeric: true, value: (x) => x.n },
      { key: 'avgR', header: 'E[R]', numeric: true, value: (x) => x.avgR, render: (x) => <span className={x.avgR >= 0 ? 'gain' : 'loss'}>{r(x.avgR)}</span> },
      { key: 'lb', header: '90% band', numeric: true, value: (x) => x.lb90 ?? -9, render: (x) => (x.lb90 == null ? <span className="muted">under 5 trades</span> : <span className="mono small">{r(x.lb90)} … {r(x.ub90)}</span>) },
      { key: 'win', header: 'Win %', numeric: true, value: (x) => x.winRatePct, render: (x) => fmtPct(x.winRatePct) },
      { key: 'sum', header: 'ΣR', numeric: true, value: (x) => x.sumR, render: (x) => <span className={x.sumR >= 0 ? 'gain' : 'loss'}>{r(x.sumR, 1)}</span> },
      { key: 'cost', header: 'Costs / gross', numeric: true, value: (x) => x.costShare ?? 0, render: (x) => (x.costShare == null ? '–' : fmtPct(x.costShare * 100)) },
      { key: 'verdict', header: 'Verdict', value: (x) => x.verdict, render: (x) => <Pill tone={verdictTone[x.verdict]}>{x.verdict}</Pill> },
    ],
    [group],
  )
  if (q.isLoading && !d) return <Loading kind="kpi" rows={5} />
  if (!d || !L) return null
  const stops = L.stops
  return (
    <>
      <div className="row gap mb" style={{ marginTop: 16 }}>
        <h2 className="h2" style={{ margin: 0 }}>What the journal teaches</h2>
        <Segmented ariaLabel="Book" value={book} onChange={(v) => setBook(v as 'live' | 'shadow')} options={[{ value: 'live', label: 'Live paper' }, { value: 'shadow', label: `Shadow (${d.shadow.windowDays ?? 30}d)` }]} />
        <span className="muted small">{L.trades} closed trades · in R, so both books read the same way</span>
      </div>
      {L.trades === 0 ? (
        <Empty label="No closed trades in this book yet." />
      ) : (
        <>
          <div className="kpi-grid">
            <KpiTile label="Expectancy" value={r(L.avgR)} tone={L.avgR >= 0 ? 'gain' : 'loss'} sub={<span className="muted">{L.lb90 == null ? 'band needs 5 trades' : `90% band ${r(L.lb90)} … ${r(L.ub90)}`} · ΣR {r(L.sumR, 1)}</span>} />
            <KpiTile label="Win rate vs breakeven" value={`${fmtPct(L.winRatePct)} / ${L.breakevenWinPct == null ? '–' : fmtPct(L.breakevenWinPct)}`} tone={L.breakevenWinPct != null && L.winRatePct >= L.breakevenWinPct ? 'gain' : 'loss'} sub={<span className="muted">avg win {r(L.avgWinR)} · avg loss {r(L.avgLossR)}</span>} />
            <KpiTile label="Costs take" value={L.costShare == null ? '–' : fmtPct(L.costShare * 100)} tone={L.costShare != null && L.costShare > 0.5 ? 'loss' : 'neutral'} sub={<span className="muted">fees {fmtMoney(L.feesUsd)} of gross wins · net {fmtMoney(L.netUsd)}</span>} />
            <KpiTile label="Stops that never moved" value={stops.n ? `${Math.round((stops.neverMoved / stops.n) * 100)}%` : '–'} tone={stops.n && stops.neverMoved / stops.n > 0.5 ? 'loss' : 'neutral'} sub={<span className="muted">{stops.neverMoved} of {stops.n} stops · {stops.firstBar} inside the first bar · median life {stops.medianMinutes == null ? '–' : `${Math.round(stops.medianMinutes)}m`}</span>} />
            <KpiTile label="Drawdown in R" value={r(Math.min(0, ...L.curve.map((c) => c.ddR)), 1)} tone="loss" sub={<span className="muted">worst run from a peak of the cumulative R curve</span>} />
          </div>

          <div className="grid-2">
            <Panel title="Cumulative R" right={<span className="muted small">closed trades in order · shaded: distance from the peak</span>}>
              <RCurve data={L.curve} />
            </Panel>
            <Panel title="Where the R goes" pad={false} right={<span className="muted small">give-back = peak R − realised R</span>}>
              <table className="table small">
                <thead><tr><th>exit</th><th className="num">trades</th><th className="num">avg R</th><th className="num">median peak</th><th className="num">give-back</th><th className="num">ΣR</th></tr></thead>
                <tbody>
                  {L.exits.map((e) => (
                    <tr key={e.reason}><td className="mono">{e.reason}</td><td className="num">{e.n}</td><td className={`num ${e.avgR >= 0 ? 'gain' : 'loss'}`}>{r(e.avgR)}</td><td className="num">{r(e.medianPeakR)}</td><td className="num">{r(e.giveBackR)}</td><td className={`num ${e.sumR >= 0 ? 'gain' : 'loss'}`}>{r(e.sumR, 1)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>

          <Panel
            title="Edge with confidence"
            pad={false}
            right={<Segmented ariaLabel="Group" value={group} onChange={(v) => setGroup(v as typeof group)} options={[{ value: 'byScanner', label: 'Scanner' }, { value: 'byPair', label: 'Pair' }, { value: 'byTf', label: 'Timeframe' }]} />}
          >
            <p className="muted small" style={{ padding: '8px 12px 0' }}>Paying = the whole 90% band is above zero; failing = the whole band is below; everything else is undecided and needs more trades, not a decision.</p>
            <DataTable columns={edgeCols} rows={L[group]} rowKey={(x) => x.key} defaultSort={{ key: 'lb', dir: 'desc' }} maxHeight={440} caption="Expectancy with a confidence band" emptyLabel="No trades." />
          </Panel>

          <div className="grid-2">
            <Panel title="Hold time vs R" right={<span className="muted small">avg R per trade by how long it was held</span>}>
              <BucketBars data={L.holds} />
            </Panel>
            <Panel title="Hour of entry (IST) vs R" right={<span className="muted small">avg R per trade</span>}>
              <BucketBars data={L.hoursIst} />
            </Panel>
          </div>

          <Panel title="The pipeline" right={<span className="muted small">how scanners earn their way in</span>}>
            <dl className="kv-list kv-row">
              {['candidate', 'shadow', 'proposed', 'live', 'demote_proposed', 'retired'].map((s) => (
                <div key={s}><dt>{s.replace('_', ' ')}</dt><dd className="mono">{d.funnel.stages[s] ?? 0}</dd></div>
              ))}
              <div><dt>Shadow age (median)</dt><dd className="mono">{d.funnel.shadowAgeDays.median == null ? '–' : `${d.funnel.shadowAgeDays.median.toFixed(0)}d`}{d.funnel.shadowAgeDays.over30 ? <span className="muted"> · {d.funnel.shadowAgeDays.over30} over 30d</span> : null}</dd></div>
            </dl>
            {d.funnel.lastHunt && (
              <p className="muted small">
                Last hunt {d.funnel.lastHunt.at ? new Date(d.funnel.lastHunt.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''}: {Object.entries(d.funnel.lastHunt).filter(([k, v]) => typeof v === 'number' && k !== 'at').map(([k, v]) => `${k} ${v}`).join(' · ')}
              </p>
            )}
          </Panel>
        </>
      )}
    </>
  )
}

function RCurve({ data }: { data: BookLearning['curve'] }) {
  if (!data.length) return <Empty label="No closed trades yet." />
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="i" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} fontFamily="JetBrains Mono, monospace" />
        <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${v.toFixed(0)}R`} fontFamily="JetBrains Mono, monospace" />
        <Tooltip contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v, name) => [`${Number(v).toFixed(2)}R`, name === 'cumR' ? 'cumulative' : 'from peak']} labelFormatter={(l, p) => { const t = (p?.[0]?.payload as { t?: number } | undefined)?.t; return `trade ${l}${t ? ' · ' + new Date(t).toISOString().slice(0, 16).replace('T', ' ') : ''}` }} />
        <Area type="monotone" dataKey="ddR" stroke="none" fill="var(--loss)" fillOpacity={0.18} isAnimationActive={false} />
        <Area type="monotone" dataKey="cumR" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function BucketBars({ data }: { data: LearnBucket[] }) {
  if (!data.some((b) => b.n > 0)) return <Empty label="No trades yet." />
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} interval={0} fontFamily="JetBrains Mono, monospace" />
        <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => `${v.toFixed(1)}R`} fontFamily="JetBrains Mono, monospace" />
        <Tooltip contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => [`${Number(v).toFixed(2)}R`, 'avg R']} labelFormatter={(l, p) => `${l} · ${(p?.[0]?.payload as { n?: number } | undefined)?.n ?? 0} trades`} />
        <Bar dataKey="avgR" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((b, i) => <Cell key={i} fill={b.avgR >= 0 ? 'var(--gain)' : 'var(--loss)'} fillOpacity={b.n ? 1 : 0.2} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
