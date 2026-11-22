import type { FleetSource, PaperFleet } from '../api/paperFleet'

/** The only three words the product uses for where a paper trade comes from (decision 323). */
export const OWN_LABEL = 'Own list'
export const COPY_LABEL = 'Copy'

const FRACTIONS: Array<[number, string]> = [
  [1 / 2, '½'],
  [1 / 3, '⅓'],
  [1 / 4, '¼'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
]
/** A pilot size as people say it: ⅓ rather than 0.3333333. Empty when unknown. */
export function sizeLabel(scale: number | null | undefined): string {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return ''
  if (Math.abs(scale - 1) < 1e-9) return 'full size'
  const hit = FRACTIONS.find(([v]) => Math.abs(v - scale) < 1e-6)
  return hit ? hit[1] : `×${Number(scale.toFixed(2))}`
}

export function sourceLabel(source: FleetSource, scale?: number | null): string {
  if (source === 'unknown') return 'Origin unknown'
  if (source === 'own') return OWN_LABEL
  const size = sizeLabel(scale)
  return size ? `${COPY_LABEL} ${size}` : COPY_LABEL
}

export function sourceTitle(source: FleetSource, scale?: number | null): string {
  if (source === 'unknown')
    return 'Entry origin was not retained. Current allocations cannot establish historical origin.'
  if (source === 'own')
    return 'Recorded at admission as an entry from the account’s own scanner list. Actual size remains subject to sizing and risk checks.'
  const size = sizeLabel(scale)
  return `Recorded at admission as a copied shadow signal${size ? ` with ${size} of the requested base size` : ''}, under the account’s own gates.`
}

/** The rule a shadow cell must meet before the account copies it, in words. */
export function copyRuleText(copy: PaperFleet['copy']): string {
  if (!copy.enabled) return 'Copying is off: only the own list trades.'
  const size = sizeLabel(copy.sizeScale)
  const record =
    copy.minTrades && copy.minTrades > 0
      ? `at least ${copy.minTrades} shadow closes${typeof copy.minNetR === 'number' ? ` and net R above ${copy.minNetR}` : ''}`
      : 'the shared evidence requirements'
  return `Copying requires ${record}, shared evidence checks, entry pricing, liquidity and account risk checks.${size ? ` Current requested pilot size: ${size} of base size.` : ''}`
}

export function copySharePct(w: PaperFleet['window']): number | null {
  return w.entries.total > 0 ? Math.round((100 * w.entries.copy) / w.entries.total) : null
}
