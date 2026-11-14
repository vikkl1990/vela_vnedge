import { ResearchSections } from '../components/ResearchSections'
import { choice } from '../lib/researchNavigation'
import { useResearchFilters } from '../lib/useResearchFilters'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { TrackerCell, TrackerView } from '../api/types'
import { PageTitle, Panel, Pill, QueryState } from '../components/ui'
import { Callout, EmptyState, Section, Stat, StatGrid, TabPanel, Tabs } from '../components/kit'
import '../styles/pages/trackers.css'
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
  const [tab, setTab] = useState<'script' | 'market' | 'cells'>('script')
  const allocated = v.cells.filter((c) => c.stage === 'live' || c.stage === 'demote_proposed').length
  const pre = `trk-${t.id}`
  return (
    <section className="trk-block" aria-label={t.name}>
      <Section
        title={t.name}
        hint={`Forward shadow results · ${allocated ? `${allocated} ${allocated === 1 ? 'cell allocated' : 'cells allocated'} to the paper account` : 'no direct account allocation'} · since ${new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${t.tfs.join(', ')}`}
      >
        {t.scanPriority === 'timely' && <Callout tone="info">Priority research scans run after each bar closes. Account scans and protective exits run first; evidence and entry rules still apply.</Callout>}
        <StatGrid min={150}>
          <Stat label="Cells" value={v.totals.cells} sub={`${v.totals.trading} have traded`} />
          <Stat label="Trades" value={v.totals.trades} sub={`${v.totals.open} open`} />
          <Stat label="Sum R" value={`${r(v.totals.sumR)}R`} tone={v.totals.sumR > 0 ? 'gain' : v.totals.sumR < 0 ? 'loss' : 'muted'} sub={`${r(v.totals.avgR, 3)}R a trade`} />
          <Stat label="Win rate" value={v.totals.trades ? `${Math.round(v.totals.winRate * 100)}%` : '–'} sub={v.totals.trades ? 'of closed trades' : 'no closed trade yet'} />
        </StatGrid>
        <Tabs
          label={`${t.name} views`}
          idPrefix={pre}
          value={tab}
          onChange={setTab}
          items={[
            { id: 'script', label: 'By script', count: byScanner.length },
            { id: 'market', label: 'By market and timeframe', count: t.symbols.length },
            { id: 'cells', label: 'Cells that have traded', count: traded.length },
          ]}
        />
        <TabPanel id="script" value={tab} idPrefix={pre}>
          <Panel pad={false}>
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
        </TabPanel>
        <TabPanel id="market" value={tab} idPrefix={pre}>
          <Panel pad={false}>
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
        </TabPanel>
        <TabPanel id="cells" value={tab} idPrefix={pre}>
          {traded.length === 0 ? (
            <EmptyState title="No closed trade yet" hint="15m cells usually trade within a day, 4h cells within a week." />
          ) : (
            <Panel pad={false}>
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
              </table></div>
              <p className="small muted trk-foot">{silent} {silent === 1 ? 'cell has' : 'cells have'} not traded yet.</p>
            </Panel>
          )}
        </TabPanel>
      </Section>
    </section>
  )
}

const TRIAL_COUNTS: Array<[string, string]> = [['ordinary', 'Ordinary signals'], ['setup', 'Setups'], ['pullback', 'Pullbacks'], ['confirmed', 'Confirmed'], ['ordered', 'Orders'], ['filled', 'Fills'], ['cancelled', 'Cancelled'], ['refused', 'Refused']]

