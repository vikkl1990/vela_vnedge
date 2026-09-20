import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell } from 'recharts'
import { useAnalytics } from '../api/queries'
import type { Agg } from '../api/types'
import { ErrorState, KpiTile, Loading, PageTitle, Panel, Segmented } from '../components/ui'
import { fmtMoney, fmtPnl } from '../lib/format'

type Mode = 'backtest' | 'live'
const pf = (v: number | null) => (v == null ? '–' : v >= 999 ? '∞' : v.toFixed(2))
const pct = (v: number) => `${v.toFixed(0)}%`
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Analytics() {
  const q = useAnalytics()
  const [mode, setMode] = useState<Mode>('backtest')
  const d = q.data
  const pick = (x: { backtest: Agg; live: Agg | null }): Agg => (mode === 'live' ? x.live ?? { trades: 0, wins: 0, winRatePct: 0, pnl: 0, fees: 0, profitFactor: null } : x.backtest)

  const symbols = useMemo(() => (d?.symbols ?? []).map((s) => ({ ...s, agg: pick(s) })).filter((s) => s.agg.trades > 0).sort((a, b) => b.agg.pnl - a.agg.pnl), [d, mode])
  const scanners = useMemo(() => (d?.scanners ?? []).map((s) => ({ ...s, agg: pick(s) })).filter((s) => s.agg.trades > 0).sort((a, b) => b.agg.pnl - a.agg.pnl), [d, mode])
  const grid = useMemo(() => {
    if (!d) return { rows: [] as string[], cols: [] as string[], cell: new Map<string, Agg>() }
    const cell = new Map<string, Agg>()
    for (const m of d.matrix) { const a = pick(m); if (a.trades > 0) cell.set(`${m.scannerId}|${m.symbol}`, a) }
    const rows = scanners.map((s) => s.id)
    const cols = symbols.map((s) => s.symbol)
    return { rows, cols, cell }
  }, [d, mode, scanners, symbols])
  const maxAbs = useMemo(() => Math.max(1, ...[...grid.cell.values()].map((a) => Math.abs(a.pnl))), [grid])
  const nameOf = (id: string) => d?.scanners.find((s) => s.id === id)?.name ?? id
  const tot = d ? (mode === 'live' ? d.totals.live : d.totals.backtest) : null
  const best = symbols[0], worst = symbols[symbols.length - 1], bestSc = scanners[0]

  return (
    <div className="page">
      <PageTitle pre="Where the edge," accent="lives." sub="Which pairs pay, which scanners earn, and where the two meet. Backtest = enabled scanners on their tuned symbols over the loaded history; Live = closed paper trades." />
      <div className="row gap mb">
        <Segmented value={mode} onChange={(v) => setMode(v as Mode)} options={[{ value: 'backtest', label: 'Backtest' }, { value: 'live', label: 'Live' }]} />
        {d && <span className="muted small">{mode === 'live' ? `${d.totals.live.trades} closed trades` : `${d.totals.backtest.trades} backtest trades`} · updated {new Date(d.at).toLocaleTimeString()}</span>}
      </div>
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && tot && (
        <>
          <div className="kpi-grid">
            <KpiTile label={`${mode} net PnL`} value={fmtPnl(tot.pnl)} tone={tot.pnl >= 0 ? 'gain' : 'loss'} sub={<span className="muted">fees {fmtMoney(tot.fees)} · {tot.trades} trades</span>} />
            <KpiTile label="Win rate" value={pct(tot.winRatePct)} sub={<span className="muted">PF {pf(tot.profitFactor)}</span>} />
            <KpiTile label="Best pair" value={best ? best.symbol : '–'} tone="gain" sub={best ? <span className="gain">{fmtPnl(best.agg.pnl)} · {best.agg.trades} trades · {pct(best.agg.winRatePct)}</span> : undefined} />
            <KpiTile label="Worst pair" value={worst && worst.agg.pnl < 0 ? worst.symbol : '–'} tone="loss" sub={worst && worst.agg.pnl < 0 ? <span className="loss">{fmtPnl(worst.agg.pnl)} · {worst.agg.trades} trades</span> : <span className="muted">no losing pair</span>} />
            <KpiTile label="Best scanner" value={bestSc ? bestSc.name.slice(0, 22) : '–'} tone="gain" sub={bestSc ? <span className="gain">{fmtPnl(bestSc.agg.pnl)} · PF {pf(bestSc.agg.profitFactor)}</span> : undefined} />
          </div>

          <div className="grid-2">
            <Panel title="Pairs" pad={false}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Pair</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">PF</th><th className="num">Net PnL</th><th className="num">Scanners</th><th className="num">Profitable</th><th className="num">Open</th></tr></thead>
                  <tbody>
                    {symbols.map((s) => (
                      <tr key={s.symbol}>
                        <td className="strong mono">{s.symbol}</td>
                        <td className="num mono">{s.agg.trades}</td>
                        <td className="num mono">{pct(s.agg.winRatePct)}</td>
                        <td className="num mono">{pf(s.agg.profitFactor)}</td>
                        <td className={`num mono ${s.agg.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtPnl(s.agg.pnl)}</td>
                        <td className="num mono">{s.scannersOn}</td>
                        <td className="num mono">{s.profitableScanners}</td>
                        <td className="num mono">{s.openPositions || ''}</td>
                      </tr>
                    ))}
                    {!symbols.length && <tr><td colSpan={8} className="muted">No {mode} trades yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="Scanners" pad={false}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Scanner</th><th className="num">Pairs</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">PF</th><th className="num">Net PnL</th><th className="num">Open</th></tr></thead>
                  <tbody>
                    {scanners.map((s) => (
                      <tr key={s.id}>
                        <td><Link to={`/scanners/${s.id}`} className="strong">{s.name}</Link> <span className="muted small">{s.author}</span></td>
                        <td className="num mono">{s.symbols}</td>
                        <td className="num mono">{s.agg.trades}</td>
                        <td className="num mono">{pct(s.agg.winRatePct)}</td>
                        <td className="num mono">{pf(s.agg.profitFactor)}</td>
                        <td className={`num mono ${s.agg.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtPnl(s.agg.pnl)}</td>
                        <td className="num mono">{s.openPositions || ''}</td>
                      </tr>
                    ))}
                    {!scanners.length && <tr><td colSpan={7} className="muted">No {mode} trades yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <Panel title={<span>Scanner × pair <span className="muted small">net PnL · hover for detail</span></span>} pad={false}>
            <div className="table-wrap">
              <table className="table heat">
                <thead><tr><th>Scanner</th>{grid.cols.map((c) => <th key={c} className="num heat-col">{c.replace(/USD$/, '')}</th>)}</tr></thead>
                <tbody>
                  {grid.rows.map((r) => (
                    <tr key={r}>
                      <td className="strong small">{nameOf(r).slice(0, 30)}</td>
                      {grid.cols.map((c) => {
                        const a = grid.cell.get(`${r}|${c}`)
                        if (!a) return <td key={c} className="heat-cell heat-empty" />
                        const t = Math.min(1, Math.abs(a.pnl) / maxAbs)
                        const bg = a.pnl >= 0 ? `rgba(76, 175, 110, ${0.12 + t * 0.55})` : `rgba(230, 80, 60, ${0.12 + t * 0.55})`
                        return <td key={c} className="heat-cell mono small" style={{ background: bg }} title={`${nameOf(r)} · ${c}\n${a.trades} trades · win ${pct(a.winRatePct)} · PF ${pf(a.profitFactor)}\nnet ${fmtPnl(a.pnl)} · fees ${fmtMoney(a.fees)}`}>{Math.round(a.pnl)}</td>
                      })}
                    </tr>
                  ))}
                  {!grid.rows.length && <tr><td className="muted">No data.</td></tr>}
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
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Exit reason</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">Net PnL</th><th className="num">Fees</th><th className="num">Avg / trade</th></tr></thead>
                <tbody>
                  {d.exits.map((e) => (
                    <tr key={e.reason}>
                      <td className="mono">{e.reason}</td>
                      <td className="num mono">{e.trades}</td>
                      <td className="num mono">{pct(e.winRatePct)}</td>
                      <td className={`num mono ${e.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtPnl(e.pnl)}</td>
                      <td className="num mono">{fmtMoney(e.fees)}</td>
                      <td className={`num mono ${e.pnl >= 0 ? 'gain' : 'loss'}`}>{fmtPnl(e.pnl / Math.max(1, e.trades))}</td>
                    </tr>
                  ))}
                  {!d.exits.length && <tr><td colSpan={6} className="muted">No closed live trades yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}

function TimeBars({ data }: { data: Array<{ label: string; agg: Agg }> }) {
  const rows = data.map((x) => ({ label: x.label, pnl: Number(x.agg.pnl.toFixed(2)), trades: x.agg.trades, win: x.agg.winRatePct }))
  if (!rows.some((r) => r.trades > 0)) return <div className="state muted">No trades yet.</div>
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} interval={0} fontFamily="JetBrains Mono, monospace" />
        <YAxis stroke="var(--muted)" fontSize={10} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtPnl(v, 0)} domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]} fontFamily="JetBrains Mono, monospace" />
        <Tooltip contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} formatter={(v) => [fmtPnl(Number(v)), 'net']} labelFormatter={(l, payload) => { const p = (payload?.[0]?.payload ?? {}) as { trades?: number; win?: number }; return `${l} · ${p.trades ?? 0} trades · win ${(p.win ?? 0).toFixed(0)}%` }} />
        <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
          {rows.map((r, i) => <Cell key={i} fill={r.pnl >= 0 ? 'var(--gain)' : 'var(--loss)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
