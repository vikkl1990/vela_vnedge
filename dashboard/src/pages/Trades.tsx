import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { TradeJournal } from '../components/TradeJournal'
import { useCloseAll, useExecution, usePositions } from '../api/queries'
import { PositionsTable } from '../components/PositionsTable'
import { BookBadge, ConfirmDialog, ErrorState, Loading, PageTitle, Panel } from '../components/ui'
import { useToast } from '../lib/toast'

export function Trades() {
  const positions = usePositions()
  const [params] = useSearchParams()
  const shadow = params.get('book') === 'shadow'
  const closeAll = useCloseAll()
  const exec = useExecution()
  const mode = exec.data?.mode ?? 'paper'
  const mirrored = mode !== 'paper' && !exec.data?.dryRun
  const toast = useToast()
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const openCount = positions.data?.length ?? 0

  return (
    <div className="page">
      <PageTitle pre="Every trade," accent="its" post="recorded story." sub={<>Paper and shadow journals: signals, sizing, stops, targets, costs and every retained fill. <BookBadge book={shadow ? "shadow" : "account"} mode={mode} short /></>} />

      <TradeJournal />

      {!shadow && <Panel
        title={
          <span>
            Open positions <span className="muted small">({openCount})</span>
          </span>
        }
        right={
          <button className="btn btn-sm btn-danger-outline" onClick={() => setConfirmCloseAll(true)} disabled={openCount === 0 || closeAll.isPending}>
            {closeAll.isPending ? 'Closing…' : 'Close all'}
          </button>
        }
        pad={false}
      >
        {positions.isLoading && !positions.data ? (
          <Loading kind="table" rows={3} cols={10} />
        ) : positions.isError && !positions.data ? (
          <ErrorState error={positions.error} onRetry={() => positions.refetch()} />
        ) : (
          <PositionsTable positions={positions.data ?? []} />
        )}
      </Panel>}

      <ConfirmDialog
        open={confirmCloseAll}
        title={`Close all ${openCount} open position${openCount === 1 ? '' : 's'}?`}
        body={<p>Every open position is closed at market {mirrored ? `— paper book and ${exec.data?.host ?? mode} account` : mode === 'paper' ? '(paper only)' : `(paper only; ${mode} is in dry-run)`}. This cannot be undone.{mirrored && <><br /><span className="muted small">The paper book closes immediately; exchange orders follow and are confirmed separately on the exchange.</span></>}</p>}
        confirmLabel="Close all"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmCloseAll(false)}
        onConfirm={() =>
          closeAll.mutate(undefined, {
            onSuccess: () => {
              setConfirmCloseAll(false)
              toast.success(mirrored ? 'Close requested: the paper book is flat' : 'All positions closed')
            },
            onError: (e) => toast.error('Close all failed', e.message),
          })
        }
      />
    </div>
  )
}
