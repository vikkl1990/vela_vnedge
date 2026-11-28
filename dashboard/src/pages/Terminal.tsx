import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useConfig, useMarkets, usePositions, useRisk, useScannerIndex, useStats } from '../api/queries'
import type { Config, Signal } from '../api/types'
import { useFrameSync } from '../chart/useFrameSync'
import { viewFrames } from '../lib/viewFrames'
import { ScannerCellStats } from '../components/ScannerCellStats'
import { TerminalFrame } from '../components/TerminalFrame'
import { PaperPositions } from '../components/PaperPositions'
import { ErrorState, Loading, Pill } from '../components/kit'
import { fmtMoney, fmtPct, fmtPnl, fmtPrice, pnlClass, timeAgo } from '../lib/format'
import { patchSearch } from '../lib/researchNavigation'
import { gateOf } from '../lib/signalOutcomes'
import { accountPositionLimit } from '../lib/positionCapacity'
import { openCapital } from '../lib/workspace'
import { useLiveTick } from '../sse/prices'
import { useNow } from '../lib/useNow'
import { Funnel, Rules } from './Trading'
import '../styles/pages/scalp.css'

/**
 * The scalper terminal: one screen, chart first. Left, the markets the bot trades with their latest signal; centre,
 * the chart with every entry signal on its bar (filled when it opened a trade, hollow when a rule refused it) and the
 * open trade's levels; right, the signal tape as the engine decides it; below, positions, the funnel and the rules.
 * Everything polls the same endpoints as the rest of the dashboard: nothing here can trade.
 */
const FRAMES = ['1m', '5m', '15m', '1h', '4h'] as const
const short = (sym: string) => sym.replace(/USD$/, '')

/** The (market, timeframe) cells an enabled scanner trades: its explicit pairs, else its markets × timeframes. */
function scannerCells(cfg: Config): Array<{ id: string; symbol: string; tf: string }> {
  return Object.entries(cfg.scanners ?? {})
    .filter(([, s]) => s.enabled)
    .flatMap(([id, s]) =>
      s.pairs?.length
        ? s.pairs.map((p) => ({ id, ...p }))
        : (s.symbols ?? cfg.symbols).flatMap((symbol) => (s.timeframes ?? cfg.timeframes).map((tf) => ({ id, symbol, tf }))),
    )
}

function LivePrice({ symbol, fallback, tickSize }: { symbol: string; fallback?: number; tickSize?: number }) {
  const tick = useLiveTick(symbol, fallback)
  return (
    <span
      className={`scalp-price mono ${tick.stale ? 'price-stale' : ''}`}
      title={tick.stale ? 'Last known price; live tick is stale or unavailable' : 'Latest trade price'}
    >
      {tick.price == null ? '—' : fmtPrice(tick.price, tickSize)}
    </span>
  )
}

