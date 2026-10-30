import { DecisionTrace } from '../components/DecisionTrace'
import { ScannerPipelinePanel } from '../components/ScannerPipeline'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMarkets, useScannerIndex, useSignals } from '../api/queries'
import type { Signal, SignalKind, Side } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ActionPill, ErrorState, Loading, PageTitle, Panel, Pill, ScoreBadge, Segmented, SidePill, StatusDot, Time } from '../components/ui'
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
      { key: 'at', header: 'Time', value: (s) => s.at, render: (s) => <Time t={s.at} className="small" />, width: 84 },
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
          <span className="empty-hint">Enable a scanner and wait for the next closed bar.</span>
        </span>
      }
      maxHeight={maxHeight}
      rowHeight={SIGNAL_ROW_H}
      rowClass={rowClass}
      caption="Signals"
    />
  )
}

export function Signals() {
  const scanners = useScannerIndex()
  const markets = useMarkets()
  const [scanner, setScanner] = useState('')
  const [symbol, setSymbol] = useState('')
  const [kind, setKind] = useState<'' | SignalKind>('')
  const [side, setSide] = useState<'' | Side>('')
  const [view, setView] = useState<'grouped' | 'flat'>('grouped')
  const q = useMemo(() => ({ limit: 500, scanner: scanner || undefined, symbol: symbol || undefined, kind: kind || undefined }), [scanner, symbol, kind])
  const signals = useSignals(q)

  const rows = useMemo(() => (signals.data ?? []).filter((s) => !side || s.side === side), [signals.data, side])
  const symbolOptions = useMemo(() => {
    const set = new Set<string>((markets.data ?? []).map((m) => m.symbol))
    for (const s of signals.data ?? []) set.add(s.symbol)
    return Array.from(set)
  }, [markets.data, signals.data])

  const outcomes = useMemo(() => summarizeOutcomes(rows), [rows])

  return (
    <div className="page">
      <DecisionTrace/>
      <ScannerPipelinePanel/>
      <div className="banner small" role="note"><b>View only.</b> A signal is the record of a decision the gates already made; nothing here can open a trade. Each refusal names its gate, and the <Link to="/gates">Gate Center</Link> explains every gate and its current state.</div>
      <PageTitle pre="Every alert," accent="scored" post="and actioned." sub="Every alert the account's scanners raised and what the account did with it. Shadow-book runs are judged in the Incubator, not here." />
      {outcomes.total > 0 && (
        <Panel title={`What became of the last ${outcomes.total} signals`} right={<span className="muted small">{outcomes.entries} entry signals · {outcomes.opened} opened ({outcomes.entries ? Math.round(outcomes.opened / outcomes.entries * 100) : 0}%)</span>}>
          <div className="chips">
            {outcomes.buckets.map((b) => (
              <Pill key={b.key} tone={b.tone} title={b.hint}>{b.label} <span className="mono">{b.n}</span></Pill>
            ))}
          </div>
        </Panel>
      )}
      <Panel
        title={
          <span>
            Signals <span className="muted small">({rows.length})</span>
          </span>
        }
        right={
          <div className="row gap filters">
            <Segmented ariaLabel="View" value={view} onChange={(v) => setView(v as 'grouped' | 'flat')} options={[{ value: 'grouped', label: 'By cell' }, { value: 'flat', label: 'Flat' }]} />
            <select className="select select-sm" value={scanner} onChange={(e) => setScanner(e.target.value)} aria-label="Scanner">
              <option value="">All scanners</option>
              {(scanners.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
              <option value="">All symbols</option>
              {symbolOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select className="select select-sm" value={kind} onChange={(e) => setKind(e.target.value as '' | SignalKind)} aria-label="Kind">
              <option value="">All kinds</option>
              <option value="entry">entry</option>
              <option value="exit">exit</option>
              <option value="info">info</option>
            </select>
            <select className="select select-sm" value={side} onChange={(e) => setSide(e.target.value as '' | Side)} aria-label="Side">
              <option value="">Both sides</option>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
          </div>
        }
        pad={false}
      >
        {signals.isLoading && !signals.data && <Loading kind="table" rows={10} cols={9} />}
        {signals.isError && !signals.data && <ErrorState error={signals.error} onRetry={() => signals.refetch()} />}
        {signals.data && (view === 'flat' ? <SignalsTable signals={rows} maxHeight="calc(100vh - 300px)" /> : <GroupedSignals signals={rows} />)}
      </Panel>
    </div>
  )
}


/** The fate of a batch of signals, in the operator's words: how many became trades, and what refused the rest. */
function summarizeOutcomes(rows: Signal[]) {
  const defs: Array<{ key: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'muted' | 'accent'; hint: string; test: (a: string, s: Signal) => boolean }> = [
    { key: 'opened', label: 'opened', tone: 'ok', hint: 'became a position', test: (a) => a === 'opened' },
    { key: 'market', label: 'market not suitable', tone: 'warn', hint: 'the markets-today gate: illiquid, too quiet to pay the round trip, or not paying recently (decision 56)', test: (a) => a.startsWith('rejected:market') },
    { key: 'fee', label: 'stop too tight for fees', tone: 'warn', hint: 'the stop is closer than the configured multiple of round-trip costs; taking the trade loses money', test: (a) => /stop too tight/.test(a) },
    { key: 'capacity', label: 'margin / position cap', tone: 'warn', hint: 'no room in the account: margin, position limits, or a scrap-sized fill refused (decision 53)', test: (a) => /margin|max positions|position cap|intended size|budget/.test(a) },
    { key: 'stale', label: 'stale (scan too late)', tone: 'danger', hint: 'the scan finished after the signal aged out', test: (a) => /stale/.test(a) },
    { key: 'halted', label: 'halted / loss limit', tone: 'danger', hint: 'kill switch, daily or weekly loss limit, cooldown', test: (a) => /halt|loss limit|cooldown/.test(a) },
    { key: 'regime', label: 'regime', tone: 'muted', hint: 'weekend or ATR floor', test: (a) => /regime/.test(a) },
    { key: 'exitnopos', label: 'exit, no position', tone: 'muted', hint: 'an exit signal with nothing open to close', test: (a) => /no position/.test(a) },
    { key: 'inpos', label: 'already in position', tone: 'muted', hint: 'the scanner already holds this market', test: (a) => /already in position/.test(a) },
    { key: 'reset', label: 'before the last reset', tone: 'muted', hint: 'the paper account was reset after this signal; whatever it did is no longer in the journal', test: (a) => a === 'reset' },
    { key: 'info', label: 'info only', tone: 'muted', hint: 'a marker or note the script drew, not a trade call', test: (a, s) => a === 'info' || s.kind === 'info' },
  ]
  const counts = new Map<string, number>()
  let entries = 0
  for (const s of rows) {
    const a = String(s.action ?? '')
    if (s.kind === 'entry') entries++
    const d = defs.find((x) => x.test(a, s))
    const k = d ? d.key : a.startsWith('rejected') ? 'other-rejected' : 'other'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const buckets = defs.filter((d) => counts.get(d.key)).map((d) => ({ ...d, n: counts.get(d.key)! }))
  if (counts.get('other-rejected')) buckets.push({ key: 'other-rejected', label: 'rejected (other)', tone: 'warn', hint: 'see the Action column', n: counts.get('other-rejected')!, test: () => false })
  if (counts.get('other')) buckets.push({ key: 'other', label: 'other', tone: 'muted', hint: '', n: counts.get('other')!, test: () => false })
  return { total: rows.length, entries, opened: counts.get('opened') ?? 0, buckets }
}


/** The gate an action names, in the operator's words, with where to read about it (decision 120). */
function gateOf(action: string | null | undefined): { key: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'muted' | 'accent'; href?: string } {
  const a = String(action ?? '')
  if (a === 'opened' || a === 'reversed' || a.startsWith('pending')) return { key: 'opened', label: 'opened', tone: 'ok' }
  if (a.startsWith('rejected:risk regime')) return { key: 'regime', label: 'regime gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:stop too tight')) return { key: 'cost', label: 'cost rule', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:risk market')) return { key: 'market', label: 'market gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('rejected:unpriceable')) return { key: 'quote', label: 'no quote', tone: 'warn', href: '/gates' }
  if (/rejected:(risk )?(max |margin|budget)/.test(a) || /positions on|position budget/.test(a)) return { key: 'capacity', label: 'capacity', tone: 'warn', href: '/gates' }
  if (/rejected:risk (burst|re-entry|cooldown)/.test(a)) return { key: 'guard', label: 'guard', tone: 'muted', href: '/gates' }
  if (/halt|loss limit/.test(a)) return { key: 'halt', label: 'halted', tone: 'danger', href: '/gates' }
  if (/stale/.test(a)) return { key: 'stale', label: 'stale', tone: 'danger' }
  if (/rejected:ml/.test(a)) return { key: 'model', label: 'model gate', tone: 'warn', href: '/learn' }
  if (/trend/.test(a)) return { key: 'trend', label: 'trend gate', tone: 'warn', href: '/gates' }
  if (a.startsWith('ignored')) return { key: 'ignored', label: 'ignored', tone: 'muted' }
  if (a === 'reset') return { key: 'reset', label: 'before reset', tone: 'muted' }
  if (a === 'closed' || a === 'reduced') return { key: 'exit', label: a, tone: 'accent' }
  if (a === 'info') return { key: 'info', label: 'info', tone: 'muted' }
  return { key: 'other', label: a.replace(/^rejected:/, '').slice(0, 24) || '—', tone: 'muted' }
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
  if (!groups.length) return <div className="empty"><span>No signals<span className="empty-hint">Enable a scanner and wait for the next closed bar.</span></span></div>
  return (
    <div className="table-wrap">
      <div className="row gap" style={{ padding: '8px 12px' }}>
        <span className="muted small">{groups.length} cells · sorted by opened, then signals</span>
        <button className="btn btn-xs" onClick={() => setOpen(new Set(groups.map((g) => g.k)))}>Expand all</button>
        <button className="btn btn-xs" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      <table className="table small signals-grouped">
        <caption className="sr-only">Signals grouped by cell</caption>
        <thead><tr><th scope="col">Cell</th><th scope="col">Signals</th><th scope="col">Opened</th><th scope="col">Refused by</th><th scope="col">Last</th></tr></thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.k}>
              <tr className="cohort-row group-row" onClick={() => toggle(g.k)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g.k) } }} aria-expanded={open.has(g.k)}>
                <th scope="rowgroup"><span className="muted mono">{open.has(g.k) ? '▾' : '▸'}</span> <Link to={`/scanners/${g.scannerId}`} className="strong" onClick={(e) => e.stopPropagation()}>{g.scannerName}</Link> <span className="mono">{g.symbol} {g.tf}</span></th>
                <td className="mono" data-label="signals">{g.entries}{g.list.length !== g.entries ? <span className="muted"> +{g.list.length - g.entries} exits/info</span> : null}</td>
                <td className={`mono ${g.opened ? 'gain' : 'muted'}`} data-label="opened">{g.opened}</td>
                <td data-label="refused by">{[...g.counts.entries()].filter(([k]) => k !== 'opened').sort((a, b) => b[1] - a[1]).map(([k, n]) => { const sample = g.list.find((s) => gateOf(s.action).key === k); const gg = gateOf(sample?.action); return <Pill key={k} tone={gg.tone} title={sample?.action ?? ''}>{n} {gg.label}</Pill> })}</td>
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
