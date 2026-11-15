import { useRef, useState } from 'react'
import type { TradeMonitorView } from '../api/tradeMonitor'
import { heatLabel, heatValue, type HeatMetric } from '../lib/monitorHeatmap'
import { useMediaQuery } from '../lib/useMediaQuery'
import { usePagination } from '../lib/usePagination'
import { Pagination } from './kit/Pagination'

type Pair = TradeMonitorView['pairs'][number]

/** One compact, keyboard-operated grid and one detail panel instead of a card per market. */
export function PairHeatmap({
  pairs,
  metric,
  selected,
  onSelect,
  now,
  stale,
}: {
  pairs: Pair[]
  metric: HeatMetric
  selected: string
  onSelect: (symbol: string) => void
  now: number
  stale: boolean
}) {
  const mobile = useMediaQuery('(max-width: 640px)')
  const columns = mobile ? 3 : 8
  const paging = usePagination(pairs.length, 48, pairs.map((p) => p.symbol).join('|'))
  const visible = pairs.slice(paging.start, paging.end)
  const [focus, setFocus] = useState(0)
  const refs = useRef<Array<SVGGElement | null>>([])
  const active = pairs.find((p) => p.symbol === selected)
  const rowCount = Math.ceil(visible.length / columns)
  const move = (event: React.KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'ArrowDown'
            ? index + columns
            : event.key === 'ArrowUp'
              ? index - columns
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? visible.length - 1
                  : null
    if (next !== null) {
      event.preventDefault()
      const target = Math.max(0, Math.min(visible.length - 1, next))
      setFocus(target)
      refs.current[target]?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(visible[index].symbol === selected ? '' : visible[index].symbol)
    }
  }
  return (
    <div className="pair-heatmap">
      <svg
        className="pair-grid"
        viewBox={`0 0 ${columns * 120} ${Math.max(1, rowCount) * 58}`}
        role="grid"
        aria-label="Pair heatmap"
        aria-rowcount={rowCount}
        aria-colcount={columns}
      >
        {Array.from({ length: rowCount }, (_, row) => (
          <g role="row" key={row} aria-rowindex={row + 1}>
            {visible.slice(row * columns, (row + 1) * columns).map((pair, col) => {
              const index = row * columns + col,
                value = heatValue(pair, metric)
              const label =
                value === null && (metric === 'paper' || metric === 'shadow')
                  ? 'No closes'
                  : heatLabel(value, metric)
              return (
                <g
                  key={pair.symbol}
                  ref={(el) => {
                    refs.current[index] = el
                  }}
                  role="gridcell"
                  aria-colindex={col + 1}
                  tabIndex={index === Math.min(focus, visible.length - 1) ? 0 : -1}
                  aria-selected={pair.symbol === selected}
                  aria-label={`${pair.symbol}: ${label}. ${pair.active ? 'Observed' : 'Not observed'}`}
                  className={`pair-cell ${value === null ? 'missing' : value < 0 ? 'negative' : value > 0 ? 'positive' : ''} ${pair.symbol === selected ? 'selected' : ''}`}
                  transform={`translate(${col * 120},${row * 58})`}
                  onFocus={() => setFocus(index)}
                  onKeyDown={(event) => move(event, index)}
                  onClick={() => onSelect(pair.symbol === selected ? '' : pair.symbol)}
                >
                  <rect x="3" y="3" width="114" height="52" rx="6" />
                  <text x="12" y="24" className="pair-symbol">
                    {pair.symbol.replace(/USD$/, '')}
                  </text>
                  <text x="12" y="44" className="pair-value">
                    {label}
                  </text>
                </g>
              )
            })}
          </g>
        ))}
      </svg>
      {active && (
        <aside className="pair-inspector" aria-label={`${active.symbol} details`}>
          <div className="row spread">
            <strong>{active.symbol}</strong>
            <button type="button" className="btn btn-sm" onClick={() => onSelect('')}>
              Clear selection
            </button>
          </div>
          <p>
            {active.paperOpen} paper · {active.shadowOpen} shadow · {active.researchOpen} research open
            positions
          </p>
          <p>
            Flow: {active.flow?.covered && !stale ? 'complete five-minute coverage' : 'incomplete or stale'} ·
            Depth:{' '}
            {active.depthFresh && active.depthAt !== null && now - active.depthAt <= 10000 && !stale
              ? 'fresh'
              : 'unavailable or stale'}
          </p>
        </aside>
      )}
      {pairs.length > 48 && (
        <Pagination {...paging} total={pairs.length} onChange={paging.setPage} label="Pairs" />
      )}
    </div>
  )
}
