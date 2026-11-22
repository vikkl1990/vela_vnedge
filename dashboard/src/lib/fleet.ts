import type { FleetSource, PaperFleet } from '../api/paperFleet'

/** The only three words the product uses for where a paper trade comes from (decision 323). */
export const OWN_LABEL = 'Own list'
export const COPY_LABEL = 'Copy'

export const cellKey = (scannerId: string, symbol: string, tf: string) => `${scannerId}|${symbol}|${tf}`

export function ownCellSet(fleet: Pick<PaperFleet, 'ownCells'> | undefined): ReadonlySet<string> | null {
  return fleet ? new Set(fleet.ownCells.map((c) => cellKey(c.scannerId, c.symbol, c.tf))) : null
}

/** Null while the allocation is unknown, so a row is never guessed to be a copy. */
export function sourceOfCell(
  own: ReadonlySet<string> | null,
  scannerId: string,
  symbol: string,
  tf: string,
): FleetSource | null {
  if (!own) return null
  return own.has(cellKey(scannerId, symbol, tf)) ? 'own' : 'copy'
}

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
  if (source === 'own') return OWN_LABEL
  const size = sizeLabel(scale)
  return size ? `${COPY_LABEL} ${size}` : COPY_LABEL
}

export function sourceTitle(source: FleetSource, scale?: number | null): string {
  if (source === 'own')
    return 'On the account’s own list: a scanner allocated to this market and timeframe, traded at full size.'
  const size = sizeLabel(scale)
  return `A copy: this cell is not on the own list. The account took a shadow cell’s signal${size ? ` at ${size} of normal size` : ''}, under the account’s own gates.`
}

/** The rule a shadow cell must meet before the account copies it, in words. */
export function copyRuleText(copy: PaperFleet['copy']): string {
  if (!copy.enabled) return 'Copying is off: only the own list trades.'
  const size = sizeLabel(copy.sizeScale)
  const record =
    copy.minTrades && copy.minTrades > 0
      ? `at least ${copy.minTrades} shadow closes${typeof copy.minNetR === 'number' ? ` and net R above ${copy.minNetR}` : ''}`
      : 'no record is required'
  return `A shadow cell is copied once it has ${record}${size ? `, then trades at ${size} size` : ''}.`
}

export function copySharePct(w: PaperFleet['window']): number | null {
  return w.entries.total > 0 ? Math.round((100 * w.entries.copy) / w.entries.total) : null
}
