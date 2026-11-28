import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useHealth, useMarkets, useScannerIndex, useSignalActivity, useSignals } from '../api/queries'
import type { Signal } from '../api/types'
import { AssetChip } from '../components/AssetChip'
import { DataTable, type Column } from '../components/DataTable'
import { DecisionTrace } from '../components/DecisionTrace'
import { CostAudit } from '../components/ExecutionPlans'
import {
  ActionPill,
  Callout,
  EmptyState,
  ErrorState,
  Loading,
  Pill,
  RouteHeader,
  ScoreBadge,
  Section,
  SidePill,
  Stat,
  StatGrid,
  StatusDot,
  TabPanel,
  Tabs,
  Time,
  ToggleGroup,
  Toolbar,
} from '../components/kit'
import { ScannerPipelinePanel } from '../components/ScannerPipeline'
import { choice, signalSectionFromUrl } from '../lib/researchNavigation'
import { gateOf, summarizeOutcomes } from '../lib/signalOutcomes'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useResearchFilters } from '../lib/useResearchFilters'

import { fmtPrice, truncate } from '../lib/format'
import { useNow } from '../lib/useNow'
import { useSSEEvent } from '../sse/SSEProvider'
import '../styles/pages/signals.css'

const FLASH_MS = 3000
/** Two-line rows (symbol + tf·kind) — fixed so windowing can position them. */
const SIGNAL_ROW_H = 48
const IDLE_MS = 3_600_000

