import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useCloseAll, useExecution, usePositions } from '../api/queries'
import { PaperPositions } from '../components/PaperPositions'
import { TradeJournal } from '../components/TradeJournal'
import {
  AccountBadge,
  BookBadge,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Section,
} from '../components/kit'

import { useBook } from '../lib/bookScope'
import { useToast } from '../lib/toast'

type BookScopeKey = 'live' | 'backtest'

export function Trades() {
  const positions = usePositions()
  const [params] = useSearchParams()
  const { scope } = useBook()
  const shadow = scope === 'shadow' || (scope !== 'paper' && params.get('book') === 'shadow')
  const closeAll = useCloseAll()
  const exec = useExecution()
  const mode = exec.data?.mode ?? 'paper'
  const mirrored = mode !== 'paper' && !exec.data?.dryRun
  const toast = useToast()
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const openCount = positions.data?.length ?? 0
  // Live and backtest have no journal: say so, and let the operator look at the paper journal anyway for this scope only.
  const [peek, setPeek] = useState<BookScopeKey | null>(null)
  const noJournal = (scope === 'live' || scope === 'backtest') && peek !== scope

  return (
    <div className="page trades-page">
      <PageHeader
        title="Trades"
        subtitle={
          shadow
            ? 'The shadow book: signals the library took on paper, with synthetic dollars. It never touches the account.'
            : 'Every trade with its signal, sizing, stops, targets, costs and fills. Paper and shadow books are kept apart.'
        }
        meta={shadow ? <BookBadge book="shadow" short /> : <AccountBadge mode={mode} short />}
        actions={
          <button className="btn btn-sm" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}>
            {exportOpen ? 'Hide export' : 'Export CSV'}
          </button>
        }
      />

      {noJournal ? (
        <EmptyState
          title={
            scope === 'live'
              ? 'Live executions are tracked on Exchange'
              : 'A backtest has no trades in the journal'
          }
          hint={
            scope === 'live'
              ? 'This journal does not provide a separate, reconciled live-trade history. Check production orders and fills on Exchange; paper and shadow records remain separate.'
              : 'Backtests replay history in the Lab and do not write journal rows. Paper and shadow trades are kept in their own journals.'
          }
          action={
            <div className="row gap" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
              <Link to={scope === 'live' ? '/live' : '/lab'} className="btn btn-sm">
                {scope === 'live' ? 'Open the go-live checklist' : 'Open the Lab'}
              </Link>
              <button className="btn btn-sm" onClick={() => setPeek(scope as BookScopeKey)}>
                Show the paper and shadow journals
              </button>
            </div>
          }
        />
      ) : (
        <>
          <TradeJournal exportOpen={exportOpen} onExportClose={() => setExportOpen(false)} />

          {!shadow && (
            <Section
              variant="panel"
              title={
                <span>
                  Open positions <span className="muted small">({openCount})</span>
                </span>
              }
              actions={
                <button
                  className="btn btn-sm btn-danger-outline"
                  onClick={() => setConfirmCloseAll(true)}
                  disabled={openCount === 0 || closeAll.isPending}
                >
                  {closeAll.isPending ? 'Closing…' : 'Close all'}
                </button>
              }
              pad={false}
            >
              <PaperPositions query={positions} />
            </Section>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmCloseAll}
        title={`Close all ${openCount} open position${openCount === 1 ? '' : 's'}?`}
        body={
          <p>
            Requests a market exit for every open position{' '}
            {mirrored
              ? `— paper book and ${exec.data?.host ?? mode} account`
              : mode === 'paper'
                ? '(paper only)'
                : `(paper only; ${mode} is in dry-run)`}
            . This cannot be undone.
            {mirrored && (
              <>
                <br />
                <span className="muted small">
                  The paper book closes immediately; exchange orders follow and are confirmed separately on
                  the exchange.
                </span>
              </>
            )}
          </p>
        }
        confirmLabel="Close all"
        danger
        busy={closeAll.isPending}
        onCancel={() => setConfirmCloseAll(false)}
        onConfirm={() =>
          closeAll.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmCloseAll(false)
              toast.success(
                result.pending
                  ? `${result.pending} exits pending; remaining exposure is held`
                  : mirrored
                    ? 'Close requested: the paper book is flat'
                    : 'All positions closed',
              )
            },
            onError: (e) => toast.error('Close all failed', e.message),
          })
        }
      />
    </div>
  )
}
