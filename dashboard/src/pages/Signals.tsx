import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMarkets, useScanners, useSignals } from '../api/queries'
import type { Signal, SignalKind, Side } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ActionPill, ErrorState, Loading, PageTitle, Panel, ScoreBadge, SidePill, StatusDot } from '../components/ui'
import { fmtDateTime, fmtPrice, fmtTime, truncate } from '../lib/format'
import { useNow } from '../lib/useNow'
import { useSSEEvent } from '../sse/SSEProvider'

const FLASH_MS = 3000

/** Signals table with the "scan results" style; new rows flash briefly. */
export function SignalsTable({ signals, hideScanner = false, maxHeight }: { signals: Signal[]; hideScanner?: boolean; maxHeight?: number | string }) {
  const { data: markets } = useMarkets()
  const [flash, setFlash] = useState<Map<number, number>>(new Map())
  const now = useNow(1000)
  useSSEEvent('signal', (s) => setFlash((m) => new Map(m).set(s.id, Date.now())))
  const tick = (sym: string) => markets?.find((m) => m.symbol === sym)?.tickSize

  const cols: Column<Signal>[] = [
    { key: 'at', header: 'Time', value: (s) => s.at, render: (s) => <span className="mono small" title={fmtDateTime(s.at)}>{fmtTime(s.at)}</span>, width: 80 },
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
            <div className="muted small mono">{s.tf} · {s.kind}</div>
          </span>
        </span>
      ),
    },
    { key: 'kind', header: 'Kind', value: (s) => s.kind, render: (s) => <span className={`kind kind-${s.kind}`}>{s.kind}</span> },
    { key: 'side', header: 'Side', value: (s) => s.side, render: (s) => <SidePill side={s.side} /> },
    { key: 'price', header: 'Price', align: 'right', value: (s) => s.price, render: (s) => <span className="mono">{fmtPrice(s.price, tick(s.symbol))}</span> },
    { key: 'sl', header: 'SL', align: 'right', value: (s) => s.sl, render: (s) => <span className="mono loss">{fmtPrice(s.sl, tick(s.symbol))}</span> },
    {
      key: 'tp',
      header: 'TP1 / 2 / 3',
      align: 'right',
      sortable: false,
      render: (s) => (
        <span className="mono small tp-list gain">
          {[0, 1, 2].map((i) => (
            <span key={i}>{fmtPrice(s.tp?.[i], tick(s.symbol))}</span>
          ))}
        </span>
      ),
    },
    { key: 'score', header: 'Score', align: 'right', value: (s) => s.score, render: (s) => <ScoreBadge score={s.score} /> },
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

  return (
    <DataTable
      columns={cols}
      rows={signals}
      rowKey={(s) => s.id}
      defaultSort={{ key: 'at', dir: 'desc' }}
      emptyLabel="No signals"
      maxHeight={maxHeight}
      rowClass={(s) => {
        const t = flash.get(s.id)
        return t && now - t < FLASH_MS ? 'row-new' : undefined
      }}
    />
  )
}

export function Signals() {
  const scanners = useScanners()
  const markets = useMarkets()
  const [scanner, setScanner] = useState('')
  const [symbol, setSymbol] = useState('')
  const [kind, setKind] = useState<'' | SignalKind>('')
  const [side, setSide] = useState<'' | Side>('')
  const q = useMemo(() => ({ limit: 300, scanner: scanner || undefined, symbol: symbol || undefined, kind: kind || undefined }), [scanner, symbol, kind])
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
        {signals.isLoading && !signals.data && <Loading label="Loading signals…" />}
        {signals.isError && !signals.data && <ErrorState error={signals.error} onRetry={() => signals.refetch()} />}
        {signals.data && <SignalsTable signals={rows} />}
      </Panel>
    </div>
  )
}
