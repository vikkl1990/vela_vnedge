import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { CellVerdict, EdgeWatchView, VerdictState } from '../api/edgeWatch'
import { fmtInt, fmtPct, fmtR, pnlClass, timeAgo } from '../lib/format'
import { useNow } from '../lib/useNow'
import { Callout, Pill, Section } from './kit'

/**
 * Phase 1 on the Trading page (decision 336): each live (scanner, timeframe) against the backtest it was chosen on,
 * the last daily live-vs-backtest parity check, any pause with its Resume, and how much candle history is archived.
 */
const STATE: Record<VerdictState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'accent' }> = {
  collecting: { label: 'collecting', tone: 'muted' },
  consistent: { label: 'in line', tone: 'accent' },
  watch: { label: 'watch', tone: 'warn' },
  pause: { label: 'paused', tone: 'danger' },
  confirmed: { label: 'confirmed', tone: 'ok' },
  'no-baseline': { label: 'no baseline', tone: 'muted' },
}
const short = (key: string) => {
  const [id, tf] = key.split('|')
  return `${id.replace(/-zeiierman$/, '').replace(/-/g, ' ')} · ${tf}`
}


export function EdgeWatchPanel() {
  const qc = useQueryClient()
  const now = useNow(60_000)
  const q = useQuery({ queryKey: ['edge-watch'], queryFn: api.edgeWatch, refetchInterval: 60_000, staleTime: 30_000 })
  const resume = useMutation({ mutationFn: api.edgeWatchResume, onSuccess: (v) => qc.setQueryData(['edge-watch'], v) })
  const run = useMutation({ mutationFn: api.edgeWatchRun, onSuccess: () => qc.invalidateQueries({ queryKey: ['edge-watch'] }) })
  const v: EdgeWatchView | undefined = q.data
  const cells = Object.entries(v?.verdicts?.cells ?? {}) as Array<[string, CellVerdict]>
  const pauses = Object.entries(v?.pauses ?? {})
  const par = v?.parity
  const parBt = par?.cells.reduce((a, c) => a + c.backtest, 0) ?? 0
  const parM = par?.cells.reduce((a, c) => a + c.matched, 0) ?? 0
  const parLiveOnly = par?.cells.reduce((a, c) => a + c.liveOnly.length, 0) ?? 0
  const arch = v?.archive
  const days = (tf: string) => {
    const xs = arch?.coverage.filter((c) => c.tf === tf) ?? []
    if (!xs.length) return null
    return { markets: xs.length, days: Math.min(...xs.map((c) => (c.to - c.from) / 86_400_000)), bars: xs.reduce((a, c) => a + c.bars, 0) }
  }
  const m1 = days('1m'), m5 = days('5m')
  return (
    <Section
      variant="panel"
      title="Edge watch: live against backtest"
      hint="Each scanner and timeframe judged against the spread-charged backtest it was chosen on. A cell significantly worse and losing is paused in the account."
      actions={
        <button className="btn btn-xs" disabled={run.isPending} onClick={() => run.mutate('verdict')}>
          {run.isPending ? 'Running…' : 'Re-check now'}
        </button>
      }
      pad={false}
    >
      {pauses.map(([key, p]) => (
        <Callout key={key} tone="danger" title={`${short(key)} paused ${timeAgo(p.at, now)}`}>
          {p.reason}{' '}
          <button className="btn btn-xs" disabled={resume.isPending} onClick={() => resume.mutate(key)}>
            Resume
          </button>
        </Callout>
      ))}
      <div className="edge-watch">
        <table className="edge-table">
          <thead>
            <tr>
              <th>Scanner · timeframe</th>
              <th className="num">Live trades</th>
              <th className="num">Live R / trade</th>
              <th className="num">Backtest R / trade</th>
              <th className="num" title="How likely a live record this far below the backtest is by chance. Small = live is worse.">Chance if on track</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {!cells.length && (
              <tr>
                <td colSpan={6} className="muted">{q.isLoading ? 'Loading…' : 'The first verdict runs a few minutes after the server starts.'}</td>
              </tr>
            )}
            {cells.map(([key, c]) => {
              const st = STATE[c.state] ?? STATE.collecting
              return (
                <tr key={key} title={c.reason}>
                  <td>{short(key)}</td>
                  <td className="num mono">{c.n == null ? '–' : fmtInt(c.n)}</td>
                  <td className={`num mono ${pnlClass(c.meanR)}`}>{c.meanR == null || !c.n ? '–' : fmtR(c.meanR)}</td>
                  <td className="num mono">{c.baselineMeanR == null ? '–' : fmtR(c.baselineMeanR)}</td>
                  <td className="num mono">{c.pBelow == null ? '–' : fmtPct(c.pBelow * 100, 0)}</td>
                  <td>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="edge-foot">
          <span>
            <b>Parity, last 24h:</b>{' '}
            {par
              ? `${parM} of ${parBt} backtest trades taken live · ${par.missed} missed without a portfolio reason · ${parLiveOnly} live-only · checked ${timeAgo(par.at, now)}`
              : 'runs once a day'}
          </span>
          <span>
            <b>Candle archive:</b>{' '}
            {m1 || m5
              ? `${m5 ? `5m ${m5.markets} markets, ${Math.floor(m5.days)}+ days` : ''}${m1 && m5 ? ' · ' : ''}${m1 ? `1m ${m1.markets} markets, ${Math.floor(m1.days)}+ days` : ''}${arch?.last ? ` · topped up ${timeAgo(arch.last.at, now)}` : ''}`
              : 'first fill runs two minutes after the server starts'}
          </span>
        </div>
      </div>
    </Section>
  )
}
