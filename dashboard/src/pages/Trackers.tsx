import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { TrackerCell, TrackerView } from '../api/types'
import { Empty, PageTitle, Panel, QueryState } from '../components/ui'
import { timeAgo } from '../lib/format'

/**
 * Decision 139: the operator's trackers. Each is a set of scanners × markets × timeframes the shadow runner trades with
 * the fleet's engine, gates and costs, outside the incubator: never promoted, retired or mirrored. Results count from
 * the day the tracker began.
 */
const r = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
const tone = (x: number) => (x > 0 ? 'gain' : x < 0 ? 'loss' : 'muted')
const sum = (xs: TrackerCell[]) => ({ trades: xs.reduce((a, c) => a + c.trades, 0), sumR: xs.reduce((a, c) => a + c.sumR, 0), open: xs.reduce((a, c) => a + c.open, 0) })
const cellText = (x: { trades: number; sumR: number }) => (x.trades ? `${r(x.sumR)}R / ${x.trades}` : '–')

function Tracker({ v }: { v: TrackerView }) {
  const t = v.tracker
  const byScanner = useMemo(() => t.scanners.map((id) => {
    const cs = v.cells.filter((c) => c.scannerId === id)
    return { id, all: sum(cs), byMarket: t.symbols.map((m) => sum(cs.filter((c) => c.symbol === m))) }
  }).sort((a, b) => b.all.sumR - a.all.sumR), [v, t])
  const traded = useMemo(() => v.cells.filter((c) => c.trades > 0).sort((a, b) => b.sumR - a.sumR), [v])
  const silent = v.cells.length - traded.length
  const allocated = v.cells.filter((c) => c.stage === 'live' || c.stage === 'demote_proposed').length
  return (
    <>
      <h2>{t.name}</h2>
      <p className="muted small">Forward paper results · {allocated ? `${allocated} ${allocated === 1 ? 'cell allocated' : 'cells allocated'} to the paper account` : 'No direct account allocation'}</p>
      <div className="stat-strip" role="list">
        <span role="listitem"><span className="stat-k">Cells</span> <span className="mono">{v.totals.cells}</span> <span className="muted">· {v.totals.trading} have traded</span></span>
        <span role="listitem"><span className="stat-k">Trades</span> <span className="mono">{v.totals.trades}</span> <span className="muted">· {v.totals.open} open</span></span>
        <span role="listitem"><span className="stat-k">R a trade</span> <span className={`mono ${tone(v.totals.avgR)}`}>{r(v.totals.avgR, 3)}</span></span>
        <span role="listitem"><span className="stat-k">Sum</span> <span className={`mono ${tone(v.totals.sumR)}`}>{r(v.totals.sumR)}R</span></span>
        <span role="listitem"><span className="stat-k">Win rate</span> <span className="mono">{v.totals.trades ? `${Math.round(v.totals.winRate * 100)}%` : '–'}</span></span>
        <span role="listitem" className="muted">since {new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · {t.tfs.join(', ')}</span>
      </div>
      <Panel title={`${t.name}: by script`} pad={false}>
        <div className="table-wrap"><table className="table small daily-table">
          <thead><tr><th>Script</th><th>All markets</th>{t.symbols.map((m) => <th key={m}>{m.replace(/USD$/, '')}</th>)}</tr></thead>
          <tbody>{byScanner.map((s) => (
            <tr key={s.id}>
              <td data-label="Script"><Link to={`/scanners/${s.id}`}>{s.id}</Link></td>
              <td className={`mono ${tone(s.all.sumR)}`} data-label="All markets">{cellText(s.all)}{s.all.open ? ` · ${s.all.open} open` : ''}</td>
              {s.byMarket.map((m, i) => <td key={t.symbols[i]} className={`mono ${m.trades ? tone(m.sumR) : 'muted'}`} data-label={t.symbols[i]}>{cellText(m)}</td>)}
            </tr>))}</tbody>
        </table></div>
      </Panel>
      <Panel title="By market and timeframe" pad={false}>
        <div className="table-wrap"><table className="table small daily-table">
          <thead><tr><th>Market</th>{t.tfs.map((tf) => <th key={tf}>{tf}</th>)}<th>All</th></tr></thead>
          <tbody>{t.symbols.map((m) => (
            <tr key={m}>
              <td className="mono" data-label="Market">{m}</td>
              {t.tfs.map((tf) => { const x = sum(v.cells.filter((c) => c.symbol === m && c.tf === tf)); return <td key={tf} className={`mono ${x.trades ? tone(x.sumR) : 'muted'}`} data-label={tf}>{cellText(x)}</td> })}
              {(() => { const x = sum(v.cells.filter((c) => c.symbol === m)); return <td className={`mono ${x.trades ? tone(x.sumR) : 'muted'}`} data-label="All">{cellText(x)}</td> })()}
            </tr>))}</tbody>
        </table></div>
      </Panel>
      <Panel title={`Cells that have traded (${traded.length})`} right={<span className="muted small">{silent} silent so far</span>} pad={false}>
        {traded.length === 0 ? <div className="panel-body"><p className="muted small">No closed trade yet. 15m cells usually trade within a day, 4h cells within a week.</p></div> : (
          <div className="table-wrap"><table className="table small daily-table">
            <thead><tr><th>Script</th><th>Market</th><th>TF</th><th>Trades</th><th>R a trade</th><th>Sum R</th><th>Wins</th><th>Stopped</th><th>Open</th><th>Last</th><th>Stage</th></tr></thead>
            <tbody>{traded.map((c) => (
              <tr key={`${c.scannerId}|${c.symbol}|${c.tf}`}>
                <td data-label="Script"><Link to={`/scanners/${c.scannerId}`}>{c.scannerId}</Link></td>
                <td className="mono" data-label="Market">{c.symbol}</td><td className="mono" data-label="TF">{c.tf}</td>
                <td className="mono" data-label="Trades">{c.trades}</td>
                <td className={`mono ${tone(c.avgR)}`} data-label="R a trade">{r(c.avgR, 3)}</td>
                <td className={`mono ${tone(c.sumR)}`} data-label="Sum R">{r(c.sumR)}</td>
                <td className="mono" data-label="Wins">{c.wins}</td><td className="mono" data-label="Stopped">{c.stops}</td><td className="mono" data-label="Open">{c.open}</td>
                <td className="muted" data-label="Last">{c.lastAt ? timeAgo(c.lastAt) : '–'}</td>
                <td className="muted" data-label="Stage">{c.stage}</td>
              </tr>))}</tbody>
          </table></div>)}
      </Panel>
    </>
  )
}

function ReclaimTrials() {
  const q = useQuery({ queryKey: ['reclaim-trials'], queryFn: api.reclaimTrials, refetchInterval: 15_000 })
  return <QueryState {...q} data={q.data} empty="No paper trials configured." onRetry={() => q.refetch()}>
    {(data) => <>{data.trials.map((t) => <Panel key={`${t.rule.scannerId}|${t.rule.symbol}|${t.rule.tf}`} title={`Paper account trial · ${t.rule.symbol} · ${t.rule.tf}`}>
      <p><Link to={`/scanners/${t.rule.scannerId}`}>{t.rule.scannerId}</Link> · <strong>{t.state}</strong></p>
      <p className="muted small">{Math.round(t.rule.sizeScale * 100)}% of normal size · {t.usedToday}/{t.rule.maxDailyEntries} daily order placements used (UTC) · {t.open} open</p>
      <div className="stat-strip">{[['setup','Setups'],['pullback','Pullbacks'],['confirmed','Confirmed'],['ordered','Orders'],['filled','Fills'],['cancelled','Cancelled'],['refused','Refused']].map(([key,label]) => <span key={key}><span className="stat-k">{label}</span> <span className="mono">{t.counts[key] ?? 0}</span></span>)}</div>
      <p>{t.closed ? `${t.closed} closed · ${r(t.net, 2)} USD net · ${r(t.sumR, 2)}R` : 'No closed trial trades yet.'}</p>
      <p className="muted small">Last scan: {t.lastScan ? `${timeAgo(t.lastScan.at)} · ${t.lastScan.note ?? 'scan completed'}` : 'not recorded yet'}</p>
      {t.pending.map((p) => <p className="small" key={p.id}>{p.phase === 'order' ? `Maker limit ${p.price}` : 'Setup pending'} · expires {p.expiresAt ? new Date(p.expiresAt).toLocaleString() : '–'}</p>)}
      <details><summary>Recent trial events</summary>{t.events.length ? <ul>{t.events.map((e,i) => <li key={i}>{new Date(e.at).toLocaleString()} · {e.event}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul> : <p className="muted small">No recorded events yet.</p>}</details>
      <p className="muted small">Counts and closed results use the current trial settings, from audit start {data.auditStartedAt ? new Date(data.auditStartedAt).toLocaleString() : 'pending'}. Earlier activity is not reconstructed. Cancelled includes setups and orders.</p>
    </Panel>)}</>}
  </QueryState>
}

export function Trackers() {
  const q = useQuery({ queryKey: ['trackers'], queryFn: api.trackers, refetchInterval: 60_000, staleTime: 30_000 })
  return (
    <div className="page">
      <PageTitle pre="Watched," accent="not judged." sub="Shadow-paper results for each named set of scanners, markets and timeframes, counted from its start date. Direct paper-account allocations are identified below and managed in Incubator and Scanners." />
      <ReclaimTrials />
      <QueryState {...q} data={q.data} empty="No tracker yet." onRetry={() => q.refetch()}>
        {(list) => list.length === 0 ? <Empty label="No tracker yet." /> : <>{[...list].sort((a, b) => b.tracker.createdAt - a.tracker.createdAt).map((v) => <Tracker key={v.tracker.id} v={v} />)}</>}
      </QueryState>
    </div>
  )
}
