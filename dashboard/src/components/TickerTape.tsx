import { useMarkets } from '../api/queries'
import { fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { useSSE } from '../sse/SSEProvider'

/** Auto-scrolling marquee of markets (symbol · mark price · 24h %). */
export function TickerTape() {
  const { data, isError } = useMarkets()
  const { lastPrice } = useSSE()
  if (isError || !data || data.length === 0) {
    return (
      <div className="tape tape-empty muted small mono">{isError ? 'markets unavailable' : 'loading markets…'}</div>
    )
  }
  const items = data.map((m) => {
    const live = lastPrice[m.symbol]?.price
    const price = live ?? m.markPrice
    return (
      <span className="tape-item" key={m.symbol}>
        <span className={`dot ${m.change24hPct >= 0 ? 'dot-ok' : 'dot-danger'}`} />
        <span className="tape-sym">{m.symbol}</span>
        <span className="mono">{fmtPrice(price, m.tickSize)}</span>
        <span className={`mono ${pnlClass(m.change24hPct)}`}>{fmtPct(m.change24hPct, 2, true)}</span>
      </span>
    )
  })
  return (
    <div className="tape" aria-label="Market ticker">
      <div className="tape-track">
        <div className="tape-group">{items}</div>
        <div className="tape-group" aria-hidden>
          {items}
        </div>
      </div>
    </div>
  )
}
