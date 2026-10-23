import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useRadar } from '../api/queries'
import type { RadarCell, RadarMarket } from '../api/types'
import { PageTitle, Panel, QueryState } from '../components/ui'

/**
 * Decision 183: the signal radar. Where the scanners sit (pairs by stage) and what they produce (signals, entries,
 * stops, net R) for every market × timeframe, over the last day by default. A cell's shade is its entries per pair; its
 * bars are the window in slices, entries up and stops down; a quiet cell names the refusal that silenced it.
 */
const MAJORS = new Set(['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'BNBUSD', 'DOGEUSD'])
const r1 = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`
const money = (x: number | null) => (x === null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M` : `$${(x / 1e3).toFixed(0)}k`)
const pairs = (c: RadarCell) => c.live + c.shadow + c.candidate + c.tracked

function Cell({ c, symbol, tf, maxDensity }: { c: RadarCell | null; symbol: string; tf: string; maxDensity: number }) {
  if (!c || (pairs(c) === 0 && c.signals === 0 && c.opened === 0)) return <td className="radar-td"><div className="radar-cell radar-empty">–</div></td>
  const density = (c.live + c.shadow) > 0 ? c.opened / (c.live + c.shadow) : 0
  const level = maxDensity > 0 ? Math.min(3, Math.ceil((density / maxDensity) * 3)) : 0
  const peak = Math.max(1, ...c.bins.map((b) => Math.max(b.opened, b.stops)))
  return (
    <td className="radar-td">
      <Link className={`radar-cell radar-l${level}`} to={`/incubator?symbol=${symbol}&tf=${tf}`} title={`${symbol} ${tf}: ${c.signals} signals, ${c.opened} entries, ${c.stops} stops, ${r1(c.netR)}R`}>
        <div className="radar-chips">
          {c.live > 0 && <span className="radar-chip radar-live">{c.live} live</span>}
          {c.shadow > 0 && <span className="radar-chip radar-shadow">{c.shadow}</span>}
          {c.candidate > 0 && <span className="radar-chip radar-cand">{c.candidate}</span>}
          {c.tracked > 0 && <span className="radar-chip radar-trk">{c.tracked} tracked</span>}
        </div>
        <div className="radar-spark" aria-hidden="true">
          {c.bins.map((b, i) => (
            <span key={i} className="radar-bin">
              <i className="radar-up" style={{ height: `${Math.round((b.opened / peak) * 12)}px` }} />
              <i className="radar-down" style={{ height: `${Math.round((b.stops / peak) * 12)}px` }} />
            </span>
          ))}
        </div>
        <div className="radar-line mono">
          {c.signals} sig · {c.opened} in · {c.stops} sl{c.closes > 0 && <> · <span className={c.netR > 0 ? 'gain' : c.netR < 0 ? 'loss' : ''}>{r1(c.netR)}R</span></>}
          {c.opened === 0 && c.refusal && <span className="muted"> · {c.refusal}</span>}
        </div>
      </Link>
    </td>
  )
}

export default function Radar() {
  const [hours, setHours] = useState(24)
  const [group, setGroup] = useState<'all' | 'majors' | 'alts'>('all')
  const [sort, setSort] = useState<'turnover' | 'signals' | 'netR' | 'pairs'>('turnover')
  const [onlyActive, setOnlyActive] = useState(true)
  const q = useRadar(hours)
  const view = useMemo(() => {
    const v = q.data
    if (!v) return null
    const score = (m: RadarMarket, f: (c: RadarCell) => number) => v.tfs.reduce((a, tf) => a + (m.cells[tf] ? f(m.cells[tf]!) : 0), 0)
    let ms = v.markets.filter((m) => (group === 'all' || (group === 'majors') === MAJORS.has(m.symbol)))
    if (onlyActive) ms = ms.filter((m) => score(m, (c) => c.live + c.shadow + c.opened + c.signals) > 0)
    const key = sort === 'turnover' ? (m: RadarMarket) => m.turnoverUsd ?? -1 : sort === 'signals' ? (m: RadarMarket) => score(m, (c) => c.signals) : sort === 'netR' ? (m: RadarMarket) => score(m, (c) => c.netR) : (m: RadarMarket) => score(m, (c) => c.live + c.shadow)
    ms = [...ms].sort((a, b) => key(b) - key(a))
    const maxDensity = Math.max(0, ...v.markets.flatMap((m) => v.tfs.map((tf) => { const c = m.cells[tf]; return c && c.live + c.shadow > 0 ? c.opened / (c.live + c.shadow) : 0 })))
    return { ...v, markets: ms, maxDensity }
  }, [q.data, group, sort, onlyActive])
  const reserved = (tf: string) => (q.data?.reserve ?? []).filter((r) => !r.tfs?.length || r.tfs.includes(tf)).reduce((a, r) => a + r.slots, 0)
  return (
    <>
      <PageTitle pre="Signal" accent="radar" sub={<>Where the scanners sit and what they produce, market × timeframe, last {hours} h. A cell's shade is entries per pair; bars are entries up and stops down; a quiet cell names what silenced it.</>} />
      <QueryState {...q} data={view ?? undefined} empty="No markets in the book." onRetry={() => q.refetch()}>
        {(v) => (
          <>
            <div className="radar-strip">
              {v.tfs.map((tf) => { const t = v.totals[tf]; const res = reserved(tf); return (
                <div key={tf} className="radar-tf">
                  <div className="muted small">{tf}</div>
                  <div><b className="radar-big">{t.live + t.shadow}</b> <span className="muted small">pairs · {t.live} live · {t.candidate} waiting{t.tracked ? ` · ${t.tracked} tracked` : ''}{res ? ` · ${res} reserved` : ''}</span></div>
                  <div className="small mono">{t.signals} signals · {t.opened} entries · {t.stops} stops · <span className={t.netR > 0 ? 'gain' : t.netR < 0 ? 'loss' : ''}>{r1(t.netR)}R</span></div>
                </div>
              ) })}
            </div>
            <Panel title={`${v.markets.length} markets`} pad={false} right={
              <span className="row gap small">
                <select className="select select-sm" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Window">{[6, 24, 72, 168].map((h) => <option key={h} value={h}>{h < 48 ? `${h} h` : `${h / 24} d`}</option>)}</select>
                <select className="select select-sm" value={group} onChange={(e) => setGroup(e.target.value as typeof group)} aria-label="Markets"><option value="all">All markets</option><option value="majors">Majors</option><option value="alts">Alts</option></select>
                <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort"><option value="turnover">By turnover</option><option value="signals">By signals</option><option value="netR">By net R</option><option value="pairs">By pairs</option></select>
                <label className="small muted"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> active only</label>
              </span>
            }>
              <div className="table-wrap"><table className="table small radar-table">
                <thead><tr><th>Market</th>{v.tfs.map((tf) => <th key={tf}>{tf}</th>)}</tr></thead>
                <tbody>{v.markets.map((m) => (
                  <tr key={m.symbol}>
                    <td className="radar-market"><b>{m.symbol.replace(/USD$/, '')}</b><div className="muted small mono">{money(m.turnoverUsd)}{m.atrPct !== null ? ` · ATR ${m.atrPct.toFixed(2)}%` : ''}{m.allowed === false ? ' · gate off' : ''}</div></td>
                    {v.tfs.map((tf) => <Cell key={tf} c={m.cells[tf]} symbol={m.symbol} tf={tf} maxDensity={v.maxDensity} />)}
                  </tr>
                ))}</tbody>
              </table></div>
            </Panel>
            <div className="radar-legend small muted">
              <span><span className="radar-chip radar-live">live</span> the account trades it</span>
              <span><span className="radar-chip radar-shadow">shadow</span> evidence</span>
              <span><span className="radar-chip radar-cand">candidate</span> passed the screen, waiting for a slot</span>
              <span><span className="radar-chip radar-trk">tracked</span> watch-only</span>
              <span>bars: {v.bins} slices of {v.hours} h, <span className="gain">entries</span> up, <span className="loss">stops</span> down</span>
            </div>
          </>
        )}
      </QueryState>
    </>
  )
}
