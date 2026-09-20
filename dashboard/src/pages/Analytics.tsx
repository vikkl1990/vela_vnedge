import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts'
import { useAnalytics } from '../api/queries'
import type { Agg, Analytics as AnalyticsData } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { Empty, ErrorState, KpiTile, Loading, PageTitle, Panel, Segmented, Time } from '../components/ui'
import { fmtMoney, fmtPct, fmtPnl } from '../lib/format'

type Mode = 'backtest' | 'live'
const EMPTY_AGG: Agg = { trades: 0, wins: 0, winRatePct: 0, pnl: 0, fees: 0, profitFactor: null }
const pf = (v: number | null) => (v == null ? '–' : v >= 999 ? '∞' : v.toFixed(2))
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type PairRow = AnalyticsData['symbols'][number] & { agg: Agg }
type ScannerRow = AnalyticsData['scanners'][number] & { agg: Agg }
type ExitRow = AnalyticsData['exits'][number]

export function Analytics() {
  const q = useAnalytics()
  const [mode, setMode] = useState<Mode>('backtest')
  const d = q.data
  const pick = useCallback((x: { backtest: Agg; live: Agg | null }): Agg => (mode === 'live' ? (x.live ?? EMPTY_AGG) : x.backtest), [mode])

  const symbols = useMemo<PairRow[]>(
    () =>
      (d?.symbols ?? [])
        .map((s) => ({ ...s, agg: pick(s) }))
        .filter((s) => s.agg.trades > 0)
        .sort((a, b) => b.agg.pnl - a.agg.pnl),
    [d, pick],
  )
  const scanners = useMemo<ScannerRow[]>(
    () =>
      (d?.scanners ?? [])
        .map((s) => ({ ...s, agg: pick(s) }))
        .filter((s) => s.agg.trades > 0)
        .sort((a, b) => b.agg.pnl - a.agg.pnl),
    [d, pick],
  )

  // ---- heatmap: precompute every cell (colour + tooltip) once per data/mode ----
  const heat = useMemo(() => {
    if (!d) return { rows: [] as { id: string; name: string; cells: ({ text: string; bg: string; title: string } | null)[] }[], cols: [] as string[] }
    const cell = new Map<string, Agg>()
    for (const m of d.matrix) {
      const a = pick(m)
      if (a.trades > 0) cell.set(`${m.scannerId}|${m.symbol}`, a)
    }
    const cols = symbols.map((s) => s.symbol)
    const maxAbs = Math.max(1, ...Array.from(cell.values()).map((a) => Math.abs(a.pnl)))
    const rows = scanners.map((s) => ({
      id: s.id,
      name: s.name,
      cells: cols.map((c) => {
        const a = cell.get(`${s.id}|${c}`)
        if (!a) return null
        const t = Math.min(1, Math.abs(a.pnl) / maxAbs)
        const bg = a.pnl >= 0 ? `rgba(76, 175, 110, ${0.12 + t * 0.55})` : `rgba(230, 80, 60, ${0.12 + t * 0.55})`
        const title = `${s.name} · ${c}\n${a.trades} trades · win ${fmtPct(a.winRatePct)} · PF ${pf(a.profitFactor)}\nnet ${fmtPnl(a.pnl)} · fees ${fmtMoney(a.fees)}`
        return { text: fmtPnl(a.pnl, 0), bg, title }
      }),
    }))
    return { rows, cols }
  }, [d, pick, scanners, symbols])

  const tot = d ? (mode === 'live' ? d.totals.live : d.totals.backtest) : null
  const best = symbols[0]
  const worst = symbols[symbols.length - 1]
  const bestSc = scanners[0]

  const pairCols = useMemo<Column<PairRow>[]>(
    () => [
      { key: 'symbol', header: 'Pair', value: (s) => s.symbol, render: (s) => <span className="strong mono">{s.symbol}</span> },
      { key: 'trades', header: 'Trades', numeric: true, value: (s) => s.agg.trades },
      { key: 'win', header: 'Win %', numeric: true, value: (s) => s.agg.winRatePct, render: (s) => fmtPct(s.agg.winRatePct) },
      { key: 'pf', header: 'PF', numeric: true, value: (s) => s.agg.profitFactor, render: (s) => pf(s.agg.profitFactor) },
      { key: 'pnl', header: 'Net PnL', numeric: true, value: (s) => s.agg.pnl, render: (s) => <span className={s.agg.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(s.agg.pnl)}</span> },
      { key: 'scanners', header: 'Scanners', numeric: true, value: (s) => s.scannersOn },
      { key: 'profitable', header: 'Profitable', numeric: true, value: (s) => s.profitableScanners },
      { key: 'open', header: 'Open', numeric: true, value: (s) => s.openPositions, render: (s) => (s.openPositions ? s.openPositions : <span className="muted">–</span>) },
    ],
    [],
  )
  const scannerCols = useMemo<Column<ScannerRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Scanner',
        value: (s) => s.name,
        render: (s) => (
          <>
            <Link to={`/scanners/${s.id}`} className="strong">
              {s.name}
            </Link>{' '}
            <span className="muted small">{s.author}</span>
          </>
        ),
      },
      { key: 'pairs', header: 'Pairs', numeric: true, value: (s) => s.symbols },
      { key: 'trades', header: 'Trades', numeric: true, value: (s) => s.agg.trades },
      { key: 'win', header: 'Win %', numeric: true, value: (s) => s.agg.winRatePct, render: (s) => fmtPct(s.agg.winRatePct) },
      { key: 'pf', header: 'PF', numeric: true, value: (s) => s.agg.profitFactor, render: (s) => pf(s.agg.profitFactor) },
      { key: 'pnl', header: 'Net PnL', numeric: true, value: (s) => s.agg.pnl, render: (s) => <span className={s.agg.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(s.agg.pnl)}</span> },
      { key: 'open', header: 'Open', numeric: true, value: (s) => s.openPositions, render: (s) => (s.openPositions ? s.openPositions : <span className="muted">–</span>) },
    ],
    [],
  )
  const exitCols = useMemo<Column<ExitRow>[]>(
    () => [
      { key: 'reason', header: 'Exit reason', value: (e) => e.reason, render: (e) => <span className="mono">{e.reason}</span> },
      { key: 'trades', header: 'Trades', numeric: true, value: (e) => e.trades },
      { key: 'win', header: 'Win %', numeric: true, value: (e) => e.winRatePct, render: (e) => fmtPct(e.winRatePct) },
      { key: 'pnl', header: 'Net PnL', numeric: true, value: (e) => e.pnl, render: (e) => <span className={e.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(e.pnl)}</span> },
      { key: 'fees', header: 'Fees', numeric: true, value: (e) => e.fees, render: (e) => fmtMoney(e.fees) },
      {
        key: 'avg',
        header: 'Avg / trade',
        numeric: true,
        value: (e) => e.pnl / Math.max(1, e.trades),
        render: (e) => <span className={e.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(e.pnl / Math.max(1, e.trades))}</span>,
      },
    ],
    [],
  )

  const emptyHint = mode === 'live' ? 'Closed paper trades appear here as scanners exit positions.' : 'Backtests run during warm-up; enable a scanner to populate this.'

  return (
    <div className="page">
      <PageTitle pre="Where the edge," accent="lives." sub="Which pairs pay, which scanners earn, and where the two meet. Backtest = enabled scanners on their tuned symbols over the loaded history; Live = closed paper trades." />
      <div className="row gap mb">
        <Segmented
          ariaLabel="Data source"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: 'backtest', label: 'Backtest' },
            { value: 'live', label: 'Live' },
          ]}
        />
        {d && (
          <span className="muted small">
            {mode === 'live' ? `${d.totals.live.trades} closed trades` : `${d.totals.backtest.trades} backtest trades`} · updated <Time t={d.at} />
          </span>
        )}
      </div>
      {q.isLoading && !d && (
        <>
          <Loading kind="kpi" rows={5} />
          <div className="grid-2">
            <Panel title="Pairs" pad={false}>
              <Loading kind="table" rows={6} cols={8} />
            </Panel>
            <Panel title="Scanners" pad={false}>
              <Loading kind="table" rows={6} cols={7} />
            </Panel>
          </div>
        </>
      )}
      {q.isError && !d && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && tot && (
        <>
          <div className="kpi-grid">
            <KpiTile label={`${mode} net PnL`} value={fmtPnl(tot.pnl)} tone={tot.pnl >= 0 ? 'gain' : 'loss'} sub={<span className="muted">fees {fmtMoney(tot.fees)} · {tot.trades} trades</span>} />
            <KpiTile label="Win rate" value={fmtPct(tot.winRatePct)} sub={<span className="muted">PF {pf(tot.profitFactor)}</span>} />
            <KpiTile label="Best pair" value={best ? best.symbol : '–'} tone="gain" sub={best ? <span className="gain">{fmtPnl(best.agg.pnl)} · {best.agg.trades} trades · {fmtPct(best.agg.winRatePct)}</span> : undefined} />
            <KpiTile label="Worst pair" value={worst && worst.agg.pnl < 0 ? worst.symbol : '–'} tone="loss" sub={worst && worst.agg.pnl < 0 ? <span className="loss">{fmtPnl(worst.agg.pnl)} · {worst.agg.trades} trades</span> : <span className="muted">no losing pair</span>} />
            <KpiTile label="Best scanner" value={bestSc ? bestSc.name.slice(0, 22) : '–'} tone="gain" sub={bestSc ? <span className="gain">{fmtPnl(bestSc.agg.pnl)} · PF {pf(bestSc.agg.profitFactor)}</span> : undefined} />
          </div>

          <div className="grid-2">
            <Panel title="Pairs" pad={false}>
              <DataTable
                columns={pairCols}
                rows={symbols}
                rowKey={(s) => s.symbol}
                defaultSort={{ key: 'pnl', dir: 'desc' }}
                maxHeight={480}
                caption="PnL by pair"
                emptyLabel={
                  <span>
                    No {mode} trades yet<span className="empty-hint">{emptyHint}</span>
                  </span>
                }
              />
            </Panel>
            <Panel title="Scanners" pad={false}>
              <DataTable
                columns={scannerCols}
                rows={scanners}
                rowKey={(s) => s.id}
                defaultSort={{ key: 'pnl', dir: 'desc' }}
                maxHeight={480}
                caption="PnL by scanner"
                emptyLabel={
                  <span>
                    No {mode} trades yet<span className="empty-hint">{emptyHint}</span>
                  </span>
                }
              />
            </Panel>
          </div>

          <Panel
            title={
              <span>
                Scanner × pair <span className="muted small">net PnL · hover for detail</span>
              </span>
            }
            pad={false}
          >
            <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
              <table className="table heat">
                <caption className="sr-only">Net PnL by scanner and pair</caption>
                <thead className="sticky">
                  <tr>
                    <th scope="col">Scanner</th>
                    {heat.cols.map((c) => (
                      <th key={c} scope="col" className="num heat-col ta-r">
                        {c.replace(/USD$/, '')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heat.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" className="strong small heat-rowhead">
                        <Link to={`/scanners/${r.id}`} className="link">
                          {r.name.length > 30 ? `${r.name.slice(0, 29)}…` : r.name}
                        </Link>
                      </th>
                      {r.cells.map((c, i) =>
                        c ? (
                          <td key={heat.cols[i]} className="heat-cell mono small num" style={{ background: c.bg }} title={c.title}>
                            {c.text}
                          </td>
                        ) : (
                          <td key={heat.cols[i]} className="heat-cell heat-empty" />
                        ),
                      )}
                    </tr>
                  ))}
                  {!heat.rows.length && (
                    <tr>
                      <td colSpan={Math.max(1, heat.cols.length + 1)}>
                        <Empty label="No data." hint={emptyHint} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid-2">
            <Panel title="PnL by hour of entry (UTC)">
              <TimeBars data={d.hours.map((h) => ({ label: String(h.hour).padStart(2, '0'), agg: mode === 'live' ? h.live : h.backtest }))} />
            </Panel>
            <Panel title="PnL by weekday of entry">
              <TimeBars data={d.weekdays.map((w) => ({ label: DOW[w.dow], agg: mode === 'live' ? w.live : w.backtest }))} />
            </Panel>
          </div>

          <Panel title="Live exits" pad={false}>
            <DataTable
              columns={exitCols}
              rows={d.exits}
              rowKey={(e) => e.reason}
              defaultSort={{ key: 'pnl', dir: 'desc' }}
              caption="Live exits by reason"
              emptyLabel={
                <span>
                  No closed live trades yet<span className="empty-hint">Exit reasons are tallied from closed paper trades.</span>
                </span>
              }
            />
          </Panel>
        </>
      )}
    </div>
  )
}

function TimeBars({ data }: { data: Array<{ label: string; agg: Agg }> }) {
  const rows = useMemo(() => data.map((x) => ({ label: x.label, pnl: Number(x.agg.pnl.toFixed(2)), trades: x.agg.trades, win: x.agg.winRatePct })), [data])
  if (!rows.some((r) => r.trades > 0)) return <Empty label="No trades yet." hint="Bars fill in as trades close." />
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} interval={0} fontFamily="JetBrains Mono, monospace" />
        <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtPnl(v, 0)} domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]} fontFamily="JetBrains Mono, monospace" />
        <Tooltip
          contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          formatter={(v) => [fmtPnl(Number(v)), 'net']}
          labelFormatter={(l, payload) => {
            const p = (payload?.[0]?.payload ?? {}) as { trades?: number; win?: number }
            return `${l} · ${p.trades ?? 0} trades · win ${fmtPct(p.win ?? 0)}`
          }}
        />
        <Bar dataKey="pnl" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.pnl >= 0 ? 'var(--gain)' : 'var(--loss)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
