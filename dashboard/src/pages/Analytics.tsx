import { useMemo } from 'react'
import { useAnalytics } from '../api/queries'
import type { Analytics as AnalyticsData } from '../api/types'
import { DataTable, type Column } from '../components/DataTable'
import { ErrorState, Loading, PageTitle, Panel, Time } from '../components/ui'
import { fmtMoney, fmtPct, fmtPnl, fmtProfitFactor } from '../lib/format'
import { LearningSection } from '../components/Learning'

/**
 * Decision 108: the page is the journal, in R, for both books — expectancy with a band, exits and
 * give-back, edge by scanner, pair and timeframe, hold time, hour, regime and session. The dollar
 * tables by pair, scanner, hour and weekday are gone: nothing read them, and at fifty trades they
 * could carry no rule. One dollar table stays, the account's exits, because fees live there.
 */
type ExitRow = AnalyticsData['exits'][number]

export function Analytics() {
  const q = useAnalytics()
  const d = q.data
  const exitCols = useMemo<Column<ExitRow>[]>(
    () => [
      { key: 'reason', header: 'Exit reason', value: (e) => e.reason, render: (e) => <span className="mono">{e.reason}</span> },
      { key: 'trades', header: 'Trades', numeric: true, value: (e) => e.trades },
      { key: 'win', header: 'Win %', numeric: true, value: (e) => e.winRatePct, render: (e) => fmtPct(e.winRatePct) },
      { key: 'pnl', header: 'Net PnL', numeric: true, value: (e) => e.pnl, render: (e) => <span className={e.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(e.pnl)}</span> },
      { key: 'fees', header: 'Fees', numeric: true, value: (e) => e.fees, render: (e) => fmtMoney(e.fees) },
      {
        key: 'avg',
        header: 'Avg / trade',
        numeric: true,
        value: (e) => e.pnl / Math.max(1, e.trades),
        render: (e) => <span className={e.pnl >= 0 ? 'gain' : 'loss'}>{fmtPnl(e.pnl / Math.max(1, e.trades))}</span>,
      },
    ],
    [],
  )
  const tot = d?.totals.live
  return (
    <div className="page">
      <PageTitle pre="Where the edge," accent="lives." sub="The journal in R for the account and the shadow book: expectancy with a band, where the R goes at exit, edge by scanner, pair and timeframe, and R by hold time, hour, regime and session. One table in dollars: the account's exits, where the fees are." />
      <LearningSection />
      {q.isLoading && !d && <Loading kind="table" rows={4} cols={6} />}
      {q.isError && !d && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && tot && (
        <Panel
          title="Account exits, in dollars"
          right={
            <span className="muted small">
              {tot.trades} closed trades · net {fmtPnl(tot.pnl)} · fees {fmtMoney(tot.fees)} · PF {fmtProfitFactor(tot.profitFactor)} · updated <Time t={d.at} />
            </span>
          }
          pad={false}
        >
          <DataTable
            columns={exitCols}
            rows={d.exits}
            rowKey={(e) => e.reason}
            defaultSort={{ key: 'pnl', dir: 'desc' }}
            caption="Paper exits by reason"
            emptyLabel={
              <span>
                No closed account trades yet<span className="empty-hint">Exit reasons are tallied from the account's closed trades.</span>
              </span>
            }
          />
        </Panel>
      )}
    </div>
  )
}
