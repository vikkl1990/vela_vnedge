import { useMemo, useState, type ReactNode } from 'react'

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
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  rowClass?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  dense?: boolean
  emptyLabel?: string
  maxHeight?: number | string
  stickyHeader?: boolean
}

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
}: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null)

  const sorted = useMemo(() => {
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
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir || a.i - b.i
      })
      .map((x) => x.r)
  }, [rows, sort, columns])

  const toggleSort = (c: Column<T>) => {
    if (c.sortable === false || !c.value) return
    setSort((s) => {
      if (!s || s.key !== c.key) return { key: c.key, dir: c.align === 'right' ? 'desc' : 'asc' }
      if (s.dir === 'asc') return { key: c.key, dir: 'desc' }
      return null
    })
  }

  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
      <table className={`table ${dense ? 'table-dense' : ''}`}>
        <thead className={stickyHeader ? 'sticky' : ''}>
          <tr>
            {columns.map((c) => {
              const sortable = c.sortable !== false && !!c.value
              const active = sort?.key === c.key
              return (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: c.align ?? 'left' }}
                  className={`${sortable ? 'sortable' : ''} ${active ? 'sorted' : ''} ${c.className ?? ''}`}
                  onClick={() => toggleSort(c)}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  scope="col"
                >
                  {c.header}
                  {active && <span className="sort-ind">{sort!.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="muted center">
                {emptyLabel}
              </td>
            </tr>
          )}
          {sorted.map((r) => (
            <tr
              key={rowKey(r)}
              className={`${rowClass?.(r) ?? ''} ${onRowClick ? 'clickable' : ''}`}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={c.className}>
                  {c.render ? c.render(r) : String(c.value?.(r) ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
