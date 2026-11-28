import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { VerdictState } from '../api/edgeWatch'
import type { JournalRow } from '../api/journal'
import { fmtInt, fmtPct, fmtPnl, fmtR, pnlClass } from '../lib/format'
import { Pill } from './kit'
import type { FrameCell } from './TerminalFrame'

/**
 * Every scanner that trades this market, per timeframe: its live record on this market, its live record across all
 * its markets (30 days), its cached backtest on this cell, and the edge watch's verdict on the scanner and timeframe.
 */
const VERDICT: Record<VerdictState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'accent' }> = {
  collecting: { label: 'collecting', tone: 'muted' },
  consistent: { label: 'in line', tone: 'accent' },
  watch: { label: 'watch', tone: 'warn' },
  pause: { label: 'paused', tone: 'danger' },
  confirmed: { label: 'confirmed', tone: 'ok' },
  'no-baseline': { label: 'no baseline', tone: 'muted' },
}

function liveOf(rows: JournalRow[]) {
  const rs = rows.map((r) => r.r).filter((x): x is number => x != null && Number.isFinite(x))
  const net = rows.reduce((a, r) => a + (r.net ?? r.realizedNet ?? 0), 0)
  return { n: rows.length, wins: rows.filter((r) => (r.net ?? r.realizedNet ?? 0) > 0).length, avgR: rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : null, net }
}

export function ScannerCellStats({ symbol, cells, closed, names }: { symbol: string; cells: FrameCell[]; closed: JournalRow[]; names: (id: string) => string }) {
  const mine = cells.filter((c) => c.symbol === symbol)
  const overview = useQuery({ queryKey: ['trading-overview', '30'], queryFn: () => api.tradingOverview(30), refetchInterval: 60_000, staleTime: 30_000 })
  const watch = useQuery({ queryKey: ['edge-watch'], queryFn: api.edgeWatch, refetchInterval: 60_000, staleTime: 30_000 })
  const backtests = useQueries({
    queries: mine.map((c) => ({ queryKey: ['backtest', c.id, c.symbol, c.tf], queryFn: () => api.backtest(c.id, c.symbol, c.tf), staleTime: 5 * 60_000, retry: 0 })),
  })
  if (!mine.length) return <p className="terminal-empty">No enabled scanner trades {symbol.replace(/USD$/, '')}.</p>
  return (
    <div className="scalp-stats">
      {mine.map((c, i) => {
        const here = liveOf(closed.filter((r) => r.scannerId === c.id && r.tf === c.tf))
        const all = overview.data?.scanners.find((s) => s.id === c.id)
        const bt = backtests[i]?.data?.stats
        const v = watch.data?.verdicts?.cells?.[`${c.id}|${c.tf}`]
        const vs = v ? VERDICT[v.state] ?? VERDICT.collecting : null
        const btTrades = Number(bt?.trades ?? 0)
        return (
          <article key={`${c.id}|${c.tf}`} className="scalp-stat">
            <header>
              <Link to={`/scanners/${encodeURIComponent(c.id)}`}>{names(c.id)}</Link>
              <span className="mono muted">{c.tf}</span>
              {vs && <Pill tone={vs.tone}>{vs.label}</Pill>}
            </header>
            <dl>
              <div>
                <dt>Live here</dt>
                <dd className="mono">
                  {here.n ? (
                    <>
                      {fmtInt(here.n)} tr · {fmtPct((here.wins / here.n) * 100, 0)} win · <span className={pnlClass(here.avgR)}>{here.avgR == null ? '–' : fmtR(here.avgR)}</span> ·{' '}
                      <span className={pnlClass(here.net)}>${fmtPnl(here.net)}</span>
                    </>
                  ) : (
                    'no closed trades'
                  )}
                </dd>
              </div>
              <div>
                <dt>Live, all markets · 30d</dt>
                <dd className="mono">
                  {all && all.live.trades ? (
                    <>
                      {fmtInt(all.live.trades)} tr · {fmtPct((all.live.wins / all.live.trades) * 100, 0)} win ·{' '}
                      <span className={pnlClass(all.live.avgR)}>{all.live.avgR == null ? '–' : fmtR(all.live.avgR)}</span> · <span className={pnlClass(all.live.pnl)}>${fmtPnl(all.live.pnl)}</span>
                    </>
                  ) : (
                    '–'
                  )}
                </dd>
              </div>
              <div>
                <dt>Backtest, this cell</dt>
                <dd className="mono">
                  {bt && btTrades ? (
                    <>
                      {fmtInt(btTrades)} tr · {fmtPct(Number(bt.winRatePct ?? 0), 0)} win ·{' '}
                      <span className={pnlClass(Number(bt.avgR ?? 0))}>{fmtR(Number(bt.avgR ?? 0))}</span> · PF {Number(bt.profitFactor ?? 0).toFixed(2)}
                    </>
                  ) : backtests[i]?.isLoading ? (
                    '…'
                  ) : (
                    'no trades in the cached window'
                  )}
                </dd>
              </div>
              {v && 'baselineMeanR' in v && v.baselineMeanR != null && (
                <div>
                  <dt>Edge watch</dt>
                  <dd className="mono" title={v.reason}>
                    {v.n ?? 0} live vs baseline {fmtR(v.baselineMeanR)}
                  </dd>
                </div>
              )}
            </dl>
          </article>
        )
      })}
    </div>
  )
}
