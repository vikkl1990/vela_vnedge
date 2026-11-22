import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { REFRESH } from '../api/refreshPolicy'
import { Callout, EmptyState, ErrorState, Loading, Section } from './kit'

import { Link } from 'react-router-dom'
import { useHealth } from '../api/queries'
import { fmtMoney } from '../lib/format'

/** Keep operational faults visible even while the full evidence table is collapsed. */
export function PolicyHealthStatus() {
  const health = useHealth()
  const q = useQuery({
    queryKey: ['policy-health'],
    queryFn: api.policyHealth,
    refetchInterval: REFRESH.slow,
  })
  if (!q.data)
    return q.isError ? (
      <ErrorState error={q.error} onRetry={() => q.refetch()} />
    ) : (
      <p className="muted small">Loading execution reliability…</p>
    )
  const d = q.data
  const quarantined = d.books.reduce((n, b) => n + b.quarantined, 0)
  const warn = Boolean(d.boundExits.failures || health.data?.attention?.length)
  return (
    <Callout tone={warn ? 'warn' : 'info'} title="Evidence quality">
      <span role="status">
        {quarantined} historical trades quarantined from evidence in the last {d.windowDays} days.
        <span className={d.boundExits.failures ? 'loss' : ''}>
          {' '}
          {d.boundExits.failures} held positions with archived-exit errors.
        </span>
        {(health.data?.attention ?? []).map((item) => (
          <span key={item.key} className="loss">
            {' '}
            {item.text} · <Link to={item.href}>Inspect</Link>.
          </span>
        ))}{' '}
        Policy versions and reserved margin:{' '}
        <Link to="/incubator?section=operations#incubator-evidence">evidence details</Link>.
      </span>
    </Callout>
  )
}

