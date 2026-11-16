import { useState } from 'react'

/** A changing filter resets the page without an effect or a second render. */
export function usePagination(total: number, pageSize: number, resetKey = '') {
  const [selected, setSelected] = useState({ key: resetKey, page: 0 })
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(pages - 1, selected.key === resetKey ? selected.page : 0)
  return {
    page,
    pages,
    start: page * pageSize,
    end: Math.min(total, (page + 1) * pageSize),
    setPage: (next: number) => setSelected({ key: resetKey, page: Math.max(0, Math.min(pages - 1, next)) }),
  }
}