/** Signals table with the "scan results" style; new rows flash briefly. Windows rows when > 300. */
export function SignalsTable({
  signals,
  hideScanner = false,
  maxHeight,
}: {
  signals: Signal[]
  hideScanner?: boolean
  maxHeight?: number | string
}) {
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
      {
        key: 'at',
        header: 'Received · local',
        value: (s) => s.at,
        render: (s) => <Time t={s.at} mode="datetime" className="small" />,
        width: 130,
      },
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
              <b>{s.symbol}</b> <AssetChip symbol={s.symbol} />
              <div className="muted small mono">
                {s.tf} · {s.kind}
              </div>
            </span>
          </span>
        ),
      },
      {
        key: 'kind',
        mobile: 'hidden',
        header: 'Kind',
        value: (s) => s.kind,
        render: (s) => <span className={`kind kind-${s.kind}`}>{s.kind}</span>,
      },
      { key: 'side', header: 'Side', value: (s) => s.side, render: (s) => <SidePill side={s.side} /> },
      {
        key: 'price',
        mobile: 'detail',
        header: 'Price',
        numeric: true,
        value: (s) => s.price,
        render: (s) => (
          <span
            className={`mono ${s.derived ? 'lvl-derived' : ''}`}
            title={
              s.derived ? 'the script sent no price; this is the fill the position actually got' : undefined
            }
          >
            {fmtPrice(s.price, tick(s.symbol))}
          </span>
        ),
      },
      {
        key: 'sl',
        mobile: 'detail',
        header: 'SL',
        numeric: true,
        value: (s) => s.sl,
        render: (s) => (
          <span
            className={`mono loss ${s.derived ? 'lvl-derived' : ''}`}
            title={
              s.derived
                ? 'derived from ATR when the position opened, because the script sent no stop'
                : undefined
            }
          >
            {fmtPrice(s.sl, tick(s.symbol))}
          </span>
        ),
      },
      {
        key: 'tp',
        mobile: 'detail',
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
      {
        key: 'score',
        mobile: 'detail',
        header: 'Score',
        numeric: true,
        value: (s) => s.score,
        render: (s) => <ScoreBadge score={s.score} />,
        title: 'Signal quality: A+ ≥ 85, A ≥ 70, B ≥ 55, else C',
      },
      {
        key: 'action',
        header: 'Action',
        value: (s) => s.action,
        render: (s) => <ActionPill action={s.action} />,
        mobileRender: (s) => {
          const outcome = gateOf(s.action)
          return outcome.key === 'exit-requested' || outcome.key === 'stop-update' ? outcome.label : s.action
        },
      },
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
          <span className="empty-hint">
            No events match this selection. Check the filters and scanner scheduling.
          </span>
        </span>
      }
      maxHeight={maxHeight}
      rowHeight={SIGNAL_ROW_H}
      rowClass={rowClass}
      caption="Signals"
      pageSize={25}
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
  const scanner = params.get('scanner') ?? '',
    symbol = params.get('symbol') ?? '',
    tf = params.get('tf') ?? ''
  const kind = choice(params.get('kind'), ['', 'entry', 'exit', 'info'], '')
  const side = choice(params.get('side'), ['', 'long', 'short'], '')
  const view = choice(params.get('view'), ['grouped', 'flat'], 'grouped')
  const tab = signalSectionFromUrl(params, hash)
  const setTab = (value: SignalTab) => setSection(value === 'signals' ? null : value)
  const q = useMemo(
    () => ({
      limit: 500,
      scanner: scanner || undefined,
      symbol: symbol || undefined,
      kind: kind || undefined,
      side: side || undefined,
      tf: tf || undefined,
    }),
    [scanner, symbol, kind, tf, side],
  )
  const signals = useSignals(q)

  const rows = useMemo(
    () => (signals.data ?? []).filter((s) => !side || s.side === side),
    [signals.data, side],
  )
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
      <RouteHeader
        sub="Every alert the account's scanners raised, and what the account did with it. View only: nothing here can open a trade. Shadow-book runs are judged in the Incubator."
        actions={
          <>
            <Link to="/gates" className="btn btn-sm">
              Gate Center
            </Link>
            <Link to="/incubator" className="btn btn-sm">
              Incubator
            </Link>
          </>
        }
      />

      {pending > 0 && (
        <Callout
          tone="warn"
          title={`${pending} ${pending === 1 ? 'decision is' : 'decisions are'} waiting`}
          actions={
            <button type="button" className="btn btn-sm" onClick={() => setTab('recovery')}>
              See which
            </button>
          }
        >
          An interrupted decision stays pending until recovery finishes.
        </Callout>
      )}

      <Section
        title="Entry signals · last 24 hours"
        hint="All scanners and markets. The filters below do not change these numbers."
      >
        {activity.isError ? (
          <ErrorState error={activity.error} onRetry={() => activity.refetch()} />
        ) : !flow ? (
          <Loading kind="kpi" rows={1} />
        ) : (
          <>
            <StatGrid min={170}>
              <Stat
                label="Candidates seen"
                value={flow.candidates}
                tone="accent"
                title="Account entry signals plus shadow signals held from copying. Tracker-only signals are not counted."
                sub="account + held shadow"
              />
              <Stat
                label="Held back"
                value={flow.copyHeld}
                tone={flow.copyHeld ? 'warn' : 'muted'}
                title="A copy hold is a detected signal, not a scanner failure."
                sub="before account admission"
              />
              <Stat
                label="Reached admission"
                value={flow.entries}
                tone="accent"
                sub="account entry signals"
              />
              <Stat
                label="Paper entries filled"
                value={flow.paperFilled}
                tone={flow.paperFilled ? 'gain' : 'muted'}
                title="Filled entries use fill time, so they can come from earlier signals."
                sub="by fill time"
              />
              <Stat
                label="Shadow entries filled"
                value={flow.shadowFilled}
                tone="muted"
                sub="regular shadow book"
              />
            </StatGrid>
            {flow.held.length > 0 && (
              <div className="chips" role="group" aria-label="Why signals were held">
                <span className="muted small">Held because</span>
                {flow.held.map((r) => (
                  <Pill key={r.reason} tone="warn">
                    {r.reason}: {r.n}
                  </Pill>
                ))}
              </div>
            )}
            <p className="small muted sig-note">
              Held signals are diagnostic only and never count toward promotion.{' '}
              <Link to="/incubator">Review the evidence in the Incubator</Link>.
              {(flow.copyRecordedSince === null || flow.copyRecordedSince > flow.since) &&
                ' Hold history does not cover this whole window, so the candidate count is a lower bound.'}
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
          {
            id: 'recovery',
            label: 'Recovery',
            count: recovery ? pending : undefined,
            attention: pending > 0,
          },
          { id: 'trace', label: 'Decision trace' },
          { id: 'costs', label: 'Fees and costs' },
        ]}
      />

      <TabPanel id="signals" value={tab} idPrefix="sig">
        <div className="sig-stack">
          <Toolbar
            end={
              <ToggleGroup
                ariaLabel="View"
                value={view}
                onChange={(v) => set({ view: v })}
                options={[
                  { value: 'grouped', label: 'By cell' },
                  { value: 'flat', label: 'Flat' },
                ]}
              />
            }
          >
            <select
              className="select select-sm"
              value={scanner}
              onChange={(e) => set({ scanner: e.target.value })}
              aria-label="Scanner"
            >
              <option value="">All scanners</option>
              {scanner && !scanners.data?.some((x) => x.id === scanner) && (
                <option value={scanner}>{scanner}</option>
              )}
              {(scanners.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              className="select select-sm"
              value={symbol}
              onChange={(e) => set({ symbol: e.target.value })}
              aria-label="Symbol"
            >
              <option value="">All symbols</option>
              {symbolOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              className="select select-sm"
              value={tf}
              onChange={(e) => set({ tf: e.target.value })}
              aria-label="Timeframe"
            >
              <option value="">All timeframes</option>
              {[...new Set([...DELTA_TIMEFRAMES, ...(tf ? [tf] : [])])].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              className="select select-sm"
              value={kind}
              onChange={(e) => set({ kind: e.target.value })}
              aria-label="Kind"
            >
              <option value="">All kinds</option>
              <option value="entry">entry</option>
              <option value="exit">exit</option>
              <option value="info">info</option>
            </select>
            <select
              className="select select-sm"
              value={side}
              onChange={(e) => set({ side: e.target.value })}
              aria-label="Side"
            >
              <option value="">Both sides</option>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
            {filtered && (
              <button type="button" className="btn btn-sm" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </Toolbar>
          <p className="small muted" role="status">
            Recent journal: latest {q.limit} matching events at most, across all dates. These rows are
            separate from the 24-hour totals above.
            {signals.data?.length === q.limit &&
              ' History is capped; narrow the scanner, market or timeframe to inspect older activity.'}
            {rows.length > 0 && (
              <>
                {' '}
                Loaded from <Time t={Math.min(...rows.map((s) => s.at))} mode="datetime" /> to{' '}
                <Time t={Math.max(...rows.map((s) => s.at))} mode="datetime" />.
              </>
            )}
            {signals.dataUpdatedAt > 0 && (
              <>
                {' '}
                Refreshed <Time t={signals.dataUpdatedAt} />.
              </>
            )}
            <button
              className="btn btn-sm"
              disabled={signals.isFetching}
              onClick={() => {
                void signals.refetch()
                void activity.refetch()
              }}
            >
              Refresh signals
            </button>
          </p>
          {signals.isError && signals.data && (
            <ErrorState error={signals.error} onRetry={() => signals.refetch()} />
          )}
          <Section variant="panel" pad={false}>
            {signals.isLoading && !signals.data && <Loading kind="table" rows={10} cols={9} />}
            {signals.isError && !signals.data && (
              <ErrorState error={signals.error} onRetry={() => signals.refetch()} />
            )}
            {signals.data && rows.length === 0 && (
              <EmptyState
                title="No signals match"
                hint={
                  filtered
                    ? 'Nothing fits these filters. Clear them to see everything the account received.'
                    : 'The account has received no alerts yet. Check scanner scheduling and the decision trace.'
                }
                action={
                  filtered ? (
                    <button type="button" className="btn btn-sm" onClick={clearFilters}>
                      Clear filters
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => setTab('trace')}>
                      Open decision trace
                    </button>
                  )
                }
              />
            )}
            {signals.data &&
              rows.length > 0 &&
              (view === 'flat' ? (
                <SignalsTable
                  key={`${scanner}:${symbol}:${tf}:${kind}:${side}`}
                  signals={rows}
                  maxHeight="calc(100vh - 300px)"
                />
              ) : (
                <GroupedSignals key={`${scanner}:${symbol}:${tf}:${kind}:${side}`} signals={rows} />
              ))}
          </Section>
        </div>
      </TabPanel>

      <TabPanel id="outcomes" value={tab} idPrefix="sig">
        {outcomes.total === 0 ? (
          <EmptyState
            title="No signals to summarise"
            hint="Outcomes appear once the account has received signals that match the filters on the Signals tab."
          />
        ) : (
          <Section
            title={`What became of the last ${outcomes.total} signals`}
            hint={`${outcomes.entries} entry signals, ${outcomes.opened} opened (${outcomes.entries ? Math.round((outcomes.opened / outcomes.entries) * 100) : 0}%). Follows the filters on the Signals tab.`}
          >
            <Section variant="panel">
              <div className="chips">
                {outcomes.buckets.map((b) => (
                  <Pill key={b.key} tone={b.tone} title={b.hint}>
                    {b.label} <span className="mono">{b.n}</span>
                  </Pill>
                ))}
              </div>
              <p className="small muted sig-note">Hover a label to see what it means.</p>
            </Section>
          </Section>
        )}
      </TabPanel>

      <TabPanel id="recovery" value={tab} idPrefix="sig">
        {!recovery ? (
          <EmptyState
            title="Recovery status is not available"
            hint="It loads with the health check. Try again in a moment."
          />
        ) : (
          <Section
            title="Signal recovery"
            hint="Interrupted paper decisions resume from their saved receipt and are never repeated. Entries expire after at most 60 seconds and recheck current rules. Exits stay tied to their position and wait for a fresh price."
            actions={
              <Pill tone={pending ? 'warn' : 'ok'}>
                {pending ? `${pending} awaiting decision` : 'No pending decisions'}
              </Pill>
            }
          >
            {pending > 0 ? (
              <Section variant="panel" pad={false}>
                <div className="table-wrap">
                  <table className="table small">
                    <thead>
                      <tr>
                        <th>Signal</th>
                        <th>Market</th>
                        <th>Received</th>
                        <th>Attempts</th>
                        <th>Waiting on</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recovery.recent.map((r) => (
                        <tr key={r.signal_id}>
                          <td>
                            #{r.signal_id} · {r.kind}
                          </td>
                          <td>
                            {r.symbol} · {r.tf}
                          </td>
                          <td>
                            <Time t={r.received_at} />
                          </td>
                          <td>{r.attempts}</td>
                          <td>{r.last_error ?? 'Decision in progress'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            ) : (
              <Callout tone="ok">
                Every received signal has a decision. Nothing is waiting on recovery.
              </Callout>
            )}
          </Section>
        )}
      </TabPanel>

      <TabPanel id="trace" value={tab} idPrefix="sig">
        <div className="sig-stack" id="signal-diagnostics">
          <DecisionTrace />
          <ScannerPipelinePanel />
        </div>
      </TabPanel>

      <TabPanel id="costs" value={tab} idPrefix="sig">
        <div id="execution-costs">
          <CostAudit />
        </div>
      </TabPanel>
    </div>
  )
}

/**
 * Decision 120: the log grouped by cell — one scanner on one market and timeframe — with the cell's funnel on the
 * group row and each signal's gate as a short name, the full reason one click away. Read-only by design.
 */
export function GroupedSignals({ signals }: { signals: Signal[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const groups = useMemo(() => {
    const by = new Map<string, Signal[]>()
    for (const signal of signals) {
      const key = `${signal.scannerId}|${signal.symbol}|${signal.tf}`
      const list = by.get(key) ?? []
      list.push(signal)
      by.set(key, list)
    }
    return [...by.entries()]
      .map(([key, list]) => {
        const sorted = [...list].sort((a, b) => b.at - a.at)
        const entries = sorted.filter((s) => s.kind === 'entry')
        const counts = new Map<string, number>()
        for (const signal of entries) {
          const gate = gateOf(signal.action)
          counts.set(gate.key, (counts.get(gate.key) ?? 0) + 1)
        }
        return {
          key,
          first: sorted[0],
          list: sorted,
          entries: entries.length,
          opened: counts.get('opened') ?? 0,
          counts,
        }
      })
      .sort((a, b) => b.opened - a.opened || b.entries - a.entries || b.first.at - a.first.at)
  }, [signals])
  type Group = (typeof groups)[number]
  const columns: Column<Group>[] = [
    {
      key: 'cell',
      header: 'Cell',
      value: (g) => `${g.first.scannerName} ${g.first.symbol} ${g.first.tf}`,
      render: (g) => (
        <div>
          <Link to={`/scanners/${g.first.scannerId}`}>{g.first.scannerName}</Link>
          <div className="mono">
            {g.first.symbol} · {g.first.tf} <AssetChip symbol={g.first.symbol} />
          </div>
        </div>
      ),
    },
    { key: 'entries', header: 'Entry signals', value: (g) => g.entries, numeric: true },
    { key: 'opened', header: 'Opened', value: (g) => g.opened, numeric: true },
    {
      key: 'outcomes',
      header: 'Other outcomes',
      render: (g) => (
        <div className="signal-outcomes">
          {[...g.counts]
            .filter(([key]) => key !== 'opened')
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => {
              const sample = g.list.find((signal) => gateOf(signal.action).key === key)
              const gate = gateOf(sample?.action)
              return (
                <Pill key={key} tone={gate.tone}>
                  {count} {gate.label}
                </Pill>
              )
            })}
        </div>
      ),
    },
    {
      key: 'last',
      header: 'Last received',
      value: (g) => g.first.at,
      render: (g) => <Time t={g.first.at} />,
    },
    {
      key: 'details',
      header: 'Details',
      render: (g) => (
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={selected === g.key}
          aria-controls="signal-cell-details"
          onClick={() => setSelected(selected === g.key ? null : g.key)}
        >
          View {g.list.length} signals
        </button>
      ),
    },
  ]
  const active = groups.find((g) => g.key === selected)
  return (
    <div className="sig-stack">
      <DataTable
        rows={groups}
        columns={columns}
        rowKey={(g) => g.key}
        pageSize={25}
        caption="Signal cells"
        emptyLabel="No signals match"
      />
      {active && (
        <section id="signal-cell-details" aria-label="Selected cell signals" className="signal-cell-details">
          <Section
            title={`${active.first.scannerName} · ${active.first.symbol} ${active.first.tf}`}
            actions={
              <button type="button" className="btn btn-sm" onClick={() => setSelected(null)}>
                Close details
              </button>
            }
          >
            <SignalsTable signals={active.list} hideScanner />
          </Section>
        </section>
      )}
    </div>
  )
}
