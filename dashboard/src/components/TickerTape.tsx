import { memo } from 'react'
import { useMarkets } from '../api/queries'
import type { Market } from '../api/types'
import { fmtPct, fmtPrice, pnlClass } from '../lib/format'
import { useLivePrice } from '../sse/prices'
import { Skeleton } from './Skeleton'

/** One market; subscribes to its own ticks so the tape never re-renders as a whole. */
const TapeItem = memo(function TapeItem({ m }: { m: Market }) {
  const live = useLivePrice(m.symbol, m.markPrice)
  return (
    <span className="tape-item">
      <span className={`dot ${m.change24hPct >= 0 ? 'dot-ok' : 'dot-danger'}`} />
      <span className="tape-sym">{m.symbol}</span>
      <span className="mono">{fmtPrice(live ?? m.markPrice, m.tickSize)}</span>
      <span className={`mono ${pnlClass(m.change24hPct)}`}>{fmtPct(m.change24hPct, 1, true)}</span>
    </span>
  )
})

/** Auto-scrolling marquee of markets (symbol · mark price · 24h %). Pauses under prefers-reduced-motion. */
export function TickerTape() {
  const { data, isError, isLoading } = useMarkets()
  if (isLoading && !data) {
    return (
      <div className="tape tape-empty" aria-busy="true">
        <Skeleton w="60%" h={11} />
      </div>
    )
  }
  if (isError || !data || data.length === 0) {
    return <div className="tape tape-empty muted small mono">{isError ? 'markets unavailable' : 'no markets'}</div>
  }
  const items = data.map((m) => <TapeItem key={m.symbol} m={m} />)
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
