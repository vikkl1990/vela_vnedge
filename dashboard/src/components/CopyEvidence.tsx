import type { IncubatorPair } from '../api/types'
import { fmtR } from '../lib/format'

function blocker(p: IncubatorPair) {
  const copy = p.paperCopy
  if (!copy || copy.eligible) return null
  const reason = copy.reason ?? ''
  if (reason.startsWith('scanner quarantined:')) return 'scanner unavailable'
  if (reason.startsWith('restored cell in forward')) return 'forward evaluation'
  if (reason.startsWith('market data unavailable:')) return 'market data missing'
  const e = copy.evidence
  if (e && e.stats.trades < e.minTrades) return 'more compatible closes'
  if (e && e.minTrades > 0 && e.minNetR !== null && !(e.stats.netR > e.minNetR))
    return 'net return requirement'
  if (reason.startsWith('thin market:')) return 'market liquidity'
  return 'other checks'
}

export function CopyEvidenceSummary({ pairs }: { pairs: IncubatorPair[] }) {
  const cells = pairs.filter((p) => p.paperCopy)
  const restored = cells.filter((p) => (p.paperCopy?.evidence?.availableReplayed ?? 0) > 0)
  const counts = new Map<string, number>()
  for (const p of cells) {
    const reason = blocker(p)
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return (
    <details className="small">
      <summary>Why other cells do not qualify</summary>
      <p>
        {[...counts].map(([reason, n]) => `${n} need ${reason}`).join(' · ') ||
          'All assessed cells pass copy checks.'}
      </p>
      {restored.length > 0 && (
        <p>
          Replay restored compatible history for {restored.length} cells;{' '}
          {restored.filter((p) => p.paperCopy?.eligible).length} of those pass paper-copy checks. Restored
          history is part of the sample, not automatic qualification.
        </p>
      )}
      <p>
        Each cell below shows the current compatible sample. Full promotion uses its separate gate; raw
        journal totals can include older readers and execution policies.
      </p>
    </details>
  )
}

export function CopyEvidence({ pair: p }: { pair: IncubatorPair }) {
  const copy = p.paperCopy
  if (!copy) return null
  const e = copy.evidence
  const held = p.restoration && !p.restoration.passed
  return (
    <div className="small" aria-label={`Paper-copy evidence for ${p.scannerId} ${p.symbol} ${p.tf}`}>
      {e && (
        <div>
          <strong>
            {e.stats.trades}/{e.minTrades} qualifying closes
          </strong>{' '}
          · net {fmtR(e.stats.netR)}
        </div>
      )}
      <div>{copy.eligible ? 'Paper-copy candidate' : copy.reason}</div>
      {e && (
        <div className="muted">
          {e.exact} current · {e.replayed} replay-verified · {e.feeCompatible} fee-compatible
        </div>
      )}
      {e && held && (
        <div className="muted">
          {e.available} compatible closes held for forward evaluation, including {e.availableReplayed}{' '}
          replay-verified.
        </div>
      )}
      <div className="muted">
        Journal in this stage: {p.stats?.trades ?? 0} closes across recorded policies.
      </div>
      {p.collection && (
        <div title={p.collection.scan?.reason ?? undefined}>
          Scan: {p.collection.status}
          {p.collection.scan?.status === 'expired' ? ' · last attempt expired' : ''}
        </div>
      )}
    </div>
  )
}
