import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'

interface Props<T> {
  items: T[]
  /** Fixed height of the scroll container. */
  height: number | string
  /** Row height in px — a number for uniform rows, or a function for known per-row heights. */
  itemHeight: number | ((item: T, index: number) => number)
  render: (item: T, index: number) => ReactNode
  itemKey: (item: T, index: number) => string | number
  overscan?: number
  className?: string
  /** Called with the scroll element on mount (for auto-scroll). */
  scrollRef?: (el: HTMLDivElement | null) => void
  onScroll?: (e: UIEvent<HTMLDivElement>) => void
  /** Rendered when there are no items. */
  empty?: ReactNode
}

/**
 * Minimal windowed list: renders only the rows intersecting the viewport (plus
 * overscan) using top/bottom spacers. No measurement — heights must be known,
 * which keeps it cheap and jitter-free.
 */
export function WindowedList<T>({ items, height, itemHeight, render, itemKey, overscan = 8, className = '', scrollRef, onScroll, empty }: Props<T>) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const elRef = useRef<HTMLDivElement | null>(null)

  const setEl = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el
      scrollRef?.(el)
    },
    [scrollRef],
  )

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    const update = () => setViewport(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Prefix sums of row heights (uniform case is O(1) without them).
  const uniform = typeof itemHeight === 'number'
  const offsets = useMemo(() => {
    if (uniform) return null
    const fn = itemHeight as (item: T, index: number) => number
    const out = new Float64Array(items.length + 1)
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + fn(items[i], i)
    return out
  }, [items, itemHeight, uniform])

  const total = uniform ? items.length * (itemHeight as number) : (offsets?.[items.length] ?? 0)

  let start = 0
  let end = items.length
  if (uniform) {
    const h = itemHeight as number
    start = Math.max(0, Math.floor(scrollTop / h) - overscan)
    end = Math.min(items.length, Math.ceil((scrollTop + viewport) / h) + overscan)
  } else if (offsets) {
    // binary search first row whose bottom > scrollTop
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    start = Math.max(0, lo - overscan)
    let e = lo
    const limit = scrollTop + viewport
    while (e < items.length && offsets[e] < limit) e++
    end = Math.min(items.length, e + overscan)
  }
  const topPad = uniform ? start * (itemHeight as number) : (offsets?.[start] ?? 0)
  const bottomPad = Math.max(0, total - (uniform ? end * (itemHeight as number) : (offsets?.[end] ?? 0)))

  return (
    <div
      ref={setEl}
      className={`windowed ${className}`}
      style={{ height, overflow: 'auto', position: 'relative' }}
      onScroll={(e) => {
        setScrollTop(e.currentTarget.scrollTop)
        onScroll?.(e)
      }}
    >
      {items.length === 0 && empty}
      {topPad > 0 && <div style={{ height: topPad }} aria-hidden />}
      {items.slice(start, end).map((it, i) => (
        <div key={itemKey(it, start + i)} style={uniform ? { height: itemHeight as number } : undefined}>
          {render(it, start + i)}
        </div>
      ))}
      {bottomPad > 0 && <div style={{ height: bottomPad }} aria-hidden />}
    </div>
  )
}
