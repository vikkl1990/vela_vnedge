import type { CSSProperties } from 'react'

/** Loading skeletons (no spinners). All respect prefers-reduced-motion via CSS. */

export function Skeleton({ w = '100%', h = 12, className = '', style }: { w?: number | string; h?: number | string; className?: string; style?: CSSProperties }) {
  return <span className={`sk ${className}`} style={{ width: w, height: h, ...style }} aria-hidden />
}

/** A few text lines of varying width. */
export function SkeletonLines({ lines = 3, pad = true }: { lines?: number; pad?: boolean }) {
  const widths = ['92%', '70%', '84%', '60%', '76%', '48%']
  return (
    <div className={`sk-stack ${pad ? 'pad' : ''}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={widths[i % widths.length]} h={11} />
      ))}
    </div>
  )
}

/** Table-shaped skeleton: header row + N body rows. */
export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="sk-table" aria-busy="true" aria-label="Loading table">
      <div className="sk-row sk-head">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} h={8} w={i === 0 ? '60%' : '45%'} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} h={11} w={c === 0 ? '75%' : `${40 + ((r * 7 + c * 13) % 40)}%`} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** KPI tiles skeleton. */
export function KpiSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="kpi-grid" aria-busy="true" aria-label="Loading metrics">
      {Array.from({ length: count }, (_, i) => (
        <div className="kpi" key={i}>
          <Skeleton w="50%" h={8} />
          <Skeleton w="70%" h={20} style={{ marginTop: 8 }} />
          <Skeleton w="40%" h={9} style={{ marginTop: 6 }} />
        </div>
      ))}
    </div>
  )
}

/** Chart-area skeleton with a faux baseline. */
export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="sk-chart" style={{ height }} aria-busy="true" aria-label="Loading chart">
      <Skeleton w="100%" h="100%" />
    </div>
  )
}

/** Card list (alerts feed) skeleton. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="sk-stack pad" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <Skeleton w="40%" h={11} />
          <Skeleton w="85%" h={9} style={{ marginTop: 6 }} />
          <Skeleton w="60%" h={9} style={{ marginTop: 4 }} />
        </div>
      ))}
    </div>
  )
}
