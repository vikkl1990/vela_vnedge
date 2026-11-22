import type { PerformanceStats } from '../api/types'
import { evidenceDetail, evidenceOf, VERDICT_LABEL, type EvidenceVerdict } from '../lib/evidence'
import '../styles/evidence.css'

const GLYPH: Record<EvidenceVerdict, string> = { edge: '✓', negative: '✗', unproven: '≈', thin: '…' }

/**
 * A word and a mark next to an average R, so a number is never read without what it rests on. The word carries the meaning;
 * colour only reinforces it. The title holds the interval and the sample.
 */
export function EvidenceBadge({
  stats,
}: {
  stats: Pick<PerformanceStats, 'avgR' | 'rTrades'> & { seR?: number | null; rDays?: number }
}) {
  const e = evidenceOf(stats)
  if (e.avgR === null) return null
  return (
    <span className="evidence" data-verdict={e.verdict} title={evidenceDetail(e)}>
      <span aria-hidden>{GLYPH[e.verdict]}</span> {VERDICT_LABEL[e.verdict]}
      <span className="evidence-n"> n={e.trades}</span>
    </span>
  )
}