export function PolicyHealthPanel() {
  const q = useQuery({
    queryKey: ['policy-health'],
    queryFn: api.policyHealth,
    refetchInterval: REFRESH.slow,
  })
  return (
    <Section variant="panel" title="Evidence & execution reliability">
      {q.isPending && <Loading rows={2} />}
      {q.error && <ErrorState error={q.error} />}
      {q.data && (
        <>
          {q.data.boundExits.failures > 0 && (
            <p className="loss">
              {q.data.boundExits.failures} archived scanner exit runs failed. Price stops remain active;
              inspect scanner execution before changing its rules.
            </p>
          )}
          <p className="small muted">
            Last {q.data.windowDays} days. Paper readiness includes verified compatible history; replayed
            sizing must reproduce the recorded contracts and stop risk. Shadow matching uses strategy
            identity. Promotion and leverage keep their separate evidence rules. Historical profits are never
            scaled up.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Book</th>
                  <th>Matching</th>
                  <th>Changed rules</th>
                  <th>Legacy / unknown</th>
                  <th>Quarantined</th>
                  <th>Resting orders</th>
                  <th>Reserved margin</th>
                </tr>
              </thead>
              <tbody>
                {q.data.books.map((b) => (
                  <tr key={b.book}>
                    <td>{b.book === 'paper' ? 'Paper account' : 'Shadow research'}</td>
                    <td>
                      {b.matching}
                      {!!b.capacityCompatible && (
                        <div className="small muted">{b.capacityCompatible} capacity-compatible</div>
                      )}
                      {!!b.scopeCompatible && (
                        <div className="small muted">{b.scopeCompatible} unrelated-cell settings</div>
                      )}
                      {!!b.sizingCompatible && (
                        <div className="small muted">{b.sizingCompatible} same-size replay</div>
                      )}
                      {!!b.executionCompatible && (
                        <div className="small muted">{b.executionCompatible} identical execution replay</div>
                      )}
                    </td>
                    <td>{b.changed}</td>
                    <td>{b.legacy}</td>
                    <td>{b.quarantined}</td>
                    <td>{b.pending}</td>
                    <td>{b.book === 'paper' ? fmtMoney(b.reservedMargin) : 'Independent cells'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.data.books
            .filter((b) => b.book === 'paper' && b.exclusions)
            .map((b) => (
              <PaperReadinessHistory key={b.book} book={b} windowDays={q.data!.windowDays} />
            ))}
          <p className="small muted">
            {q.data.books.reduce((n, b) => n + b.adoptedOpen, 0)} existing positions/orders adopted at
            migration; their original settings are unknown. {q.data.haltEvents} recorded loss-limit events in
            this window.
          </p>
          <p className="small muted">
            Paper entries ready in the same {q.data.allocation.widthMs} ms window are ordered consistently.
            Risk and available margin are checked at admission.
          </p>
          <p className="small">
            Live readiness still needs forward profitability and exchange lifecycle certification. Execution
            replay cannot reconstruct missing historical depth or order queues.
          </p>
        </>
      )}
    </Section>
  )
}

type PolicyBook = Awaited<ReturnType<typeof api.policyHealth>>['books'][number]

/** Same explanation on Live control and the detailed evidence page. No second qualification rule. */
function PaperReadinessHistory({ book: b, windowDays }: { book: PolicyBook; windowDays: number }) {
  const capacity = b.capacityCompatible ?? 0
  const scope = b.scopeCompatible ?? 0
  const sizing = b.sizingCompatible ?? 0
  const execution = b.executionCompatible ?? 0
  return (
    <div className="stack" aria-label="Paper readiness exclusions">
      <h3>Why other paper trades do not count</h3>
      <p className="small muted">
        {b.totalClosed !== undefined && b.outsideWindow !== undefined ? (
          <>
            {b.totalClosed} closed paper trades in the journal; {b.outsideWindow} are outside the {windowDays}
            -day readiness window. Within the window, {b.matching} qualify.
          </>
        ) : (
          <>
            {b.matching} trades qualify in the last {windowDays} days. Total journal coverage is unavailable.
          </>
        )}
      </p>
      <p className="small">
        Included: {b.matching - capacity - scope - sizing - execution} exact matches + {capacity}{' '}
        capacity-compatible + {scope} unrelated-cell settings + {sizing} same-size replay + {execution}{' '}
        identical execution replay.
      </p>
      <p className="small muted">
        An execution-model change can reduce the compatible count without deleting trades. An older trade
        counts through execution replay only when recorded inputs reproduce its original exit and the new
        model gives the same timing, size, price, fees and net result. Changed or unverifiable outcomes remain
        excluded; the replay subset alone does not establish performance for the whole new policy.
      </p>
      {b.exclusions ? (
        b.exclusions.length ? (
          <ul>
            {b.exclusions.map((item) => (
              <li key={item.reason}>
                {item.label}: <strong>{item.trades}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">All closed paper trades within this window qualify.</p>
        )
      ) : (
        <p className="small muted">The server did not supply an exclusion breakdown.</p>
      )}
    </div>
  )
}

export function ReadinessHistoryPanel() {
  const q = useQuery({
    queryKey: ['policy-health'],
    queryFn: api.policyHealth,
    refetchInterval: REFRESH.slow,
  })
  const book = q.data?.books.find((b) => b.book === 'paper')
  return (
    <div id="readiness-history">
      <Section variant="panel" title="Readiness trade history">
        {q.isPending ? (
          <Loading rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : book && q.data ? (
          <>
            <PaperReadinessHistory book={book} windowDays={q.data.windowDays} />
            <p className="small muted">
              Counts refresh independently of the checklist. Shadow research and backtests do not count as
              paper closes. Compatible history keeps its recorded returns; missing evidence is never treated
              as a pass.
            </p>
            <p className="small muted">
              To build the record: keep execution rules stable, resolve scanner and fill failures, and let
              qualified cells trade within available margin and risk limits. Trade count alone does not
              establish positive expectancy.
            </p>
            <Link to="/incubator?section=operations#incubator-evidence">
              Inspect evidence and execution reliability
            </Link>
          </>
        ) : (
          <EmptyState title="Paper readiness history is unavailable." />
        )}
      </Section>
    </div>
  )
}
