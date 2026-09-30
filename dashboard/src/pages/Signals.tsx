import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMarkets, useScannerIndex, useSignals } from '../api/queries'
import type { Signal, SignalKind, Side } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ActionPill, ErrorState, Loading, PageTitle, Panel, Pill, ScoreBadge, SidePill, StatusDot, Time } from '../components/ui'
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
        {signals.data && <SignalsTable signals={rows} maxHeight="calc(100vh - 300px)" />}
      </Panel>
    </div>
  )
}


/** The fate of a batch of signals, in the operator's words: how many became trades, and what refused the rest. */
function summarizeOutcomes(rows: Signal[]) {
  const defs: Array<{ key: string; label: string; tone: 'ok' | 'danger' | 'warn' | 'muted' | 'accent'; hint: string; test: (a: string, s: Signal) => boolean }> = [
    { key: 'opened', label: 'opened', tone: 'ok', hint: 'became a position', test: (a) => a === 'opened' },
    { key: 'market', label: 'market not suitable', tone: 'warn', hint: 'the markets-today gate: illiquid, too quiet to pay the round trip, or not paying recently (decision 56)', test: (a) => a.startsWith('rejected:market') },
    { key: 'fee', label: 'stop too tight for fees', tone: 'warn', hint: 'the stop is closer than 4× the round-trip fee; taking the trade loses money', test: (a) => /stop too tight/.test(a) },
    { key: 'capacity', label: 'margin / position cap', tone: 'warn', hint: 'no room in the account: margin, position limits, or a scrap-sized fill refused (decision 53)', test: (a) => /margin|max positions|position cap|intended size|budget/.test(a) },
    { key: 'stale', label: 'stale (scan too late)', tone: 'danger', hint: 'the scan finished after the signal aged out', test: (a) => /stale/.test(a) },
    { key: 'halted', label: 'halted / loss limit', tone: 'danger', hint: 'kill switch, daily or weekly loss limit, cooldown', test: (a) => /halt|loss limit|cooldown/.test(a) },
    { key: 'regime', label: 'regime', tone: 'muted', hint: 'weekend or ATR floor', test: (a) => /regime/.test(a) },
    { key: 'exitnopos', label: 'exit, no position', tone: 'muted', hint: 'an exit signal with nothing open to close', test: (a) => /no position/.test(a) },
    { key: 'inpos', label: 'already in position', tone: 'muted', hint: 'the scanner already holds this market', test: (a) => /already in position/.test(a) },
    { key: 'reset', label: 'reset', tone: 'muted', hint: 'the book was reset after the signal', test: (a) => a === 'reset' },
    { key: 'info', label: 'info', tone: 'muted', hint: 'informational signal, nothing to act on', test: (a, s) => a === 'info' || s.kind === 'info' },
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
