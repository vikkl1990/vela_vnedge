import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCandles, useConfig, useHealth, useMarkets, usePositions, useRisk, useSignals, useStats } from '../api/queries'
import { MarketCanvas } from '../components/MarketCanvas'
import { PositionsTable } from '../components/PositionsTable'
import { ErrorState, Loading, Panel, Pill, Time } from '../components/ui'
import { fmtMoney, fmtPct, fmtPnl, fmtPrice, pnlClass } from '../lib/format'
import { gateOf } from '../lib/signalOutcomes'
import { inHorizon, openCapital, workspaceSignals, type TradingHorizon } from '../lib/workspace'
import { useLiveTick } from '../sse/prices'
import { patchSearch } from '../lib/researchNavigation'

function MarketPrice({ symbol, fallback, tickSize }: { symbol: string; fallback?: number; tickSize?: number }) {
  const tick = useLiveTick(symbol, fallback)
  return <span className={`terminal-price mono ${tick.stale ? 'price-stale' : ''}`} title={tick.stale ? 'Last known price; live tick is stale or unavailable' : 'Latest trade price'}>{tick.price == null ? '—' : fmtPrice(tick.price, tickSize)}<small>{tick.stale ? 'Last known' : 'Live price'}</small></span>
}

export function Terminal() {
  const [search, setSearch] = useSearchParams()
  const horizon: TradingHorizon = search.get('horizon') === 'scalp' ? 'scalp' : search.get('horizon') === 'swing' ? 'swing' : 'all'
  const symbol = search.get('symbol') || 'BTCUSD'
  const requestedFrame = search.get('tf')
  const frame = requestedFrame && ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '1d'].includes(requestedFrame) ? requestedFrame : (horizon === 'swing' ? '1h' : '15m')
  const [filter, setFilter] = useState('')
  const markets = useMarkets(), positions = usePositions(), stats = useStats(), risk = useRisk(), config = useConfig(), health = useHealth()
  const signals = useSignals({ kind: 'entry', limit: 100 })
  const candles = useCandles(symbol, frame, 120)
  const paper = config.data?.paper as (NonNullable<typeof config.data>['paper'] & { marginPerTrade?: number; maxStopLossPct?: number }) | undefined
  const capital = useMemo(() => openCapital(positions.data ?? []), [positions.data])
  const visiblePositions = (positions.data ?? []).filter(p => inHorizon(p.tf, horizon))
  const visibleSignals = workspaceSignals(signals.data ?? [], horizon)
  const marketRows = (markets.data ?? []).filter(m => !filter || `${m.symbol} ${m.description}`.toLowerCase().includes(filter.toLowerCase()))
  const selected = markets.data?.find(m => m.symbol === symbol)
  const update = (changes: Record<string, string | null>) => setSearch(patchSearch(search, changes))
  const changeHorizon = (h: TradingHorizon) => update({ horizon: h === 'all' ? null : h, tf: h === 'swing' ? '1h' : '15m' })
  const s = stats.data
  return <div className="page terminal-page">
    <div className="terminal-heading"><div><div className="eyebrow">VN EDGE / TRADING WORKSPACE</div><h1>Precision in every decision<span className="accent">.</span></h1><p>Market data → confirmed signal → executable entry → managed exit.</p></div><div className="terminal-mode"><Pill tone={health.data?.mode === 'paper' ? 'accent' : 'warn'}>{health.data ? `${health.data.mode.toUpperCase()} ACCOUNT` : 'MODE LOADING'}</Pill><Link to="/incubator?section=plans">Shadow research ↗</Link></div></div>
    <div className="terminal-account-strip">
      <div><span>Account equity</span><strong className="mono">{s ? `$${fmtMoney(s.equity)}` : '—'}</strong><small>Starting purse {paper ? `$${fmtMoney(paper.initialEquity, 0)}` : '—'}</small></div>
      <div><span>Today · UTC</span><strong className={`mono ${pnlClass(risk.data?.day?.pnl)}`}>{risk.data?.day ? `$${fmtPnl(risk.data.day.pnl)}` : '—'}</strong><small>Equity change, including open P&L</small></div>
      <div><span>Open margin</span><strong className="mono">{positions.data ? `$${fmtMoney(capital.margin)}${capital.unknown ? ' + unknown' : ''}` : '—'}</strong><small>Open positions only; pending excluded</small></div>
      <div><span>Initial stop risk</span><strong className="mono">{positions.data ? `$${fmtMoney(capital.risk)}` : '—'}</strong><small>Combined opening budgets; not current stops</small></div>
      <div><span>Open positions</span><strong className="mono">{positions.data?.length ?? '—'}<em> / {config.data?.risk?.maxPositionsTotal ?? '—'}</em></strong><small>One shared account across horizons</small></div>
    </div>
    <div className="terminal-viewbar"><div className="terminal-segments" aria-label="Trading horizon">{(['all', 'scalp', 'swing'] as const).map(h => <button key={h} className={horizon === h ? 'on' : ''} aria-pressed={horizon === h} onClick={() => changeHorizon(h)}>{h === 'all' ? 'All strategies' : h === 'scalp' ? 'Scalp' : 'Swing'}<small>{h === 'all' ? 'Portfolio' : h === 'scalp' ? 'Below 1h' : '1h and above'}</small></button>)}</div><span className="muted small">View filters only · no reserved quotas</span><Link className="btn btn-sm" to="/overview">Operations & performance ↗</Link></div>
    <div className="terminal-grid">
      <section className="terminal-panel terminal-watchlist" aria-label="Market watchlist"><div className="terminal-panel-title"><h2>Markets</h2><span>{markets.data?.length ?? '—'}</span></div><label className="terminal-search"><span className="sr-only">Search markets</span><input placeholder="Search any pair…" value={filter} onChange={e => setFilter(e.target.value)} /></label><div className="watchlist-columns"><span>Contract</span><span>Price / 24h</span></div><div className="watchlist-scroll">
        {markets.isLoading && <Loading kind="cards" rows={4} />}{markets.isError && <ErrorState error={markets.error} onRetry={() => markets.refetch()} />}
        {!markets.isLoading && !markets.isError && !marketRows.length && <p className="terminal-empty">No matching markets.</p>}
        {marketRows.map(m => <button key={m.symbol} aria-pressed={symbol === m.symbol} className={`market-row ${symbol === m.symbol ? 'selected' : ''}`} onClick={() => update({ symbol: m.symbol })}><span><b>{m.symbol.replace(/USD$/, '')}<small> / USD</small></b><small>{(positions.data ?? []).some(p => p.symbol === m.symbol) ? '● Position open' : 'Perpetual'}</small></span><span className="mono"><b>{fmtPrice(m.markPrice, m.tickSize)}</b><small className={pnlClass(m.change24hPct)}>{m.change24hPct > 0 ? '+' : ''}{fmtPct(m.change24hPct)}</small></span></button>)}
      </div><Link className="terminal-panel-footer" to="/radar">Signal coverage across markets →</Link></section>
      <section className="terminal-panel terminal-chart" aria-label="Price workspace"><div className="terminal-market-header"><div><h2>{symbol.replace(/USD$/, '')}<span> / USD</span><Pill tone="muted">PERPETUAL</Pill></h2><span className="muted small">Delta Exchange India</span></div><MarketPrice symbol={symbol} fallback={selected?.markPrice} tickSize={selected?.tickSize} /></div><div className="terminal-chart-tools"><div role="group" aria-label="Chart timeframe">{['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => <button key={tf} aria-pressed={frame === tf} className={frame === tf ? 'on' : ''} onClick={() => update({ tf })}>{tf}</button>)}</div><Link to={`/chart?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(frame)}`}>Full chart ↗</Link></div>
        {candles.isLoading && !candles.data ? <Loading kind="chart" height={340} /> : candles.isError ? <ErrorState error={candles.error} onRetry={() => candles.refetch()} /> : <MarketCanvas bars={candles.data ?? []} positions={(positions.data ?? []).filter(p => p.symbol === symbol && p.tf === frame)} symbol={symbol} tickSize={selected?.tickSize} />}
        <div className="terminal-chart-caption"><span>Price candles · {frame} · held entries, SL and allocated TP levels</span><span>Simulated fills are recorded in the journal</span></div>
      </section>
      <aside className="terminal-panel terminal-capital"><div className="terminal-panel-title"><h2>Execution policy</h2><span>Current</span></div><div className="capital-head"><span className="muted small">Margin sizing</span><strong>{paper ? paper.sizingMode === 'margin' ? `$${fmtMoney(paper.marginPerTrade ?? 0, 0)}` : `${paper.riskPerTradePct}%` : '—'}</strong><span className="small muted">{paper?.sizingMode === 'margin' ? 'configured allocation before risk scaling' : 'configured risk sizing'}</span></div><dl className="terminal-facts"><div><dt>Stop-risk ceiling</dt><dd>{paper?.maxStopLossPct ?? '—'}% of equity</dd></div><div><dt>Leverage ceiling</dt><dd>{paper?.maxLeverage ?? '—'}×</dd></div><div><dt>Entry state</dt><dd className={risk.data?.halted ? 'warn' : ''}>{!risk.data ? 'Loading' : risk.data.halted ? 'Paused' : 'Evaluating signals'}</dd></div><div><dt>Exit management</dt><dd>Per held policy</dd></div></dl><p className="terminal-policy-note">Margin funds exposure. The stop and execution costs determine risk. Targets shown on each position belong to that trade.</p><Link className="btn btn-sm" to="/settings">Sizing & risk settings →</Link><Link className="terminal-secondary-link" to="/monitor">Inspect open-trade health ↗</Link><div className="terminal-lab-note"><span className="eyebrow">RESEARCH IS SEPARATE</span><p>New readers, flexible sizing and target variants need their own results before account admission.</p><Link to="/incubator?section=plans">View shadow experiments →</Link></div></aside>
    </div>
    <div className="terminal-bottom-grid"><Panel title={<span>Positions <span className="muted">/ {horizon === 'all' ? 'all horizons' : horizon}</span></span>} right={<Link className="btn btn-xs" to="/trades">Journal ↗</Link>} pad={false}>{positions.isLoading ? <Loading kind="table" rows={2} cols={7} /> : positions.isError ? <ErrorState error={positions.error} onRetry={() => positions.refetch()} /> : <PositionsTable positions={visiblePositions} compact />}</Panel>
      <section className="terminal-panel terminal-setups"><div className="terminal-panel-title"><h2>Signal → execution</h2><Link to="/signals">All signals ↗</Link></div><p className="terminal-list-note">Latest {signals.data?.length ?? 0} recorded entry events · {horizon} view. A signal is not a fill.</p><div className="terminal-setup-scroll">{signals.isLoading ? <Loading kind="cards" rows={3} /> : signals.isError ? <ErrorState error={signals.error} onRetry={() => signals.refetch()} /> : visibleSignals.length === 0 ? <p className="terminal-empty">No matching entry events in this recent sample. <Link to="/scanners">Inspect scanner coverage →</Link></p> : visibleSignals.slice(0, 16).map(event => {
        const outcome = gateOf(event.action)
        return <div className="terminal-setup" key={event.id}><div><button className="terminal-symbol-link" onClick={() => update({ symbol: event.symbol, tf: event.tf })}>{event.symbol} <small>{event.tf}</small></button><span className={event.side === 'long' ? 'gain' : 'loss'}>{event.side?.toUpperCase() ?? '—'}</span></div><Link className="terminal-scanner-name" to={`/scanners/${encodeURIComponent(event.scannerId)}`}>{event.scannerName}</Link><div><span title={event.action}><Pill tone={outcome.tone}>{outcome.label}</Pill></span><Time t={event.at} mode="ago" /></div></div>
      })}</div></section></div>
  </div>
}
