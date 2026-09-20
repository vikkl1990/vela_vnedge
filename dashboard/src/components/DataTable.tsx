import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  /** Accessor used for sorting (and default rendering). */
  value?: (row: T) => string | number | null | undefined | boolean
  render?: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  width?: string | number
  sortable?: boolean
  className?: string
  /** Right-aligned mono numeric cell (implies align: 'right'). */
  numeric?: boolean
  /** Column `title` tooltip on the header. */
  title?: string
}

export type SortDir = 'asc' | 'desc'
export interface SortState {
  key: string
  dir: SortDir
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  defaultSort?: SortState
  rowClass?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  dense?: boolean
  emptyLabel?: ReactNode
  maxHeight?: number | string
  stickyHeader?: boolean
  /** Window rows when the list is longer than this (default 300). Requires a bounded height. */
  virtualizeAfter?: number
  /** Fixed row height (px) used when windowing. */
  rowHeight?: number
  /** Accessible table caption (visually hidden). */
  caption?: string
}

const DEFAULT_VIRTUAL_HEIGHT = 560

function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | null): T[] {
  if (!sort) return rows
  const col = columns.find((c) => c.key === sort.key)
  if (!col?.value) return rows
  const v = col.value
  const dir = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const av = v(a.r)
      const bv = v(b.r)
      if (av == null && bv == null) return a.i - b.i
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir || a.i - b.i
      if (typeof av === 'boolean' && typeof bv === 'boolean') return (Number(av) - Number(bv)) * dir || a.i - b.i
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir || a.i - b.i
    })
    .map((x) => x.r)
}

// ---------- memoized row ----------

interface RowProps<T> {
  row: T
  columns: Column<T>[]
  className: string
  onRowClick?: (row: T) => void
  height?: number
}

function RowInner<T>({ row, columns, className, onRowClick, height }: RowProps<T>) {
  return (
    <tr
      className={className}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      style={height ? { height } : undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onKeyDown={
        onRowClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onRowClick(row)
              }
            }
          : undefined
      }
    >
      {columns.map((c) => (
        <td key={c.key} className={cellClass(c)}>
          {c.render ? c.render(row) : String(c.value?.(row) ?? '')}
        </td>
      ))}
    </tr>
  )
}
// React.memo drops the generic; cast it back so callers keep type inference.
const Row = memo(RowInner) as typeof RowInner

function cellClass<T>(c: Column<T>): string {
  const align = c.numeric ? 'right' : (c.align ?? 'left')
  return `${c.numeric ? 'num' : ''} ${align === 'right' ? 'ta-r' : align === 'center' ? 'ta-c' : ''} ${c.className ?? ''}`.trim()
}

// ---------- table ----------

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  rowClass,
  onRowClick,
  dense = true,
  emptyLabel = 'No rows',
  maxHeight,
  stickyHeader = true,
  virtualizeAfter = 300,
  rowHeight = 38,
  caption,
}: Props<T>) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null)
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, sort, columns])

  const toggleSort = useCallback((c: Column<T>) => {
    if (c.sortable === false || !c.value) return
    setSort((s) => {
      const firstDir: SortDir = c.numeric || c.align === 'right' ? 'desc' : 'asc'
      if (!s || s.key !== c.key) return { key: c.key, dir: firstDir }
      if (s.dir === firstDir) return { key: c.key, dir: firstDir === 'asc' ? 'desc' : 'asc' }
      return null
    })
  }, [])

  // ---- column-width ratchet: header cells never shrink while data updates ----
  const theadRef = useRef<HTMLTableRowElement>(null)
  const widthsRef = useRef<Map<string, number>>(new Map())
  const colSig = columns.map((c) => c.key).join('|')
  useEffect(() => {
    // new column set or viewport change → forget locked widths
    widthsRef.current = new Map()
    const onResize = () => {
      widthsRef.current = new Map()
      theadRef.current?.querySelectorAll<HTMLTableCellElement>('th').forEach((th) => (th.style.minWidth = ''))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [colSig])
  useLayoutEffect(() => {
    const tr = theadRef.current
    if (!tr) return
    tr.querySelectorAll<HTMLTableCellElement>('th[data-key]').forEach((th) => {
      const k = th.dataset.key!
      const w = th.getBoundingClientRect().width
      const prev = widthsRef.current.get(k) ?? 0
      if (w > prev + 0.5) {
        widthsRef.current.set(k, w)
        th.style.minWidth = `${Math.ceil(w)}px`
      }
    })
  })

  // ---- windowing ----
  const virtual = sorted.length > virtualizeAfter
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el || !virtual) return
    const update = () => setViewport(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [virtual])

  let start = 0
  let end = sorted.length
  if (virtual) {
    const overscan = 10
    start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    end = Math.min(sorted.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  }
  const topPad = start * rowHeight
  const bottomPad = Math.max(0, (sorted.length - end) * rowHeight)
  const visible = virtual ? sorted.slice(start, end) : sorted

  const wrapStyle: CSSProperties | undefined =
    maxHeight || virtual ? { maxHeight: maxHeight ?? DEFAULT_VIRTUAL_HEIGHT, overflow: 'auto' } : undefined

  return (
    <div
      className="table-wrap"
      style={wrapStyle}
      ref={wrapRef}
      onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <table className={`table ${dense ? 'table-dense' : ''} ${virtual ? 'table-virtual' : ''}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className={stickyHeader ? 'sticky' : ''}>
          <tr ref={theadRef}>
            {columns.map((c) => {
              const sortable = c.sortable !== false && !!c.value
              const active = sort?.key === c.key
              const align = c.numeric ? 'right' : (c.align ?? 'left')
              return (
                <th
                  key={c.key}
                  data-key={c.key}
                  scope="col"
                  style={{ width: c.width }}
                  className={`${sortable ? 'sortable' : ''} ${active ? 'sorted' : ''} ${align === 'right' ? 'ta-r' : align === 'center' ? 'ta-c' : ''} ${c.className ?? ''}`}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}
                  title={c.title}
                >
                  {sortable ? (
                    <button type="button" className="th-btn" onClick={() => toggleSort(c)}>
                      <span>{c.header}</span>
                      <span className={`sort-ind ${active ? 'sort-on' : ''}`} aria-hidden>
                        {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr className="row-empty">
              <td colSpan={columns.length} className="muted center">
                {emptyLabel}
              </td>
            </tr>
          )}
          {virtual && topPad > 0 && (
            <tr aria-hidden className="row-spacer">
              <td colSpan={columns.length} style={{ height: topPad, padding: 0, border: 0 }} />
            </tr>
          )}
          {visible.map((r) => (
            <Row
              key={rowKey(r)}
              row={r}
              columns={columns}
              className={`${rowClass?.(r) ?? ''} ${onRowClick ? 'clickable' : ''}`.trim()}
              onRowClick={onRowClick}
              height={virtual ? rowHeight : undefined}
            />
          ))}
          {virtual && bottomPad > 0 && (
            <tr aria-hidden className="row-spacer">
              <td colSpan={columns.length} style={{ height: bottomPad, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
