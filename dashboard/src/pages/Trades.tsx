import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { TradeJournal } from '../components/TradeJournal'
import { useCloseAll, useExecution, usePositions } from '../api/queries'
import { PositionsTable } from '../components/PositionsTable'
import { BookBadge, ConfirmDialog, ErrorState, Loading, Panel } from '../components/ui'
import { PageHeader } from '../components/kit'
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
  const [exportOpen, setExportOpen] = useState(false)
  const openCount = positions.data?.length ?? 0

  return (
    <div className="page trades-page">
      <PageHeader
        title="Journals"
        subtitle={shadow ? 'The shadow book: signals the library took on paper, with synthetic dollars. It never touches the account.' : 'Every trade with its signal, sizing, stops, targets, costs and fills. Paper and shadow books are kept apart.'}
        meta={<BookBadge book={shadow ? 'shadow' : 'account'} mode={mode} short />}
        actions={<button className="btn btn-sm" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>{exportOpen ? 'Hide export' : 'Export CSV'}</button>}
      />

      <TradeJournal exportOpen={exportOpen} onExportClose={() => setExportOpen(false)} />

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
        body={<p>Requests a market exit for every open position {mirrored ? `— paper book and ${exec.data?.host ?? mode} account` : mode === 'paper' ? '(paper only)' : `(paper only; ${mode} is in dry-run)`}. This cannot be undone.{mirrored && <><br /><span className="muted small">The paper book closes immediately; exchange orders follow and are confirmed separately on the exchange.</span></>}</p>}
        confirmLabel="Close all"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmCloseAll(false)}
        onConfirm={() =>
          closeAll.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmCloseAll(false)
              toast.success(result.pending ? `${result.pending} exits pending; remaining exposure is held` : mirrored ? 'Close requested: the paper book is flat' : 'All positions closed')
            },
            onError: (e) => toast.error('Close all failed', e.message),
          })
        }
      />
    </div>
  )
}
