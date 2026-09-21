import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMarkets, useScannerIndex, useSignals } from '../api/queries'
import type { Signal, SignalKind, Side } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ActionPill, ErrorState, Loading, PageTitle, Panel, ScoreBadge, SidePill, StatusDot, Time } from '../components/ui'
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

  return (
    <div className="page">
      <PageTitle pre="Every alert," accent="scored" post="and actioned." sub="Live feed of entries, exits and infos from all enabled scanners." />
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
