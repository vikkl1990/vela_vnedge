import type { TradeMonitorView } from '../api/tradeMonitor'
import { DataTable, Section } from './kit'
import { fmtPnlUsd } from '../lib/format'

const r = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`
export function IntrabarProtectionStudy({
  study,
  title = 'Intrabar order-flow protection',
}: {
  study: NonNullable<TradeMonitorView['intrabarStudy']>
  title?: string
}) {
  return (
    <Section title={title} hint="Shadow comparison · no paper exit changes">
      <p className="small muted">{study.description}</p>
      <DataTable
        rows={study.groups}
        rowKey={(g) => g.key}
        caption="Intrabar protection versus current exits"
        pageSize={10}
        emptyLabel="Collecting future shadow entries. A comparison needs verified entry depth and later closed outcomes; existing positions are not backfilled."
        columns={[
          {
            key: 'cell',
            header: 'Cell / policy',
            render: (g) => (
              <>
                <b>
                  {g.symbol} · {g.tf}
                </b>
                <div>{g.scanner}</div>
                <small title={g.policyId}>{g.policyId.slice(0, 10)}</small>
              </>
            ),
          },
          {
            key: 'sample',
            header: 'Paired / closed / enrolled',
            render: (g) => `${g.covered} / ${g.closed} / ${g.enrolled}`,
          },
          {
            key: 'trigger',
            header: 'Triggered / unavailable closes',
            render: (g) => `${g.triggered} / ${g.unavailable}`,
          },
          {
            key: 'coverage',
            header: 'Usable / quiet / unavailable samples',
            render: (g) => `${g.usable} / ${g.quiet} / ${g.dataUnavailable}`,
          },
          {
            key: 'net',
            header: 'Normalized net before → after',
            render: (g) => (g.covered ? `${fmtPnlUsd(g.baselineNet)} → ${fmtPnlUsd(g.candidateNet)}` : '—'),
          },
          {
            key: 'r',
            header: 'Net R before → after',
            render: (g) => (g.covered ? `${r(g.baselineR)} → ${r(g.candidateR)}` : '—'),
          },
          { key: 'stress', header: 'Stress Δ net R', render: (g) => (g.covered ? r(g.stressDeltaR) : '—') },
          {
            key: 'sl',
            header: 'SLs before → after',
            render: (g) => (g.covered ? `${g.stopsBefore} → ${g.stopsAfter}` : '—'),
          },
          {
            key: 'losses',
            header: 'Losses before → after / stressed',
            render: (g) => (g.covered ? `${g.losersBefore} → ${g.losersAfter} / ${g.stressLosers}` : '—'),
          },
          {
            key: 'cuts',
            header: 'Winners cut / stressed / lost',
            render: (g) => (g.covered ? `${g.winnersCut} / ${g.stressWinnersCut} / ${g.winnersLost}` : '—'),
          },
        ]}
      />
      <p className="small muted">
        Unchanged trades count. Gaps, restarts, maker-model entries and censored fills remain visible as
        unavailable. Fewer SL labels alone do not establish an improvement. Results are separate by scanner,
        pair and frozen policy and never count toward promotion.
      </p>
      <details>
        <summary>Recent collection status</summary>
        <ul>
          {study.recent.map((s) => (
            <li key={s.positionId}>
              #{s.positionId} {s.symbol}: {s.status} — {s.reason}
            </li>
          ))}
        </ul>
      </details>
    </Section>
  )
}
