import {CostAudit} from '../components/ExecutionPlans'
import { DecisionTrace } from '../components/DecisionTrace'
import { ScannerPipelinePanel } from '../components/ScannerPipeline'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { choice, signalSectionFromUrl } from '../lib/researchNavigation'
import { useResearchFilters } from '../lib/useResearchFilters'
import { summarizeOutcomes, gateOf } from '../lib/signalOutcomes'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useHealth, useMarkets, useScannerIndex, useSignalActivity, useSignals } from '../api/queries'
import type { Signal } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ActionPill, ErrorState, Loading, PageTitle, Panel, Pill, ScoreBadge, Segmented, SidePill, StatusDot, Time } from '../components/ui'
import { Callout, EmptyState, Section, Stat, StatGrid, TabPanel, Tabs, Toolbar } from '../components/kit'
import '../styles/pages/signals.css'
import { fmtPrice, truncate } from '../lib/format'
import { useNow } from '../lib/useNow'
import { useSSEEvent } from '../sse/SSEProvider'

const FLASH_MS = 3000
/** Two-line rows (symbol + tf·kind) — fixed so windowing can position them. */
const SIGNAL_ROW_H = 40
const IDLE_MS = 3_600_000

/** Signals table with the "scan results" style; new rows flash briefly. Windows rows when > 300. */
export function SignalsTable({ signals, hideScanner = false, maxHeight }: { signals: Signal[]; hideScanner?: boolean; maxHeight?: number | string }) {
  const { data: markets } = useMarkets()
  const [flash, setFlash] = useState<Map<number, number>>(new Map())
  // tick every second only while something is flashing
  const now = useNow(flash.size ? 1000 : IDLE_MS)
  useSSEEvent('signal', (s) =>
    setFlash((m) => {
      const n = new Map(m)
      const t = Date.now()
      n.set(s.id, t)
      for (const [k, at] of n) if (t - at > FLASH_MS) n.delete(k)
      return n
    }),
  )

  const cols = useMemo<Column<Signal>[]>(() => {
    const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize
    return [
      { key: 'at', header: 'Received · local', value: (s) => s.at, render: (s) => <Time t={s.at} mode="datetime" className="small" />, width: 130 },
      ...(hideScanner
        ? []
        : ([
            {
              key: 'scanner',
              header: 'Scanner',
              value: (s) => s.scannerName,
              render: (s) => (
                <Link to={`/scanners/${s.scannerId}`} className="link strong">
                  {s.scannerName}
                </Link>
              ),
            },
          ] as Column<Signal>[])),
      {
        key: 'symbol',
        header: 'Symbol',
        value: (s) => s.symbol,
        render: (s) => (
          <span className="cell-sym">
            <StatusDot tone={s.side === 'long' ? 'ok' : s.side === 'short' ? 'danger' : 'neutral'} />
            <span>
              <b>{s.symbol}</b>
              <div className="muted small mono">
                {s.tf} · {s.kind}
              </div>
            </span>
          </span>
        ),
      },
      { key: 'kind', header: 'Kind', value: (s) => s.kind, render: (s) => <span className={`kind kind-${s.kind}`}>{s.kind}</span> },
      { key: 'side', header: 'Side', value: (s) => s.side, render: (s) => <SidePill side={s.side} /> },
      {
        key: 'price', header: 'Price', numeric: true, value: (s) => s.price,
        render: (s) => (
          <span className={`mono ${s.derived ? 'lvl-derived' : ''}`} title={s.derived ? 'the script sent no price; this is the fill the position actually got' : undefined}>
            {fmtPrice(s.price, tick(s.symbol))}
          </span>
        ),
      },
      {
        key: 'sl', header: 'SL', numeric: true, value: (s) => s.sl,
        render: (s) => (
          <span className={`mono loss ${s.derived ? 'lvl-derived' : ''}`} title={s.derived ? 'derived from ATR when the position opened, because the script sent no stop' : undefined}>
            {fmtPrice(s.sl, tick(s.symbol))}
          </span>
        ),
      },
      {
        key: 'tp',
        header: 'TP1 / 2 / 3',
        numeric: true,
        sortable: false,
        render: (s) => (
          <span className="mono small tp-list gain">
            {[0, 1, 2].map((i) => (
              <span key={i}>{fmtPrice(s.tp?.[i], tick(s.symbol))}</span>
            ))}
          </span>
        ),
      },
      { key: 'score', header: 'Score', numeric: true, value: (s) => s.score, render: (s) => <ScoreBadge score={s.score} />, title: 'Signal quality: A+ ≥ 85, A ≥ 70, B ≥ 55, else C' },
      { key: 'action', header: 'Action', value: (s) => s.action, render: (s) => <ActionPill action={s.action} /> },
      {
        key: 'msg',
        header: 'Message',
        value: (s) => s.summary || s.message,
        render: (s) => (
          <span className="msg" title={s.message}>
            {truncate(s.summary || s.message, 90)}
          </span>
        ),
      },
    ]
  }, [markets, hideScanner])

  const rowClass = useCallback(
    (s: Signal) => {
      const t = flash.get(s.id)
      return t && now - t < FLASH_MS ? 'row-new' : undefined
    },
    [flash, now],
  )

  return (
    <DataTable
      columns={cols}
      rows={signals}
      rowKey={(s) => s.id}
      defaultSort={{ key: 'at', dir: 'desc' }}
      emptyLabel={
        <span>
          No signals
          <span className="empty-hint">No events match this selection. Check the filters and scanner scheduling.</span>
        </span>
      }
      maxHeight={maxHeight}
      rowHeight={SIGNAL_ROW_H}
      rowClass={rowClass}
      caption="Signals"
    />
  )
}

