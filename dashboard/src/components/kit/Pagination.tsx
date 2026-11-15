export function Pagination({
  page,
  pages,
  start,
  end,
  total,
  onChange,
  label = 'Rows',
}: {
  page: number
  pages: number
  start: number
  end: number
  total: number
  onChange: (page: number) => void
  label?: string
}) {
  return (
    <nav className="pagination" aria-label={`${label} pagination`}>
      <span role="status">
        {total ? start + 1 : 0}–{end} of {total} {label.toLowerCase()}
      </span>
      <div className="pagination-controls">
        <button
          type="button"
          className="btn btn-sm"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
          aria-label={`Previous ${label.toLowerCase()} page`}
        >
          Previous
        </button>
        <span>
          {page + 1} / {pages}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={page + 1 >= pages}
          onClick={() => onChange(page + 1)}
          aria-label={`Next ${label.toLowerCase()} page`}
        >
          Next
        </button>
      </div>
    </nav>
  )
}