function ReclaimTrials() {
  const q = useQuery({ queryKey: ['reclaim-trials'], queryFn: api.reclaimTrials, refetchInterval: 15_000 })
  return <QueryState {...q} data={q.data} empty="No paper trials configured." onRetry={() => q.refetch()}>
    {(data) => data.trials.length === 0 ? <EmptyState title="No paper account trials configured" hint="Trials are small, capped experiments that trade on the paper account itself." /> : <Section title="Paper account trials" hint="Small, capped experiments that trade on the paper account itself.">
      {data.trials.map((t) => <Panel key={`${t.rule.scannerId}|${t.rule.symbol}|${t.rule.tf}`} title={<span>{t.rule.symbol} · {t.rule.tf} · <Link to={`/scanners/${t.rule.scannerId}`}>{t.rule.scannerId}</Link></span>} right={<Pill tone="accent">{t.state}</Pill>}>
        <div className="trk-trial">
          <p className="trk-result">{t.closed ? <><b>{t.closed}</b> closed · <span className={tone(t.net)}>{r(t.net, 2)} USD net</span> · <span className={tone(t.sumR)}>{r(t.sumR, 2)}R</span></> : 'No closed trial trades yet.'}</p>
          <p className="muted small">{Math.round(t.rule.sizeScale * 100)}% of normal size · {t.usedToday}/{t.rule.maxDailyEntries} daily order placements used (UTC) · {t.open} open</p>
          <div className="trk-counts" role="list" aria-label="Trial funnel">{TRIAL_COUNTS.map(([key, label]) => <span key={key} role="listitem"><span className="stat-k">{label}</span> <span className="mono">{t.counts[key] ?? 0}</span></span>)}</div>
          {t.rule.minSignalBarAtr !== undefined && <p className="muted small">Retest only after a signal candle larger than {t.rule.minSignalBarAtr} ATR. Ordinary signals keep their entry policy. Pullback {t.rule.pullbackAtr} ATR · confirmation within {t.rule.setupMinutes} min · maker order expires after {t.rule.orderMinutes} min. {t.rule.maxStopLossPct !== undefined && <>All new entries in this cell have a {t.rule.maxStopLossPct}% equity stop-risk ceiling, within the configured margin budget.</>}</p>}
          {t.pending.map((p) => <p className="small" key={p.id}>{p.phase === 'order' ? `Maker limit ${p.price}` : 'Setup pending'} · expires {p.expiresAt ? new Date(p.expiresAt).toLocaleString() : '–'}</p>)}
          <p className="muted small">Last scan: {t.lastScan ? `${timeAgo(t.lastScan.at)} · ${t.lastScan.note ?? 'scan completed'}` : 'not recorded yet'}</p>
          <details><summary>Recent trial events</summary>{t.events.length ? <ul>{t.events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleString()} · {e.event}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul> : <p className="muted small">No recorded events yet.</p>}</details>
          <p className="muted small">Closed results cover retest fills only; ordinary trades remain in paper performance. Counts and results use the current trial settings, from audit start {data.auditStartedAt ? new Date(data.auditStartedAt).toLocaleString() : 'pending'}. Earlier activity is not reconstructed. Cancelled includes setups and orders.</p>
        </div>
      </Panel>)}
    </Section>}
  </QueryState>
}

export function Trackers() {
  const { params, set } = useResearchFilters()
  const section = choice(params.get('section'), ['shadow', 'paper'], 'shadow')
  const selected = params.get('tracker')
  const q = useQuery({ queryKey: ['trackers'], queryFn: api.trackers, refetchInterval: 60_000, staleTime: 30_000 })
  return (
    <div className="page trackers-page">
      <PageTitle sub="Inspect named research groups separately from paper account trials. Shared shadow cells can appear in several groups; their totals must not be added together. Trackers are watched, never judged: they are not promoted, retired or copied." />
      <ResearchSections label="Tracker books" value={section} options={[{ value: 'shadow', label: 'Shadow groups' }, { value: 'paper', label: 'Paper account trials' }]} />
      {section === 'paper' && <ReclaimTrials />}
      {section === 'shadow' && (
        <QueryState {...q} data={q.data} empty="No tracker yet." onRetry={() => q.refetch()}>
          {(list) => {
            if (!list.length) return <EmptyState title="No tracker yet" hint="A tracker is a named set of scanners, markets and timeframes the shadow runner trades for evidence. None is defined." />
            const ordered = [...list].sort((a, b) => b.tracker.createdAt - a.tracker.createdAt)
            const current = selected ? ordered.find((v) => v.tracker.id === selected) : ordered[0]
            return (
              <>
                <div className="research-filters panel">
                  <label>Research group
                    <select className="select" value={selected ?? current?.tracker.id ?? ''} onChange={(e) => set({ tracker: e.target.value })}>
                      {selected && !current && <option value={selected}>Unavailable group: {selected}</option>}
                      {ordered.map((v) => <option key={v.tracker.id} value={v.tracker.id}>{v.tracker.name} · {v.totals.cells} cells</option>)}
                    </select>
                  </label>
                  <span className="muted small">{list.length} groups · one group shown at a time</span>
                </div>
                {current ? <Tracker key={current.tracker.id} v={current} /> : <EmptyState title="This research group is no longer available" hint="Choose an existing group above." />}
              </>
            )
          }}
        </QueryState>
      )}
    </div>
  )
}