export function Terminal() {
  const [search, setSearch] = useSearchParams()
  const config = useConfig()
  const markets = useMarkets()
  const positions = usePositions()
  const stats = useStats()
  const risk = useRisk()
  const now = useNow(5_000)
  const update = (changes: Record<string, string | null>) => setSearch(patchSearch(search, changes))

  // the markets and timeframes the enabled scanners trade
  const bot = useMemo(() => {
    const cells = config.data ? scannerCells(config.data) : []
    const symbols = [...new Set(cells.map((c) => c.symbol))]
    const tfs = FRAMES.filter((tf) => cells.some((c) => c.tf === tf)) as string[]
    return { cells, symbols, tfs }
  }, [config.data])
  const symbol = search.get('symbol') || bot.symbols[0] || 'BTCUSD'
  const reqTf = search.get('tf')
  const frame = reqTf && (FRAMES as readonly string[]).includes(reqTf) ? reqTf : bot.tfs[0] ?? '15m'
  const [scope, setScope] = useState<'bot' | 'all'>('bot')
  const [filter, setFilter] = useState('')
  const [tapeOnly, setTapeOnly] = useState<'all' | 'opened'>('all')
  const [dock, setDock] = useState<'positions' | 'stats' | 'funnel' | 'rules'>('positions')
  const reqCharts = Number(search.get('charts'))
  const charts: 1 | 2 | 4 = reqCharts === 2 || reqCharts === 4 ? reqCharts : 1
  const frames = viewFrames(frame, charts)
  const { register } = useFrameSync(frames)

  const tape = useQuery({
    queryKey: ['scalp-tape'],
    queryFn: () => api.signals({ kind: 'entry', limit: 150 }),
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
  // the scanners that trade this market on this timeframe, drawn on the chart from their own Pine
  const scanners = useScannerIndex()
  const cellIds = useMemo(
    () => [...new Set(bot.cells.filter((c) => c.symbol === symbol && c.tf === frame).map((c) => c.id))],
    [bot.cells, symbol, frame],
  )
  const [hidden, setHidden] = useState<Record<string, boolean>>({})
  const [scriptErrors, setScriptErrors] = useState<Record<string, string>>({})
  const nameOf = (id: string) => (scanners.data ?? []).find((s) => s.id === id)?.name ?? id
  // the account's closed trades on this market (every timeframe): trade boxes and the scanner stats read them (the journal pages at most 200 rows)
  const journal = useQuery({
    queryKey: ['scalp-journal', symbol],
    queryFn: () => api.journal({ book: 'paper', symbol, status: 'closed', scope: 'all', history: 'all', dateBy: 'exit', sort: 'newest', limit: 200 }),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
  const closed = journal.data?.rows ?? []
  const overview = useQuery({
    queryKey: ['trading-overview', '1'],
    queryFn: () => api.tradingOverview(1),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })

  const latestBySymbol = useMemo(() => {
    const m = new Map<string, Signal>()
    for (const s of tape.data ?? []) if (!m.has(s.symbol) || m.get(s.symbol)!.at < s.at) m.set(s.symbol, s)
    return m
  }, [tape.data])
  const held = new Set((positions.data ?? []).map((p) => p.symbol))
  const universe = scope === 'bot' && bot.symbols.length ? bot.symbols : (markets.data ?? []).map((m) => m.symbol)
  const rows = universe
    .map((sym) => ({ sym, m: markets.data?.find((x) => x.symbol === sym) }))
    .filter((r) => !filter || r.sym.toLowerCase().includes(filter.toLowerCase()))
  const selected = markets.data?.find((m) => m.symbol === symbol)
  const tapeRows = (tape.data ?? []).filter((s) => tapeOnly === 'all' || s.action === 'opened')
  const capital = useMemo(() => openCapital(positions.data ?? []), [positions.data])
  const st = stats.data
  const total = st ? st.equity - (config.data?.paper.initialEquity ?? st.equity) : null
  const cap = config.data
    ? (accountPositionLimit(config.data.paper.maxOpenPositions, config.data.risk?.maxPositionsTotal ?? 0, config.data.risk?.enabled) ??
      'no count cap')
    : '—'
  const halted = risk.data?.halted

  return (
    <div className="page scalp">
      <div className="terminal-account-strip scalp-bar">
        <div>
          <span>Equity</span>
          <strong className={`mono ${pnlClass(total)}`}>{st ? `$${fmtMoney(st.equity)}` : '—'}</strong>
          <small>{total == null ? '—' : `${fmtPnl(total)} since start`}</small>
        </div>
        <div>
          <span>Today · UTC</span>
          <strong className={`mono ${pnlClass(risk.data?.day?.pnl)}`}>
            {risk.data?.day ? `$${fmtPnl(risk.data.day.pnl)}` : '—'}
          </strong>
          <small>including open P&L</small>
        </div>
        <div>
          <span>Open risk</span>
          <strong className="mono">{positions.data ? `$${fmtMoney(capital.risk)}` : '—'}</strong>
          <small>{positions.data ? `$${fmtMoney(capital.margin)} margin` : '—'}</small>
        </div>
        <div>
          <span>Positions</span>
          <strong className="mono">
            {positions.data?.length ?? '—'}
            <em> / {cap}</em>
          </strong>
          <small>Shared account; margin and risk checks apply</small>
        </div>
        <div>
          <span>24h signals</span>
          <strong className="mono">
            {overview.data
              ? `${overview.data.funnel.stages.find((x) => x.stage === 'opened')?.n ?? 0} / ${overview.data.funnel.fired}`
              : '—'}
          </strong>
          <small>opened / fired</small>
        </div>
        <div className="scalp-state">
          <span>Engine</span>
          <strong className={halted ? 'tone-warn' : 'tone-gain'}>
            <i className={`scalp-dot ${halted ? 'off' : 'on'}`} aria-hidden />
            {!risk.data ? '—' : halted ? 'Paused' : 'Scanning'}
          </strong>
          <small>
            {config.data?.execution?.mode ?? '—'} · {bot.tfs.join(', ') || '—'} · {bot.symbols.length} markets
          </small>
        </div>
      </div>

      <div className="scalp-grid">
        <section className="scalp-panel scalp-watch" aria-label="Markets">
          <div className="scalp-head">
            <div className="scalp-seg" role="group" aria-label="Market list">
              <button aria-pressed={scope === 'bot'} onClick={() => setScope('bot')}>
                Bot <small>{bot.symbols.length}</small>
              </button>
              <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                All <small>{markets.data?.length ?? '—'}</small>
              </button>
            </div>
          </div>
          <input
            className="scalp-search"
            placeholder="Filter…"
            aria-label="Filter markets"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="scalp-watch-cols">
            <span>Market</span>
            <span>Last</span>
            <span>24h</span>
          </div>
          <div className="scalp-scroll">
            {markets.isLoading && <Loading kind="cards" rows={4} />}
            {markets.isError && <ErrorState error={markets.error} onRetry={() => markets.refetch()} />}
            {rows.map(({ sym, m }) => {
              const sig = latestBySymbol.get(sym)
              return (
                <button
                  key={sym}
                  className={`scalp-row ${symbol === sym ? 'on' : ''}`}
                  aria-pressed={symbol === sym}
                  onClick={() => update({ symbol: sym })}
                >
                  <span className="scalp-sym">
                    <span className="scalp-sym-top">
                      {held.has(sym) && <i className="scalp-dot on" title="Position open" />}
                      <b>{short(sym)}</b>
                    </span>
                    {sig && (
                      <small
                        className={sig.side === 'long' ? 'gain' : 'loss'}
                        title={`${sig.scannerName} · ${gateOf(sig.action).label}`}
                      >
                        {sig.side === 'long' ? '▲' : '▼'} {timeAgo(sig.at, now)}
                      </small>
                    )}
                  </span>
                  <span className="mono">{m ? fmtPrice(m.markPrice, m.tickSize) : '—'}</span>
                  <span className={`mono ${pnlClass(m?.change24hPct)}`}>
                    {m ? `${m.change24hPct > 0 ? '+' : ''}${fmtPct(m.change24hPct)}` : '—'}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="scalp-panel scalp-chart" aria-label="Chart">
          <div className="scalp-chart-head">
            <div className="scalp-title">
              <h1>
                {short(symbol)}
                <span>/USD · perp</span>
              </h1>
              <LivePrice symbol={symbol} fallback={selected?.markPrice} tickSize={selected?.tickSize} />
              {selected && (
                <span className={`mono scalp-change ${pnlClass(selected.change24hPct)}`}>
                  {selected.change24hPct > 0 ? '+' : ''}
                  {fmtPct(selected.change24hPct)}
                </span>
              )}
            </div>
            <div className="scalp-seg" role="group" aria-label="Chart timeframe">
              {FRAMES.map((tf) => (
                <button key={tf} aria-pressed={frame === tf} onClick={() => update({ tf })}>
                  {tf}
                  {bot.tfs.includes(tf) && <i className="scalp-dot on" title="The bot trades this timeframe" />}
                </button>
              ))}
              <span className="scalp-seg scalp-charts" role="group" aria-label="Charts shown">
                {([1, 2, 4] as const).map((n) => (
                  <button key={n} aria-pressed={charts === n} onClick={() => update({ charts: n === 1 ? null : String(n) })} title={n === 1 ? 'One chart' : `${n} timeframes: ${viewFrames(frame, n).join(', ')}`}>
                    {n === 1 ? '▢' : n === 2 ? '▢▢' : '▦'}
                  </button>
                ))}
              </span>
              <Link className="scalp-link" to={`/chart?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(frame)}`}>
                Full chart ↗
              </Link>
            </div>
          </div>
          <div className="scalp-scripts" role="group" aria-label="Scanner overlays">
            {cellIds.length ? (
              cellIds.map((id) => (
                <button
                  key={id}
                  aria-pressed={!hidden[id]}
                  onClick={() => setHidden((h) => ({ ...h, [id]: !h[id] }))}
                  title={scriptErrors[id] ? `Script error: ${scriptErrors[id]}` : hidden[id] ? 'Show its Pine on the chart' : 'Hide its Pine'}
                  className={scriptErrors[id] ? 'err' : ''}
                >
                  <i className={`scalp-dot ${hidden[id] ? 'off' : 'on'}`} aria-hidden /> {nameOf(id)}
                </button>
              ))
            ) : (
              <small>No scanner trades {short(symbol)} on {frame}; the chart shows price and journal marks only.</small>
            )}
          </div>
          <div className={`scalp-canvas scalp-frames n${frames.length}`}>
            {frames.map((tf) => (
              <TerminalFrame
                key={tf}
                symbol={symbol}
                tf={tf}
                cells={bot.cells}
                hidden={hidden}
                tickSize={selected?.tickSize}
                closed={closed}
                positions={positions.data ?? []}
                tag={frames.length > 1}
                onChartReady={(c) => register(tf, c)}
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
            ))}
          </div>
          <div className="scalp-legend">
            <span>
              <i className="lg lg-mark-e" /> E = opened a trade
            </span>
            <span>
              <i className="lg lg-mark-x" /> × = refused by a rule
            </span>
            <span>
              <i className="lg lg-box-win" /> <i className="lg lg-box-loss" /> account trades, won / lost · dashed = stop · dotted = targets
            </span>
            <span>click a mark for the decision</span>
          </div>
        </section>

        <aside className="scalp-panel scalp-tape" aria-label="Signal tape">
          <div className="scalp-head">
            <h2>
              Signal tape <i className="scalp-dot on live" aria-hidden />
            </h2>
            <div className="scalp-seg" role="group" aria-label="Tape filter">
              <button aria-pressed={tapeOnly === 'all'} onClick={() => setTapeOnly('all')}>
                All
              </button>
              <button aria-pressed={tapeOnly === 'opened'} onClick={() => setTapeOnly('opened')}>
                Opened
              </button>
            </div>
          </div>
          <div className="scalp-scroll">
            {tape.isLoading && <Loading kind="cards" rows={5} />}
            {tape.isError && <ErrorState error={tape.error} onRetry={() => tape.refetch()} />}
            {!tape.isLoading && !tapeRows.length && <p className="terminal-empty">No entry signals yet.</p>}
            {tapeRows.slice(0, 80).map((s) => {
              const g = gateOf(s.action)
              return (
                <button
                  key={s.id}
                  className={`scalp-tick side-${s.side} ${s.action === 'opened' ? 'opened' : ''}`}
                  onClick={() => update({ symbol: s.symbol, tf: s.tf })}
                  title={`${s.scannerName}\n${s.label}\n${s.action}`}
                >
                  <span className={`scalp-side ${s.side === 'long' ? 'gain' : 'loss'}`}>
                    {s.side === 'long' ? '▲' : '▼'}
                  </span>
                  <span className="scalp-tick-main">
                    <b>
                      {short(s.symbol)} <small>{s.tf}</small>
                    </b>
                    <small>{s.scannerName}</small>
                  </span>
                  <span className="scalp-tick-end">
                    <Pill tone={g.tone}>{g.label}</Pill>
                    <small className="mono">{timeAgo(s.at, now)}</small>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="scalp-panel scalp-dock">
          <div className="scalp-head">
            <div className="scalp-seg" role="tablist" aria-label="Dock">
              <button role="tab" aria-selected={dock === 'positions'} aria-pressed={dock === 'positions'} onClick={() => setDock('positions')}>
                Positions <small>{positions.data?.length ?? 0}</small>
              </button>
              <button role="tab" aria-selected={dock === 'stats'} aria-pressed={dock === 'stats'} onClick={() => setDock('stats')}>
                Scanner stats
              </button>
              <button role="tab" aria-selected={dock === 'funnel'} aria-pressed={dock === 'funnel'} onClick={() => setDock('funnel')}>
                Signal funnel · 24h
              </button>
              <button role="tab" aria-selected={dock === 'rules'} aria-pressed={dock === 'rules'} onClick={() => setDock('rules')}>
                Rules in force
              </button>
            </div>
            <div className="scalp-dock-links">
              <Link to="/trades">Journal ↗</Link>
              <Link to="/">Trading overview ↗</Link>
            </div>
          </div>
          <div className="scalp-dock-body trading">
            {dock === 'positions' && <PaperPositions query={positions} compact />}
            {dock === 'stats' && <ScannerCellStats symbol={symbol} cells={bot.cells} closed={closed} names={nameOf} />}
            {dock === 'funnel' && (overview.data ? <Funnel o={overview.data} /> : <Loading kind="cards" rows={3} />)}
            {dock === 'rules' && (overview.data ? <Rules o={overview.data} /> : <Loading kind="cards" rows={3} />)}
          </div>
        </section>
      </div>

    </div>
  )
}
