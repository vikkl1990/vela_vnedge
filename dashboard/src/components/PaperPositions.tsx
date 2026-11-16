import type { usePositions } from '../api/queries'
import type { Position } from '../api/types'
import { useSSE } from '../sse/SSEProvider'
import { ErrorState, Loading, Time } from './kit'
import { PositionsTable } from './PositionsTable'
import '../styles/positions.css'

export function PaperPositions({
  query,
  visiblePositions,
  compact = false,
}: {
  query: ReturnType<typeof usePositions>
  visiblePositions?: Position[]
  compact?: boolean
}) {
  const stream = useSSE()
  const rows = visiblePositions ?? query.data ?? []
  return (
    <>
      <div className="paper-positions-status small" role="status">
        <span>Recorded paper fills · times show when each simulated fill was recorded.</span>
        <span>
          {query.dataUpdatedAt ? (
            <>
              Last full refresh <Time t={query.dataUpdatedAt} mode="ago" />
            </>
          ) : (
            'Loading the complete position list…'
          )}
        </span>
        <button className="btn btn-xs" onClick={() => query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? 'Refreshing positions…' : 'Refresh positions'}
        </button>
        {stream.status !== 'connected' && (
          <span className="loss">Live updates disconnected; checking the server every 10 seconds.</span>
        )}
        {query.isError && query.data && (
          <span className="loss">
            Refresh failed. Showing the last confirmed list; current positions are unverified.
          </span>
        )}
      </div>
      {query.isPending && !query.data ? (
        <Loading kind="table" rows={3} cols={10} />
      ) : query.isError && !query.data?.length ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : visiblePositions && !rows.length && query.data?.length ? (
        <p className="paper-positions-status">
          No positions in this view; {query.data.length} open in the account.
        </p>
      ) : (
        <PositionsTable positions={rows} compact={compact} />
      )}
    </>
  )
}
