import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useConfig, useMarkets, usePositions, useRisk, useStats } from '../api/queries'
import type { Signal } from '../api/types'
import { MarketCanvas, type CanvasMarker } from '../components/MarketCanvas'
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
    const on = Object.values(config.data?.scanners ?? {}).filter((s) => s.enabled)
    const symbols = [...new Set(on.flatMap((s) => s.symbols ?? config.data?.symbols ?? []))]
    const tfs = [...new Set(on.flatMap((s) => s.timeframes ?? []))]
    return { symbols, tfs }
  }, [config.data])
  const symbol = search.get('symbol') || bot.symbols[0] || 'BTCUSD'
  const reqTf = search.get('tf')
  const frame = reqTf && (FRAMES as readonly string[]).includes(reqTf) ? reqTf : bot.tfs[0] ?? '15m'
  const [scope, setScope] = useState<'bot' | 'all'>('bot')
  const [filter, setFilter] = useState('')
  const [tapeOnly, setTapeOnly] = useState<'all' | 'opened'>('all')
  const [dock, setDock] = useState<'positions' | 'funnel' | 'rules'>('positions')

  const tape = useQuery({
    queryKey: ['scalp-tape'],
    queryFn: () => api.signals({ kind: 'entry', limit: 150 }),
    refetchInterval: 5_000,
    staleTime: 4_000,
  })
  const chartSignals = useQuery({
    queryKey: ['scalp-chart-signals', symbol, frame],
    queryFn: () => api.signals({ kind: 'entry', symbol, tf: frame, limit: 300 }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  })
  const candles = useQuery({
    queryKey: ['scalp-candles', symbol, frame],
    queryFn: () => api.candles({ symbol, tf: frame, limit: 160 }),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 1,
  })
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
  const markers: CanvasMarker[] = (chartSignals.data ?? [])
    .filter((s) => s.side === 'long' || s.side === 'short')
    .map((s) => ({
      time: s.barTime,
      side: s.side as 'long' | 'short',
      opened: s.action === 'opened' || s.action === 'reversed',
      title: `${s.scannerName}: ${s.side} ${s.label} → ${gateOf(s.action).label}`,
    }))
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
              <Link className="scalp-link" to={`/chart?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(frame)}`}>
                Full chart ↗
              </Link>
            </div>
          </div>
          <div className="scalp-canvas">
            {candles.isLoading && !candles.data ? (
              <Loading kind="chart" height={420} />
            ) : candles.isError ? (
              <ErrorState error={candles.error} onRetry={() => candles.refetch()} />
            ) : (
              <MarketCanvas
                bars={candles.data ?? []}
                positions={(positions.data ?? []).filter((p) => p.symbol === symbol && p.tf === frame)}
                symbol={symbol}
                tickSize={selected?.tickSize}
                markers={markers}
                height={470}
                candles={140}
              />
            )}
          </div>
          <div className="scalp-legend">
            <span>
              <i className="lg lg-long" /> long signal
            </span>
            <span>
              <i className="lg lg-short" /> short signal
            </span>
            <span>filled = opened · hollow = refused by a rule</span>
            <span>dashed = open trade's entry, stop and targets</span>
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
                  className={`scalp-tick ${s.action === 'opened' ? 'opened' : ''}`}
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
      </div>

      <section className="scalp-panel scalp-dock">
        <div className="scalp-head">
          <div className="scalp-seg" role="tablist" aria-label="Dock">
            <button role="tab" aria-selected={dock === 'positions'} aria-pressed={dock === 'positions'} onClick={() => setDock('positions')}>
              Positions <small>{positions.data?.length ?? 0}</small>
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
          {dock === 'funnel' && (overview.data ? <Funnel o={overview.data} /> : <Loading kind="cards" rows={3} />)}
          {dock === 'rules' && (overview.data ? <Rules o={overview.data} /> : <Loading kind="cards" rows={3} />)}
        </div>
      </section>
    </div>
  )
}
