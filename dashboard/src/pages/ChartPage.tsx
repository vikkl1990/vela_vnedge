import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { qk, useConfig, useMarkets, usePositionPath, usePositions, useScannerIndex, useSignals } from '../api/queries'
import { VelaChart, type ChartScript } from '../chart/VelaChart'
import { positionOverlay } from '../chart/positionOverlay'
import { AlertsFeed } from '../components/AlertsFeed'
import { ChipSelect, Panel, Pill, QueryState } from '../components/ui'
import { fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { DELTA_TIMEFRAMES } from '../lib/timeframes'
import { useLivePrice } from '../sse/prices'

const LS_KEY = 'vnedge.chart'

export function ChartPage() {
  const markets = useMarkets()
  const config = useConfig()
  const scanners = useScannerIndex()

  const [symbolSel, setSymbol] = useState<string>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').symbol ?? ''
    } catch {
      return ''
    }
  })
  const [tf, setTf] = useState<string>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').tf ?? '15m'
    } catch {
      return '15m'
    }
  })
  const [selected, setSelected] = useState<string[]>([])
  const [showPosition, setShowPosition] = useState(true)
  const [scriptErrors, setScriptErrors] = useState<Record<string, string>>({})

  const symbolOptions = useMemo(() => {
    const list = (markets.data ?? []).map((m) => m.symbol)
    for (const s of config.data?.symbols ?? []) if (!list.includes(s)) list.unshift(s)
    return list
  }, [markets.data, config.data])

  const symbol = symbolSel || symbolOptions[0] || 'BTCUSD'
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ symbol, tf }))
    } catch {
      /* ignore */
    }
  }, [symbol, tf])

  const enabledScanners = useMemo(() => (scanners.data ?? []).filter((s) => s.enabled && s.status === 'ok' && !s.hidden), [scanners.data])
  const scannerNames = useMemo(() => enabledScanners.map((s) => s.name), [enabledScanners])
  const selectedIds = useMemo(() => enabledScanners.filter((s) => selected.includes(s.name)).map((s) => s.id), [enabledScanners, selected])

  const sources = useQueries({
    queries: selectedIds.map((id) => ({
      queryKey: qk.scannerSource(id),
      queryFn: () => api.scannerSource(id),
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  })

  const scripts = useMemo<ChartScript[]>(() => {
    const out: ChartScript[] = []
    selectedIds.forEach((id, i) => {
      const src = sources[i]?.data
      const sc = enabledScanners.find((s) => s.id === id)
      if (src?.patched && sc) out.push({ id, title: sc.name, source: src.patched, overlay: sc.overlay })
    })
    return out
  }, [selectedIds, sources, enabledScanners])


  // the open position on this market: its levels are drawn as an overlay, and the scanner that
  // opened it is selected automatically, so the chart shows the indicator that made the decision
  const positions = usePositions()
  const position = useMemo(() => (positions.data ?? []).find((p) => p.symbol === symbol && p.tf === tf) ?? (positions.data ?? []).find((p) => p.symbol === symbol), [positions.data, symbol, tf])
  const path = usePositionPath(showPosition && position ? position.id : null)
  const peakR = useMemo(() => {
    const rows = path.data?.path ?? []
    return rows.length ? Math.max(...rows.map((r) => r.r)) : null
  }, [path.data])
  useEffect(() => {
    if (!position) return
    const sc = enabledScanners.find((s) => s.id === position.scannerId)
    if (sc) setSelected((cur) => (cur.includes(sc.name) ? cur : [...cur, sc.name]))
  }, [position?.id, enabledScanners])

  const allScripts = useMemo<ChartScript[]>(
    () => (showPosition && position ? [...scripts, positionOverlay(position, peakR)] : scripts),
    [scripts, showPosition, position, peakR],
  )

  const signals = useSignals({ symbol: symbol || undefined, limit: 30 })
  // the model's score for the entry that opened this position, when the model had an opinion at all
  const entrySignal = useMemo(
    () => (position ? (signals.data ?? []).find((sg) => sg.positionId === position.id) : undefined),
    [signals.data, position],
  )
  const market = markets.data?.find((m) => m.symbol === symbol)
  const live = useLivePrice(symbol, market?.markPrice)

  return (
    <div className="page page-chart">
      <div className="toolbar">
        <label className="field-inline">
          <span className="chips-label">Symbol</span>
          <select className="select" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
            {!symbolOptions.includes(symbol) && <option value={symbol}>{symbol}</option>}
            {symbolOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span className="chips-label">Timeframe</span>
          <select className="select" value={tf} onChange={(e) => setTf(e.target.value)} aria-label="Timeframe">
            {DELTA_TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {market && (
          <span className="row gap">
            <span className="mono strong">{fmtPrice(live, market.tickSize)}</span>
            <span className={`mono ${pnlClass(market.change24hPct)}`}>{fmtPct(market.change24hPct, 1, true)}</span>
            <span className="muted small">{market.description}</span>
          </span>
        )}
        {position && (
          <label className="field-inline" title="Draw this position's entry, stop and targets on the chart">
            <input type="checkbox" checked={showPosition} onChange={(e) => setShowPosition(e.target.checked)} />
            <span className="chips-label">
              Position #{position.id} · {position.side} · {position.scannerName}
              {peakR != null && <span className="muted small"> · peak {peakR >= 0 ? '+' : ''}{peakR.toFixed(2)}R</span>}
              {entrySignal?.mlProb != null && (
                <span className="muted small" title="The learned model's win probability for this entry. It is off as a filter (decision 37) and trained mostly on scripts this fleet does not trade.">
                  {' '}· model {(entrySignal.mlProb * 100).toFixed(0)}%
                </span>
              )}
            </span>
          </label>
        )}
        <span className="grow" />
        <span className="muted small">
          {scripts.length} script{scripts.length === 1 ? '' : 's'} on chart
          {Object.keys(scriptErrors).length ? <span className="loss"> · {Object.keys(scriptErrors).length} error(s)</span> : null}
        </span>
      </div>

      <div className="chips-row">
        <ChipSelect label="Overlay scripts" options={scannerNames} value={selected} onChange={setSelected} emptyLabel={enabledScanners.length ? 'none selected' : 'no enabled scanners'} />
        {sources.some((s) => s.isLoading) && <span className="muted small">loading sources…</span>}
        {Object.entries(scriptErrors).map(([id, msg]) => (
          <Pill key={id} tone="danger" title={msg}>
            {enabledScanners.find((s) => s.id === id)?.name ?? id}: error
          </Pill>
        ))}
      </div>

      <div className="chart-layout">
        <div className="chart-main">
          {symbol ? (
            <VelaChart
              symbol={symbol}
              tf={tf}
              height="100%"
              scripts={allScripts}
              tickSize={market?.tickSize}
              onScriptError={(id, err) => setScriptErrors((e) => ({ ...e, [id]: err.message }))}
              onScriptReady={(id) =>
                setScriptErrors((e) => {
                  if (!(id in e)) return e
                  const n = { ...e }
                  delete n[id]
                  return n
                })
              }
            />
          ) : (
            <div className="state muted">Pick a symbol to start.</div>
          )}
        </div>
        <Panel title={`Latest signals · ${symbol || '–'}`} className="chart-side" pad={false}>
          <QueryState {...signals} data={signals.data} empty="No signals for this symbol." hint="Pick another symbol or enable a scanner on it." skeleton="cards" skeletonRows={4} onRetry={() => signals.refetch()}>
            {(d) => <AlertsFeed signals={d} limit={30} title="VNEdge Bot" />}
          </QueryState>
        </Panel>
      </div>
    </div>
  )
}
