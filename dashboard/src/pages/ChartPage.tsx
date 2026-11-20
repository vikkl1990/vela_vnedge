import type { ScriptRun } from '@luxalgo/vela'
import { useInfiniteQuery, useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import {
  qk,
  useConfig,
  useMarkets,
  usePositionPath,
  usePositions,
  useScannerIndex,
  useSignals,
} from '../api/queries'
import { ChartFrames, FramePicker } from '../chart/ChartFrames'
import { activeChartKeys, retainChartRecord } from '../chart/activeRecords'
import { CryptoComparison } from '../chart/CryptoComparison'
import { decisionMarks } from '../chart/decisionMarks'
import { OrderFlowPanel } from '../chart/OrderFlowPanel'
import { positionOverlay } from '../chart/positionOverlay'
import { TradeComparisonPanel } from '../chart/TradeComparisonPanel'
import {
  authorTradeMarks,
  botTradeMarks,
  scriptContextKey,
  type AuthorLedger,
} from '../chart/tradeComparison'
import { REFRESH } from '../api/refreshPolicy'
import { ScriptReadout } from '../chart/ScriptReadout'
import { snapshotRun, type ScriptSnapshot } from '../chart/scriptSnapshot'
import { VelaChart, type ChartScript } from '../chart/VelaChart'
import { AlertsFeed } from '../components/AlertsFeed'
import { Callout, ChipSelect, PageHeader, Pill, QueryState, Section, Toolbar } from '../components/kit'
import { protectionText, quantityText } from '../lib/protection'

import { fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { DELTA_TIMEFRAMES, FRAME_PRESET } from '../lib/timeframes'
import { useNow } from '../lib/useNow'
import { useLivePrice } from '../sse/prices'
import '../styles/pages/chart.css'

const LS_KEY = 'vnedge.chart'

export function ChartPage() {
  const markets = useMarkets()
  const config = useConfig()
  const scanners = useScannerIndex()
  const [params, setParams] = useSearchParams()

  const [symbolSel, setSymbol] = useState<string>(() => {
    if (params.get('symbol')) return params.get('symbol')!
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').symbol ?? ''
    } catch {
      return ''
    }
  })
  const [tf, setTf] = useState<string>(() => {
    const linked = params.get('tf')
    if (linked && ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d'].includes(linked))
      return linked
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').tf ?? '15m'
    } catch {
      return '15m'
    }
  })
  // single chart or several timeframes side by side (decision 97), remembered with the symbol
  const [view, setView] = useState<'single' | 'frames'>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').view === 'frames' ? 'frames' : 'single'
    } catch {
      return 'single'
    }
  })
  const [frames, setFrames] = useState<string[]>(() => {
    try {
      const f = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}').frames
      return Array.isArray(f) && f.length ? f : FRAME_PRESET
    } catch {
      return FRAME_PRESET
    }
  })
  const [selected, setSelected] = useState<string[]>([])
  // decision 153: the Library's "Add to chart" hands scripts over as ?add=<id>[,<id>], any runnable script, enabled or not
  const addedIds = useMemo(
    () =>
      (params.get('add') ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    [params],
  )
  const removeAdded = (id: string) => {
    const left = addedIds.filter((x) => x !== id)
    const p = new URLSearchParams(params)
    if (left.length) p.set('add', left.join(','))
    else p.delete('add')
    setParams(p, { replace: true })
  }
  const [showPosition, setShowPosition] = useState(true)
  const [scriptErrors, setScriptErrors] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, ScriptSnapshot>>({})
  const [readoutOpen, setReadoutOpen] = useState(false)
  const [showClosed, setShowClosed] = useState(true)
  const [showAuthors, setShowAuthors] = useState(true)
  const [journalBook, setJournalBook] = useState<'paper' | 'shadow'>('paper')
  const [tradeDays, setTradeDays] = useState('7')
  const [ledgers, setLedgers] = useState<Record<string, AuthorLedger>>({})
  const [comparisonOpen, setComparisonOpen] = useState(false)

  const symbolOptions = useMemo(() => {
    const list = (markets.data ?? []).map((m) => m.symbol)
    for (const s of config.data?.symbols ?? []) if (!list.includes(s)) list.unshift(s)
    return list
  }, [markets.data, config.data])

  const symbol = symbolSel || symbolOptions[0] || 'BTCUSD'
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ symbol, tf, view, frames }))
    } catch {
      /* ignore */
    }
  }, [symbol, tf, view, frames])

  const enabledScanners = useMemo(
    () => (scanners.data ?? []).filter((s) => s.enabled && s.status === 'ok' && !s.hidden),
    [scanners.data],
  )
  const scannerNames = useMemo(() => enabledScanners.map((s) => s.name), [enabledScanners])

  // the open position on this market: its levels are drawn as an overlay, and the scanner that
  // opened it is selected automatically, so the chart shows the indicator that made the decision
  const positions = usePositions()
  const [positionId, setPositionId] = useState<number | null>(null)
  const symbolPositions = useMemo(
    () => (positions.data ?? []).filter((p) => p.symbol === symbol),
    [positions.data, symbol],
  )
  const position = useMemo(
    () =>
      symbolPositions.find((p) => p.id === positionId) ??
      symbolPositions.find((p) => p.tf === tf) ??
      symbolPositions[0],
    [symbolPositions, positionId, tf],
  )
  // the scanner that opened the position is always overlaid while that position is on screen
  const autoScannerId = position?.scannerId ?? null
  const heldScanner = useMemo(
    () => (scanners.data ?? []).find((s) => s.id === autoScannerId && s.status === 'ok'),
    [autoScannerId, scanners.data],
  )
  const autoName = heldScanner?.name ?? null
  const shownSelection = useMemo(
    () => (autoName && !selected.includes(autoName) ? [...selected, autoName] : selected),
    [selected, autoName],
  )
  const addedScanners = useMemo(
    () =>
      addedIds
        .map((id) => (scanners.data ?? []).find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s && s.status === 'ok')),
    [addedIds, scanners.data],
  )
  const selectedIds = useMemo(() => {
    const ids = enabledScanners.filter((s) => shownSelection.includes(s.name)).map((s) => s.id)
    if (heldScanner && !ids.includes(heldScanner.id)) ids.push(heldScanner.id)
    for (const s of addedScanners) if (!ids.includes(s.id)) ids.push(s.id)
    return ids
  }, [enabledScanners, shownSelection, addedScanners, heldScanner])

  const recordLedger = (ledger: AuthorLedger) =>
    setLedgers((prev) =>
      retainChartRecord(
        prev,
        `${ledger.symbol}:${ledger.tf}:${ledger.id}`,
        ledger,
        activeChartKeys(symbol, view === 'frames' ? frames : [tf], selectedIds),
      ),
    )
  const recordRun = (frame: string, run: ScriptRun) =>
    setRuns((prev) =>
      retainChartRecord(
        prev,
        `${symbol}:${frame}:${run.id}`,
        snapshotRun(run, frame),
        activeChartKeys(symbol, view === 'frames' ? frames : [tf], selectedIds, 'vn:'),
      ),
    )

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
      const sc = (scanners.data ?? []).find((s) => s.id === id)
      if (src?.patched && sc)
        out.push({
          id,
          title: sc.name,
          source: src.patched,
          overlay: sc.overlay,
          inputs: src.inputs,
          sourceHash: src.sourceHash,
          timezone: src.timezone,
        })
    })
    return out
  }, [selectedIds, sources, scanners.data])

  const path = usePositionPath(showPosition && position ? position.id : null)
  const peakR = useMemo(() => {
    const rows = path.data?.path ?? []
    return rows.length ? Math.max(...rows.map((r) => r.r)) : null
  }, [path.data])

  const positionLevels = useMemo(
    () => (showPosition && position ? positionOverlay(position, peakR) : null),
    [showPosition, position, peakR],
  )

  const [allSignalFrames, setAllSignalFrames] = useState(false)
  const [signalHistory, setSignalHistory] = useState(false)
  const now = useNow(60_000)
  const signals = useSignals({
    symbol: symbol || undefined,
    tf: allSignalFrames || view === 'frames' ? undefined : tf,
    since: signalHistory ? undefined : now - 86_400_000,
    limit: 100,
  })
  const positionSignals = useSignals({ positionId: position?.id ?? -1, kind: 'entry', limit: 1 })
  // the model's score for the entry that opened this position, when the model had an opinion at all
  const entrySignal = useMemo(
    () => (position ? positionSignals.data?.[0] : undefined),
    [positionSignals.data, position],
  )
  const tradeFrom =
    tradeDays === 'all' ? undefined : Math.floor(now / 86400000) * 86400000 - Number(tradeDays) * 86400000
  const journalQuery = {
    book: journalBook,
    symbol,
    tf: view === 'frames' ? undefined : tf,
    status: 'closed',
    scope: 'all',
    history: 'all',
    dateBy: 'exit',
    sort: 'newest',
    from: tradeFrom,
    limit: 200,
  }
  const closedTrades = useInfiniteQuery({
    queryKey: ['journal', 'chart', journalQuery],
    queryFn: ({ pageParam }) => api.journal({ ...journalQuery, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.rows.length < last.total ? last.offset + last.rows.length : undefined,
    enabled: showClosed || showAuthors,
    refetchInterval: REFRESH.normal,
    retry: 1,
  })
  const tradeRows = useMemo(
    () => [
      ...new Map((closedTrades.data?.pages.flatMap((p) => p.rows) ?? []).map((r) => [r.id, r])).values(),
    ],
    [closedTrades.data],
  )
  const shownLedgers = Object.values(ledgers).filter(
    (l) =>
      l.symbol === symbol &&
      (view === 'frames' ? frames.includes(l.tf) : l.tf === tf) &&
      !scriptErrors[l.id] &&
      scripts.some((s) => s.id === l.id && scriptContextKey(s) === l.contextKey),
  )
  const marksFor = (frame: string) => [
    ...decisionMarks((signals.data ?? []).filter((s) => allSignalFrames || s.tf === frame)),
    ...(showClosed ? botTradeMarks(tradeRows.filter((r) => r.tf === frame)) : []),
    ...(showAuthors ? authorTradeMarks(shownLedgers.filter((l) => l.tf === frame)) : []),
  ]
  const marks = marksFor(tf)

  const positionBadge =
    showPosition && position ? (
      <details className="panel chart-position-summary">
        <summary>
          <strong>
            OPEN #{position.id} · {position.side.toUpperCase()} {position.symbol} · {position.tf}
          </strong>{' '}
          · {quantityText(position.qtyOpen, position.contractValue)} {position.symbol.replace(/USD$/, '')} ·
          SL {fmtPrice(position.sl)} · details
        </summary>
        <div>
          {position.scannerName}
          {heldScanner && !heldScanner.enabled ? ' · disabled for new entries' : ''}
        </div>
        <div className="mono">
          Entry {fmtPrice(position.entryPrice, markets.data?.find((m) => m.symbol === symbol)?.tickSize)} · SL{' '}
          {fmtPrice(position.sl, markets.data?.find((m) => m.symbol === symbol)?.tickSize)}
        </div>
        <div className="mono">
          {position.tp
            .map((price, i) =>
              price == null
                ? null
                : `TP${i + 1} ${fmtPrice(price, markets.data?.find((m) => m.symbol === symbol)?.tickSize)}${position.tpHit[i] ? ' ✓' : (position.legs?.[i] ?? 0) <= 0 ? ' (no contracts)' : ` (${position.legs![i]} contracts)`}`,
            )
            .filter(Boolean)
            .join(' · ')}
        </div>
        <div>
          ML entry P(win):{' '}
          {entrySignal?.mlProb != null
            ? `${(entrySignal.mlProb * 100).toFixed(1)}%`
            : positionSignals.isLoading
              ? 'loading…'
              : 'unavailable at entry'}
        </div>
        <div className="muted">Recorded entry prediction · no live price forecast</div>
        <p className="small muted">{protectionText(position)}</p>
      </details>
    ) : null
  const market = markets.data?.find((m) => m.symbol === symbol)
  const live = useLivePrice(symbol, market?.markPrice)

  return (
    <div className="page page-chart">
      <PageHeader
        title="Chart"
        subtitle="Price, the bot's decisions and the scripts behind them. Indicator plots are a live preview; the marks and the decision feed come from the bot journal."
        actions={
          <nav className="chart-jumps" aria-label="Chart sections">
            <a className="btn btn-sm" href="#chart-price">
              Price &amp; frames
            </a>
            <a
              className="btn btn-sm"
              href="#chart-order-flow"
              title="Measured crypto footprints: BTC, ETH, SOL"
            >
              Order flow · Delta / CVD
            </a>
            <a
              className="btn btn-sm"
              href="#chart-venues"
              onClick={() => setComparisonOpen(true)}
              title="Measured crypto footprints: BTC, ETH, SOL"
            >
              Compare venues
            </a>
            <a className="btn btn-sm" href="#chart-values" onClick={() => setReadoutOpen(true)}>
              Scanner values
            </a>
          </nav>
        }
      />
      {heldScanner && !heldScanner.enabled && (
        <Callout tone="info" title="Read-only script">
          Held scanner {heldScanner.name} is drawn read-only because it is disabled for new entries.
        </Callout>
      )}
      {scripts.length > 0 && (
        <details className="small chart-inputs">
          <summary>Bot script inputs and source versions</summary>
          {scripts.map((s) => (
            <p key={s.id} className="mono">
              {s.title} · source {s.sourceHash ?? 'unknown'} · bot timezone {s.timezone ?? 'UTC'} · inputs{' '}
              {JSON.stringify(s.inputs ?? {})}
              {' · Applied separately to this script’s execution; chart display clock is independent.'}
            </p>
          ))}
        </details>
      )}

      <div className="chart-controls panel chart-section" id="chart-price">
        <Toolbar
          end={
            <>
              {market && (
                <span className="chart-quote">
                  <span className="mono strong">{fmtPrice(live, market.tickSize)}</span>
                  <span className={`mono ${pnlClass(market.change24hPct)}`}>
                    {fmtPct(market.change24hPct, 1, true)}
                  </span>
                  <span className="muted small chart-desc">{market.description}</span>
                </span>
              )}
              <span className="muted small">
                {scripts.length} script{scripts.length === 1 ? '' : 's'} on chart
                {Object.keys(scriptErrors).length ? (
                  <span className="loss"> · {Object.keys(scriptErrors).length} error(s)</span>
                ) : null}
              </span>
            </>
          }
        >
          <label className="field-inline">
            <span className="chips-label">Symbol</span>
            <select
              className="select"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              aria-label="Symbol"
            >
              {!symbolOptions.includes(symbol) && <option value={symbol}>{symbol}</option>}
              {symbolOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <span className="seg" role="group" aria-label="View">
            <button
              className={`btn btn-xs ${view === 'single' ? 'btn-on' : ''}`}
              onClick={() => setView('single')}
              aria-pressed={view === 'single'}
            >
              Single
            </button>
            <button
              className={`btn btn-xs ${view === 'frames' ? 'btn-on' : ''}`}
              onClick={() => setView('frames')}
              aria-pressed={view === 'frames'}
              title="The same market on several timeframes, every frame drawing the selected scripts"
            >
              Frames
            </button>
          </span>
          {view === 'single' ? (
            <label className="field-inline">
              <span className="chips-label">Timeframe</span>
              <select
                className="select"
                value={tf}
                onChange={(e) => setTf(e.target.value)}
                aria-label="Timeframe"
              >
                {DELTA_TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <FramePicker value={frames} onChange={setFrames} />
          )}
          {symbolPositions.length > 0 && (
            <label className="field-inline">
              <span className="chips-label">Open position</span>
              <select
                className="select"
                aria-label="Open position"
                value={position?.id ?? ''}
                onChange={(e) => setPositionId(Number(e.target.value))}
              >
                {symbolPositions.map((p) => (
                  <option key={p.id} value={p.id}>
                    #{p.id} · {p.side} · {p.tf} · {p.scannerName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {position && (
            <label className="field-inline" title="Draw this position's entry, stop and targets on the chart">
              <input
                type="checkbox"
                checked={showPosition}
                onChange={(e) => setShowPosition(e.target.checked)}
              />
              <span className="chips-label">
                Position #{position.id} · {position.side} · {position.scannerName}
                {peakR != null && (
                  <span className="muted small">
                    {' '}
                    · peak {peakR >= 0 ? '+' : ''}
                    {peakR.toFixed(2)}R
                  </span>
                )}
                {entrySignal?.mlProb != null && (
                  <span
                    className="muted small"
                    title="Recorded model probability when the entry was evaluated; this is not a current price forecast."
                  >
                    {' '}
                    · model {(entrySignal.mlProb * 100).toFixed(0)}%
                  </span>
                )}
              </span>
            </label>
          )}
        </Toolbar>

        {(positions.data?.length ?? 0) > 0 && (
          <div className="chart-row">
            <span className="chips-label">Open positions</span>
            {positions.data?.map((p) => (
              <button
                key={p.id}
                className={`btn btn-xs ${position?.id === p.id ? 'btn-on' : ''}`}
                aria-pressed={position?.id === p.id}
                onClick={() => {
                  setSymbol(p.symbol)
                  setPositionId(p.id)
                  setTf(p.tf)
                  setShowPosition(true)
                }}
              >
                #{p.id} {p.symbol} · {p.tf} · {p.side}
              </button>
            ))}
          </div>
        )}

        <div className="chips-row">
          <ChipSelect
            label="Overlay scripts"
            options={scannerNames}
            value={shownSelection}
            onChange={setSelected}
            emptyLabel={enabledScanners.length ? 'none selected' : 'no enabled scanners'}
          />
          {addedScanners.map((s) => (
            <span key={s.id} className="chip chip-on" title="Added from the Library">
              {s.name}
              <button
                className="chip-x"
                onClick={() => removeAdded(s.id)}
                aria-label={`Remove ${s.name} from the chart`}
              >
                ×
              </button>
            </span>
          ))}
          {sources.some((s) => s.isLoading) && <span className="muted small">loading sources…</span>}
          {Object.entries(scriptErrors).map(([id, msg]) => (
            <Pill key={id} tone="danger" title={msg}>
              {enabledScanners.find((s) => s.id === id)?.name ??
                addedScanners.find((s) => s.id === id)?.name ??
                id}
              : error
            </Pill>
          ))}
        </div>
      </div>

      <Section title="Trade layers" variant="panel">
        <Toolbar>
          <label className="field-inline">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />{' '}
            Recorded bot fills
          </label>
          <label className="field-inline">
            <input type="checkbox" checked={showAuthors} onChange={(e) => setShowAuthors(e.target.checked)} />{' '}
            Author comparison
          </label>
          <label className="field-inline">
            Trade book{' '}
            <select
              className="select"
              aria-label="Chart trade book"
              value={journalBook}
              onChange={(e) => setJournalBook(e.target.value as 'paper' | 'shadow')}
            >
              <option value="paper">Paper</option>
              <option value="shadow">Shadow · includes research plans</option>
            </select>
          </label>
          <label className="field-inline">
            Closed trades{' '}
            <select
              className="select"
              aria-label="Chart trade window"
              value={tradeDays}
              onChange={(e) => setTradeDays(e.target.value)}
            >
              <option value="7">Last 7 UTC days + today</option>
              <option value="30">Last 30 UTC days + today</option>
              <option value="all">All retained history</option>
            </select>
          </label>
        </Toolbar>
        <p className="small muted">
          {tradeRows.length} of {closedTrades.data?.pages[0]?.total ?? '…'} closed {journalBook} trades
          loaded, including reset archives. B = bot entry · P = partial exit · X = final exit · A/x = author
          simulation. Click timeline marks for prices, fees, net R and exit reasons.
        </p>
        {closedTrades.isError && (
          <p role="alert">
            Trade journal unavailable: {closedTrades.error.message}{' '}
            <button className="btn btn-sm" onClick={() => void closedTrades.refetch()}>
              Retry trades
            </button>
          </p>
        )}
        {closedTrades.hasNextPage && (
          <button
            className="btn btn-sm"
            disabled={closedTrades.isFetchingNextPage}
            onClick={() => void closedTrades.fetchNextPage()}
          >
            {closedTrades.isFetchingNextPage ? 'Loading…' : 'Load more closed trades'}
          </button>
        )}
      </Section>
      {positionBadge}
      <div className={`chart-layout ${view === 'frames' ? 'chart-layout-frames' : ''}`}>
        <div className="chart-main" style={{ position: 'relative' }}>
          {symbol && view === 'frames' ? (
            <ChartFrames
              key={symbol}
              onScriptRun={recordRun}
              marksByFrame={Object.fromEntries(frames.map((frame) => [frame, marksFor(frame)]))}
              captureLedger={showAuthors}
              onAuthorLedger={recordLedger}
              symbol={symbol}
              tfs={frames}
              scripts={scripts}
              positionOverlay={positionLevels}
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
          ) : symbol ? (
            <VelaChart
              captureLedger={showAuthors}
              onAuthorLedger={recordLedger}
              onScriptRun={(r) => recordRun(tf, r)}
              marks={marks}
              symbol={symbol}
              tf={tf}
              height="100%"
              scripts={scripts}
              positionOverlay={positionLevels}
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
        <Section
          variant="panel"
          title={`Bot decisions · ${symbol || '–'} · ${allSignalFrames || view === 'frames' ? 'all frames' : tf}`}
          actions={
            <span>
              <label className="small">
                <input
                  type="checkbox"
                  checked={signalHistory}
                  onChange={(e) => setSignalHistory(e.target.checked)}
                />{' '}
                Include older records
              </label>{' '}
              <label className="small">
                <input
                  type="checkbox"
                  checked={allSignalFrames}
                  onChange={(e) => setAllSignalFrames(e.target.checked)}
                />{' '}
                All timeframes
              </label>
            </span>
          }
          className="chart-side"
          pad={false}
        >
          <QueryState
            {...signals}
            data={signals.data}
            empty="No signals for this symbol."
            hint="Pick another symbol or enable a scanner on it."
            skeleton="cards"
            skeletonRows={4}
            onRetry={() => signals.refetch()}
          >
            {(d) => <AlertsFeed signals={d} limit={100} title="Recorded bot decisions" showActions />}
          </QueryState>
        </Section>
      </div>
      {showAuthors && (
        <TradeComparisonPanel
          rows={tradeRows}
          ledgers={shownLedgers}
          selectedCount={scripts.length}
          loading={closedTrades.isLoading}
          error={closedTrades.error?.message}
        />
      )}
      <ScriptReadout
        open={readoutOpen}
        onOpenChange={setReadoutOpen}
        selectedCount={selectedIds.length}
        runs={Object.entries(runs)
          .filter(
            ([key, r]) =>
              key.startsWith(`${symbol}:`) &&
              (view === 'frames' ? frames.includes(r.tf) : r.tf === tf) &&
              selectedIds.some((id) => r.id === `vn:${id}`),
          )
          .map(([, r]) => r)}
      />
      <OrderFlowPanel symbol={symbol} />
      <CryptoComparison
        symbol={symbol}
        tf={tf}
        scripts={scripts}
        open={comparisonOpen}
        onOpenChange={setComparisonOpen}
      />
    </div>
  )
}
