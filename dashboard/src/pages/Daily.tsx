import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DailyRow } from '../api/types'
import { PageTitle, Panel, QueryState } from '../components/ui'
import { fmtPnl } from '../lib/format'

/**
 * Decision 136: the day-by-day record. One row per UTC day, newest first, today marked partial; trades count on the
 * day they closed, R is net of fees. Nothing waits for a review date: every row is read straight from the books.
 */
const r = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`
const tone = (x: number) => (x > 0 ? 'gain' : x < 0 ? 'loss' : 'muted')
const keeps = (k: number | null) => (k === null ? '–' : `${Math.round(k * 100)}%`)

function sumWeek(rows: DailyRow[]) {
  const n = rows.reduce((a, x) => a + x.account.trades, 0), sr = rows.reduce((a, x) => a + x.account.sumR, 0), net = rows.reduce((a, x) => a + x.account.net, 0)
  const sn = rows.reduce((a, x) => a + x.shadow.trades, 0), ssr = rows.reduce((a, x) => a + x.shadow.sumR, 0)
  return { n, sr, net, avg: n ? sr / n : 0, sn, ssr, savg: sn ? ssr / sn : 0 }
}

export function Daily() {
  const q = useQuery({ queryKey: ['daily'], queryFn: () => api.dailyReport(30), refetchInterval: 60_000, staleTime: 30_000 })
  const weeks = useMemo(() => {
    const done = (q.data ?? []).filter((x) => !x.partial)
    return { last: sumWeek(done.slice(0, 7)), prior: sumWeek(done.slice(7, 14)) }
  }, [q.data])
  return (
    <div className="page">
      <PageTitle pre="Every day," accent="as it happened." sub="One row per UTC day, newest first; today is partial. Trades count on the day they closed, R is net of fees, and the trail column is the share of the peak a trail exit kept." />
      <QueryState {...q} data={q.data} empty="No trades yet." onRetry={() => q.refetch()}>
        {(rows) => (
          <>
            <div className="stat-strip" role="list">
              <span role="listitem"><span className="stat-k">Account, last 7 days</span> <span className={`mono ${tone(weeks.last.sr)}`}>{r(weeks.last.avg, 3)}R</span> <span className="muted">a trade over {weeks.last.n}, net {fmtPnl(weeks.last.net)}</span></span>
              <span role="listitem"><span className="stat-k">7 days before</span> <span className={`mono ${tone(weeks.prior.sr)}`}>{r(weeks.prior.avg, 3)}R</span> <span className="muted">over {weeks.prior.n}, net {fmtPnl(weeks.prior.net)}</span></span>
              <span role="listitem"><span className="stat-k">Shadow, last 7 days</span> <span className={`mono ${tone(weeks.last.ssr)}`}>{r(weeks.last.savg, 3)}R</span> <span className="muted">over {weeks.last.sn}</span></span>
              <span role="listitem"><span className="stat-k">7 days before</span> <span className={`mono ${tone(weeks.prior.ssr)}`}>{r(weeks.prior.savg, 3)}R</span> <span className="muted">over {weeks.prior.sn}</span></span>
            </div>
            <Panel title="Account" pad={false}>
              <div className="table-wrap"><table className="table small daily-table">
                <thead><tr><th>Day</th><th>Trades</th><th>Net</th><th>Fees</th><th>R a trade</th><th>Sum R</th><th>Stopped</th><th>Trailed</th><th>Trail kept</th><th>Equity</th><th>Best · worst scanner</th></tr></thead>
                <tbody>{rows.map((d) => (
                  <tr key={d.day} className={d.partial ? 'muted' : ''}>
                    <td className="mono" data-label="Day">{d.day}{d.partial ? ' (so far)' : ''}</td>
                    <td className="mono" data-label="Trades">{d.account.trades}</td>
                    <td className={`mono ${tone(d.account.net)}`} data-label="Net">{d.account.trades ? fmtPnl(d.account.net) : '–'}</td>
                    <td className="mono" data-label="Fees">{d.account.trades ? d.account.fees.toFixed(2) : '–'}</td>
                    <td className={`mono ${tone(d.account.avgR)}`} data-label="R a trade">{d.account.trades ? r(d.account.avgR, 3) : '–'}</td>
                    <td className={`mono ${tone(d.account.sumR)}`} data-label="Sum R">{d.account.trades ? r(d.account.sumR, 1) : '–'}</td>
                    <td className="mono" data-label="Stopped">{d.account.stops}</td>
                    <td className="mono" data-label="Trailed">{d.account.trails}</td>
                    <td className="mono" data-label="Trail kept">{keeps(d.account.trailKeeps)}</td>
                    <td className="mono" data-label="Equity">{d.equity.toFixed(2)}</td>
                    <td className="small" data-label="Best · worst">{d.account.best ? `${d.account.best.scanner} ${r(d.account.best.sumR, 1)} · ${d.account.worst!.scanner} ${r(d.account.worst!.sumR, 1)}` : '–'}</td>
                  </tr>))}</tbody>
              </table></div>
            </Panel>
            <Panel title="Shadow book and incubator" pad={false}>
              <div className="table-wrap"><table className="table small daily-table">
                <thead><tr><th>Day</th><th>Trades</th><th>R a trade</th><th>Sum R</th><th>15m</th><th>1h</th><th>4h</th><th>Trail kept</th><th>Admitted</th><th>Proposed</th><th>Promoted</th><th>Retired</th><th>Demoted</th></tr></thead>
                <tbody>{rows.map((d) => (
                  <tr key={d.day} className={d.partial ? 'muted' : ''}>
                    <td className="mono" data-label="Day">{d.day}{d.partial ? ' (so far)' : ''}</td>
                    <td className="mono" data-label="Trades">{d.shadow.trades}</td>
                    <td className={`mono ${tone(d.shadow.avgR)}`} data-label="R a trade">{d.shadow.trades ? r(d.shadow.avgR, 3) : '–'}</td>
                    <td className={`mono ${tone(d.shadow.sumR)}`} data-label="Sum R">{d.shadow.trades ? r(d.shadow.sumR, 1) : '–'}</td>
                    {(['15m', '1h', '4h'] as const).map((tf) => { const v = d.shadow.byTf[tf]; return <td key={tf} className={`mono ${v ? tone(v.sumR) : 'muted'}`} data-label={tf}>{v ? `${r(v.sumR, 1)} / ${v.trades}` : '–'}</td> })}
                    <td className="mono" data-label="Trail kept">{keeps(d.shadow.trailKeeps)}</td>
                    <td className="mono" data-label="Admitted">{d.incubator.admitted}</td>
                    <td className="mono" data-label="Proposed">{d.incubator.proposed}</td>
                    <td className="mono" data-label="Promoted">{d.incubator.promoted}</td>
                    <td className="mono" data-label="Retired">{d.incubator.retired}</td>
                    <td className="mono" data-label="Demoted">{d.incubator.demoted}</td>
                  </tr>))}</tbody>
              </table></div>
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  )
}
