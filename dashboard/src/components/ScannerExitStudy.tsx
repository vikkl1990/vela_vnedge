import type { TradeMonitorView } from '../api/tradeMonitor'
import { DataTable, Section } from './kit'
import { fmtPnlUsd } from '../lib/format'

const names: Record<string, string> = {
  'supertrend-cluster-zeiierman': 'SuperTrend Cluster',
  'ai-predictive-flow-zeiierman': 'AI Predictive Flow',
  'trend-impulse-channels-zeiierman-maker': 'SOL continuation-maker',
}
const r = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`

export function ScannerExitStudy({ study }: { study: NonNullable<TradeMonitorView['scannerExitStudy']> }) {
  return (
    <Section
      title="Scanner-specific earlier exits"
      hint="Prospective shadow evaluation · paper exits unchanged"
    >
      <p className="small muted">{study.description}</p>
      <DataTable
        rows={study.groups}
        rowKey={(g) => g.key}
        caption="Scanner-specific earlier exit comparison"
        pageSize={15}
        emptyLabel="Waiting for future SuperTrend Cluster, AI Predictive Flow or SOL maker fills. Existing trades are not enrolled."
        columns={[
          {
            key: 'scanner',
            header: 'Scanner / reference / policy',
            render: (g) => (
              <>
                <b>{names[g.scanner] ?? g.scanner}</b>
                <div>
                  {g.symbol} · {g.tf} · {g.book === 0 ? 'Paper reference' : 'Shadow reference'}
                </div>
                <span className="small muted" title={g.policyId}>
                  {g.policyId.slice(0, 10)}
                </span>
              </>
            ),
          },
          {
            key: 'coverage',
            header: 'Covered / closed / enrolled',
            render: (g) => `${g.covered} / ${g.closed} / ${g.enrolled}`,
          },
          {
            key: 'missing',
            header: 'Unavailable / missing trade',
            render: (g) => `${g.unavailable} / ${g.missingActual}`,
          },
          {
            key: 'net',
            header: 'Net before → after',
            render: (g) =>
              !g.covered
                ? '—'
                : g.baselineNet !== null && g.candidateNet !== null
                  ? `${fmtPnlUsd(g.baselineNet)} → ${fmtPnlUsd(g.candidateNet)}`
                  : `${r(g.baselineR)} → ${r(g.candidateR)}`,
          },
          { key: 'stress', header: 'Stress Δ net R', render: (g) => (g.covered ? r(g.stressDeltaR) : '—') },
          {
            key: 'sl',
            header: 'Full SLs before → after',
            render: (g) => `${g.stopsBefore} → ${g.stopsAfter}`,
          },
          {
            key: 'losses',
            header: 'Losing trades before → after',
            render: (g) => `${g.losersBefore} → ${g.losersAfter}`,
          },
          {
            key: 'winners',
            header: 'Winners cut / turned nonpositive',
            render: (g) => `${g.winnersCut} / ${g.winnersLost}`,
          },
          {
            key: 'giveback',
            header: 'Profit cut from winners',
            render: (g) => (g.covered ? r(g.winnerGivebackR) : '—'),
          },
        ]}
      />
      <p className="small muted">
        Includes unchanged trades. Fewer SL labels can still mean losing exits. Net, SL and winner metrics use
        covered pairs only. Unavailable cases remain in the coverage counts. Results retain each entry’s
        frozen policy and never count toward promotion. No automatic paper activation; later independent
        evidence must show better net profit and fewer SLs, including execution stress and winners cut short.
      </p>
    </Section>
  )
}