type SignalTab = 'signals' | 'outcomes' | 'recovery' | 'trace' | 'costs'

export function Signals() {
  const activity = useSignalActivity()
  const flow = activity.data
  const health = useHealth()
  const recovery = health.data?.signalRecovery
  const scanners = useScannerIndex()
  const markets = useMarkets()
  // filters live in the URL so a link, Back and Forward keep them; defaults stay out of it
  const { params, set, setSection, hash } = useResearchFilters()
  const scanner = params.get('scanner') ?? '', symbol = params.get('symbol') ?? '', tf = params.get('tf') ?? ''
  const kind = choice(params.get('kind'), ['', 'entry', 'exit', 'info'], '')
  const side = choice(params.get('side'), ['', 'long', 'short'], '')
  const view = choice(params.get('view'), ['grouped', 'flat'], 'grouped')
  const tab = signalSectionFromUrl(params, hash)
  const setTab = (value: SignalTab) => setSection(value === 'signals' ? null : value)
  const q = useMemo(() => ({ limit: 500, scanner: scanner || undefined, symbol: symbol || undefined, kind: kind || undefined, tf: tf || undefined }), [scanner, symbol, kind, tf])
  const signals = useSignals(q)

  const rows = useMemo(() => (signals.data ?? []).filter((s) => !side || s.side === side), [signals.data, side])
  const symbolOptions = useMemo(() => {
    const names = new Set<string>((markets.data ?? []).map((m) => m.symbol))
    for (const s of signals.data ?? []) names.add(s.symbol)
    if (symbol) names.add(symbol)
    return Array.from(names).sort()
  }, [markets.data, signals.data, symbol])

  const outcomes = useMemo(() => summarizeOutcomes(rows), [rows])
  const filtered = Boolean(scanner || symbol || tf || kind || side)
  const clearFilters = () => set({ scanner: null, symbol: null, tf: null, kind: null, side: null })
  const pending = recovery?.pending ?? 0

  return (
    <div className="page signals-page">
      <PageTitle
        sub="Every alert the account's scanners raised, and what the account did with it. View only: nothing here can open a trade. Shadow-book runs are judged in the Incubator."
        actions={<><Link to="/gates" className="btn btn-sm">Gate Center</Link><Link to="/incubator" className="btn btn-sm">Incubator</Link></>}
      />

      {pending > 0 && (
        <Callout tone="warn" title={`${pending} ${pending === 1 ? 'decision is' : 'decisions are'} waiting`} actions={<button type="button" className="btn btn-sm" onClick={() => setTab('recovery')}>See which</button>}>
          An interrupted decision stays pending until recovery finishes.
        </Callout>
      )}

      <Section title="Entry signals · last 24 hours" hint="All scanners and markets. The filters below do not change these numbers.">
        {activity.isError ? <ErrorState error={activity.error} onRetry={() => activity.refetch()} /> : !flow ? <Loading kind="kpi" rows={1} /> : (
          <>
            <StatGrid min={170}>
              <Stat label="Candidates seen" value={flow.candidates} tone="accent" title="Account entry signals plus shadow signals held from copying. Tracker-only signals are not counted." sub="account + held shadow" />
              <Stat label="Held back" value={flow.copyHeld} tone={flow.copyHeld ? 'warn' : 'muted'} title="A copy hold is a detected signal, not a scanner failure." sub="before account admission" />
              <Stat label="Reached admission" value={flow.entries} tone="accent" sub="account entry signals" />
              <Stat label="Paper entries filled" value={flow.paperFilled} tone={flow.paperFilled ? 'gain' : 'muted'} title="Filled entries use fill time, so they can come from earlier signals." sub="by fill time" />
              <Stat label="Shadow entries filled" value={flow.shadowFilled} tone="muted" sub="regular shadow book" />
            </StatGrid>
            {flow.held.length > 0 && (
              <div className="chips" role="group" aria-label="Why signals were held">
                <span className="muted small">Held because</span>
                {flow.held.map((r) => <Pill key={r.reason} tone="warn">{r.reason}: {r.n}</Pill>)}
              </div>
            )}
            <p className="small muted sig-note">
              Held signals are diagnostic only and never count toward promotion. <Link to="/incubator">Review the evidence in the Incubator</Link>.
              {(flow.copyRecordedSince === null || flow.copyRecordedSince > flow.since) && ' Hold history does not cover this whole window, so the candidate count is a lower bound.'}
            </p>
          </>
        )}
      </Section>

      <Tabs
        label="Signals views"
        idPrefix="sig"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'signals', label: 'Signals', count: signals.data ? rows.length : undefined },
          { id: 'outcomes', label: 'What became of them', count: outcomes.total || undefined },
          { id: 'recovery', label: 'Recovery', count: recovery ? pending : undefined, attention: pending > 0 },
          { id: 'trace', label: 'Decision trace' },
          { id: 'costs', label: 'Fees and costs' },
        ]}
      />

      <TabPanel id="signals" value={tab} idPrefix="sig">
        <div className="sig-stack">
          <Toolbar
            end={<Segmented ariaLabel="View" value={view} onChange={(v) => set({ view: v })} options={[{ value: 'grouped', label: 'By cell' }, { value: 'flat', label: 'Flat' }]} />}
          >
            <select className="select select-sm" value={scanner} onChange={(e) => set({ scanner: e.target.value })} aria-label="Scanner">
              <option value="">All scanners</option>
              {scanner && !scanners.data?.some((x) => x.id === scanner) && <option value={scanner}>{scanner}</option>}
              {(scanners.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="select select-sm" value={symbol} onChange={(e) => set({ symbol: e.target.value })} aria-label="Symbol">
              <option value="">All symbols</option>
              {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="select select-sm" value={tf} onChange={(e) => set({ tf: e.target.value })} aria-label="Timeframe">
              <option value="">All timeframes</option>
              {[...new Set([...DELTA_TIMEFRAMES, ...(tf ? [tf] : [])])].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="select select-sm" value={kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Kind">
              <option value="">All kinds</option>
              <option value="entry">entry</option>
              <option value="exit">exit</option>
              <option value="info">info</option>
            </select>
            <select className="select select-sm" value={side} onChange={(e) => set({ side: e.target.value })} aria-label="Side">
              <option value="">Both sides</option>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
            {filtered && <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}
          </Toolbar>
          <Panel pad={false}>
            {signals.isLoading && !signals.data && <Loading kind="table" rows={10} cols={9} />}
            {signals.isError && !signals.data && <ErrorState error={signals.error} onRetry={() => signals.refetch()} />}
            {signals.data && rows.length === 0 && (
              <EmptyState
                title="No signals match"
                hint={filtered ? 'Nothing fits these filters. Clear them to see everything the account received.' : 'The account has received no alerts yet. Check scanner scheduling and the decision trace.'}
                action={filtered ? <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear filters</button> : <button type="button" className="btn btn-sm" onClick={() => setTab('trace')}>Open decision trace</button>}
              />
            )}
            {signals.data && rows.length > 0 && (view === 'flat' ? <SignalsTable signals={rows} maxHeight="calc(100vh - 300px)" /> : <GroupedSignals signals={rows} />)}
          </Panel>
        </div>
      </TabPanel>

      <TabPanel id="outcomes" value={tab} idPrefix="sig">
        {outcomes.total === 0 ? (
          <EmptyState title="No signals to summarise" hint="Outcomes appear once the account has received signals that match the filters on the Signals tab." />
        ) : (
          <Section title={`What became of the last ${outcomes.total} signals`} hint={`${outcomes.entries} entry signals, ${outcomes.opened} opened (${outcomes.entries ? Math.round((outcomes.opened / outcomes.entries) * 100) : 0}%). Follows the filters on the Signals tab.`}>
            <Panel>
              <div className="chips">
                {outcomes.buckets.map((b) => <Pill key={b.key} tone={b.tone} title={b.hint}>{b.label} <span className="mono">{b.n}</span></Pill>)}
              </div>
              <p className="small muted sig-note">Hover a label to see what it means.</p>
            </Panel>
          </Section>
        )}
      </TabPanel>

      <TabPanel id="recovery" value={tab} idPrefix="sig">
        {!recovery ? (
          <EmptyState title="Recovery status is not available" hint="It loads with the health check. Try again in a moment." />
        ) : (
          <Section
            title="Signal recovery"
            hint="Interrupted paper decisions resume from their saved receipt and are never repeated. Entries expire after at most 60 seconds and recheck current rules. Exits stay tied to their position and wait for a fresh price."
            actions={<Pill tone={pending ? 'warn' : 'ok'}>{pending ? `${pending} awaiting decision` : 'No pending decisions'}</Pill>}
          >
            {pending > 0 ? (
              <Panel pad={false}>
                <div className="table-wrap"><table className="table small"><thead><tr><th>Signal</th><th>Market</th><th>Received</th><th>Attempts</th><th>Waiting on</th></tr></thead><tbody>{recovery.recent.map((r) => <tr key={r.signal_id}><td>#{r.signal_id} · {r.kind}</td><td>{r.symbol} · {r.tf}</td><td><Time t={r.received_at} /></td><td>{r.attempts}</td><td>{r.last_error ?? 'Decision in progress'}</td></tr>)}</tbody></table></div>
              </Panel>
            ) : (
              <Callout tone="ok">Every received signal has a decision. Nothing is waiting on recovery.</Callout>
            )}
          </Section>
        )}
      </TabPanel>

      <TabPanel id="trace" value={tab} idPrefix="sig">
        <div className="sig-stack" id="signal-diagnostics"><DecisionTrace /><ScannerPipelinePanel /></div>
      </TabPanel>

      <TabPanel id="costs" value={tab} idPrefix="sig">
        <div id="execution-costs"><CostAudit /></div>
      </TabPanel>
    </div>
  )
}


/**
 * Decision 120: the log grouped by cell — one scanner on one market and timeframe — with the cell's funnel on the
 * group row and each signal's gate as a short name, the full reason one click away. Read-only by design.
 */
function GroupedSignals({ signals }: { signals: Signal[] }) {
  const { data: markets } = useMarkets()
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [reason, setReason] = useState<number | null>(null)
  const groups = useMemo(() => {
    const by = new Map<string, Signal[]>()
    for (const s of signals) { const k = `${s.scannerId}|${s.symbol}|${s.tf}`; by.set(k, [...(by.get(k) ?? []), s]) }
    return [...by.entries()].map(([k, list]) => {
      const sorted = [...list].sort((a, b) => b.at - a.at)
      const entries = sorted.filter((s) => s.kind === 'entry')
      const counts = new Map<string, number>()
      for (const s of entries) { const g = gateOf(s.action); counts.set(g.key, (counts.get(g.key) ?? 0) + 1) }
      return { k, scannerId: sorted[0].scannerId, scannerName: sorted[0].scannerName, symbol: sorted[0].symbol, tf: sorted[0].tf, list: sorted, entries: entries.length, opened: counts.get('opened') ?? 0, counts, last: sorted[0].at }
    }).sort((a, b) => b.opened - a.opened || b.entries - a.entries || b.last - a.last)
  }, [signals])
  const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  if (!groups.length) return <EmptyState title="No signals match" hint="Nothing fits these filters. Clear them to see everything the account received." />
  return (
    <div className="table-wrap">
      <div className="row gap" style={{ padding: '8px 12px' }}>
        <span className="muted small">{groups.length} cells · sorted by opened, then signals</span>
        <button className="btn btn-xs" onClick={() => setOpen(new Set(groups.map((g) => g.k)))}>Expand all</button>
        <button className="btn btn-xs" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      <table className="table small signals-grouped">
        <caption className="sr-only">Signals grouped by cell</caption>
        <thead><tr><th scope="col">Cell</th><th scope="col">Signals</th><th scope="col">Opened</th><th scope="col">Other outcomes</th><th scope="col">Last</th></tr></thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.k}>
              <tr className="cohort-row group-row" onClick={() => toggle(g.k)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g.k) } }} aria-expanded={open.has(g.k)}>
                <th scope="rowgroup"><span className="muted mono">{open.has(g.k) ? '▾' : '▸'}</span> <Link to={`/scanners/${g.scannerId}`} className="strong" onClick={(e) => e.stopPropagation()}>{g.scannerName}</Link> <span className="mono">{g.symbol} {g.tf}</span></th>
                <td className="mono" data-label="signals">{g.entries}{g.list.length !== g.entries ? <span className="muted"> +{g.list.length - g.entries} exits/info</span> : null}</td>
                <td className={`mono ${g.opened ? 'gain' : 'muted'}`} data-label="opened">{g.opened}</td>
                <td data-label="other outcomes">{[...g.counts.entries()].filter(([k]) => k !== 'opened').sort((a, b) => b[1] - a[1]).map(([k, n]) => { const sample = g.list.find((s) => gateOf(s.action).key === k); const gg = gateOf(sample?.action); return <Pill key={k} tone={gg.tone} title={sample?.action ?? ''}>{n} {gg.label}</Pill> })}</td>
                <td className="muted" data-label="last"><Time t={g.last} /></td>
              </tr>
              {open.has(g.k) && g.list.slice(0, 60).map((s) => {
                const gg = gateOf(s.action)
                return (
                  <Fragment key={s.id}>
                    <tr className="cohort-member">
                      <td><Time t={s.at} className="small" /> <span className={`kind kind-${s.kind}`}>{s.kind}</span> <SidePill side={s.side} /> <span className="muted small">{truncate(s.label, 40)}</span></td>
                      <td className="mono small" data-label="price">{fmtPrice(s.price, tick(s.symbol))}{s.sl != null ? <span className="loss"> · SL {fmtPrice(s.sl, tick(s.symbol))}</span> : null}{s.tp?.[0] != null ? <span className="gain"> · TP {fmtPrice(s.tp[0], tick(s.symbol))}</span> : null}</td>
                      <td data-label="gate">{s.kind === 'entry' ? <Pill tone={gg.tone}>{gg.label}</Pill> : <ActionPill action={s.action} />}</td>
                      <td className="small">{s.kind === 'entry' && gg.key !== 'opened' ? <button className="btn btn-xs" onClick={() => setReason(reason === s.id ? null : s.id)} aria-expanded={reason === s.id}>{reason === s.id ? 'hide reason' : 'why'}</button> : <span className="muted">{s.mlProb != null ? `P(win) ${Math.round(s.mlProb * 100)}%` : ''}</span>}</td>
                      <td className="muted small">{s.score != null ? <ScoreBadge score={s.score} /> : null}</td>
                    </tr>
                    {reason === s.id && (
                      <tr className="cohort-member reason-row"><td colSpan={5} className="small"><span className="mono">{s.action}</span>{gg.href && <> · <Link to={gg.href}>this gate on the Gates page</Link></>}{s.message && s.message !== s.action ? <div className="muted">{truncate(s.summary || s.message, 200)}</div> : null}</td></tr>
                    )}
                  </Fragment>
                )
              })}
              {open.has(g.k) && g.list.length > 60 && <tr className="cohort-member"><td colSpan={5} className="muted small">{g.list.length - 60} older signals not shown; use the flat view with a filter</td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
