import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useConfig } from '../api/queries'
import { LockStudyPanel } from '../components/LockStudyPanel'
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
  const cfg = useConfig()
  const sizing = cfg.data?.paper?.sizingMode
  // decision 196: the margin re-weighting over a rolling 14 days (the newest first, today partial), not a trial window
  // fixed to a date: a counterfactual statistic on closed trades, not a replay of the portfolio
  const since = useMemo(() => {
    const rows = (q.data ?? []).slice(0, 14)
    const t = (f: (x: DailyRow) => number) => rows.reduce((a, x) => a + f(x), 0)
    return { days: rows.length, partial: rows.some((x) => x.partial), a: t((x) => x.account.sumR), am: t((x) => x.account.marginSumR), s: t((x) => x.shadow.sumR), sm: t((x) => x.shadow.marginSumR) }
  }, [q.data])
  const weeks = useMemo(() => {
    const done = (q.data ?? []).filter((x) => !x.partial)
    return { last: sumWeek(done.slice(0, 7)), prior: sumWeek(done.slice(7, 14)) }
  }, [q.data])
  return (
    <div className="page">
      <PageTitle pre="Every day," accent="as it happened." sub="One row per UTC day, newest first; today is partial. Trades count on the day they closed, R is net of fees, and the trail column is the share of the peak a trail exit kept. The realized balance is starting capital plus closed trades; the equity in the top bar also counts open positions." />
      <p className="muted small">Shadow excludes watch-only orders and experimental plans. Categories stay fixed when scanners move; older categories were inferred once at the 31 October migration.</p>
      <QueryState {...q} data={q.data} empty="No trades yet." onRetry={() => q.refetch()}>
        {(rows) => (
          <>
            <div className="stat-strip" role="list">
              <span role="listitem"><span className="stat-k">Account, last 7 days</span> <span className={`mono ${tone(weeks.last.sr)}`}>{r(weeks.last.avg, 3)}R</span> <span className="muted">a trade over {weeks.last.n}, net {fmtPnl(weeks.last.net)}</span></span>
              <span role="listitem"><span className="stat-k">7 days before</span> <span className={`mono ${tone(weeks.prior.sr)}`}>{r(weeks.prior.avg, 3)}R</span> <span className="muted">over {weeks.prior.n}, net {fmtPnl(weeks.prior.net)}</span></span>
              <span role="listitem"><span className="stat-k">Shadow, last 7 days</span> <span className={`mono ${tone(weeks.last.ssr)}`}>{r(weeks.last.savg, 3)}R</span> <span className="muted">over {weeks.last.sn}</span></span>
              <span role="listitem"><span className="stat-k">7 days before</span> <span className={`mono ${tone(weeks.prior.ssr)}`}>{r(weeks.prior.savg, 3)}R</span> <span className="muted">over {weeks.prior.sn}</span></span>
              <span role="listitem" title={`A counterfactual on closed trades, not a replay: the same trades' R re-weighted as if each had posted the same margin at the same average risk, beside their R as risk-sized. Sizing in force now: ${sizing ?? 'unknown'}.${since.partial ? ' Today is partial.' : ''}`}><span className="stat-k">Margin re-weighting, last {since.days} days</span> <span className="muted">shadow</span> <span className={`mono ${tone(since.s)}`}>{r(since.s, 1)}R</span> <span className="muted">now vs</span> <span className={`mono ${tone(since.sm)}`}>{r(since.sm, 1)}R</span> <span className="muted">by margin · account</span> <span className={`mono ${tone(since.a)}`}>{r(since.a, 1)}</span> <span className="muted">vs</span> <span className={`mono ${tone(since.am)}`}>{r(since.am, 1)}</span> <span className="muted">· sizing now {sizing ?? '–'}</span></span>
            </div>
            <Panel title="Account" pad={false}>
              <div className="table-wrap"><table className="table small daily-table">
                <thead><tr><th>Day</th><th>Trades</th><th>Net</th><th>Fees</th><th>R a trade</th><th>Sum R</th><th>If sized by margin</th><th>Stopped</th><th>Trailed</th><th>Trail kept</th><th title="Starting capital plus every closed trade to the end of the day. The top bar's equity also counts open positions.">Realized balance</th><th>Best · worst scanner</th></tr></thead>
                <tbody>{rows.map((d) => (
                  <tr key={d.day} className={d.partial ? 'muted' : ''}>
                    <td className="mono" data-label="Day">{d.day}{d.partial ? ' (so far)' : ''}</td>
                    <td className="mono" data-label="Trades">{d.account.trades}</td>
                    <td className={`mono ${tone(d.account.net)}`} data-label="Net">{d.account.trades ? fmtPnl(d.account.net) : '–'}</td>
                    <td className="mono" data-label="Fees">{d.account.trades ? d.account.fees.toFixed(2) : '–'}</td>
                    <td className={`mono ${tone(d.account.avgR)}`} data-label="R a trade">{d.account.trades ? r(d.account.avgR, 3) : '–'}</td>
                    <td className={`mono ${tone(d.account.sumR)}`} data-label="Sum R">{d.account.trades ? r(d.account.sumR, 1) : '–'}</td>
                    <td className={`mono ${tone(d.account.marginSumR)}`} data-label="If sized by margin">{d.account.trades ? r(d.account.marginSumR, 1) : '–'}</td>
                    <td className="mono" data-label="Stopped">{d.account.stops}</td>
                    <td className="mono" data-label="Trailed">{d.account.trails}</td>
                    <td className="mono" data-label="Trail kept">{keeps(d.account.trailKeeps)}</td>
                    <td className="mono" data-label="Realized balance">{d.equity.toFixed(2)}</td>
                    <td className="small" data-label="Best · worst">{d.account.best ? `${d.account.best.scanner} ${r(d.account.best.sumR, 1)} · ${d.account.worst!.scanner} ${r(d.account.worst!.sumR, 1)}` : '–'}</td>
                  </tr>))}</tbody>
              </table></div>
            </Panel>
            <LockStudyPanel />
            <Panel title="Shadow book and incubator" pad={false}>
              <div className="table-wrap"><table className="table small daily-table">
                <thead><tr><th>Day</th><th>Trades</th><th>R a trade</th><th>Sum R</th><th>If sized by margin</th><th>15m</th><th>1h</th><th>4h</th><th>Trail kept</th><th>Admitted</th><th>Proposed</th><th>Promoted</th><th>Retired</th><th>Demoted</th></tr></thead>
                <tbody>{rows.map((d) => (
                  <tr key={d.day} className={d.partial ? 'muted' : ''}>
                    <td className="mono" data-label="Day">{d.day}{d.partial ? ' (so far)' : ''}</td>
                    <td className="mono" data-label="Trades">{d.shadow.trades}</td>
                    <td className={`mono ${tone(d.shadow.avgR)}`} data-label="R a trade">{d.shadow.trades ? r(d.shadow.avgR, 3) : '–'}</td>
                    <td className={`mono ${tone(d.shadow.sumR)}`} data-label="Sum R">{d.shadow.trades ? r(d.shadow.sumR, 1) : '–'}</td>
                    <td className={`mono ${tone(d.shadow.marginSumR)}`} data-label="If sized by margin">{d.shadow.trades ? r(d.shadow.marginSumR, 1) : '–'}</td>
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
