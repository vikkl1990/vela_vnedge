import { groupLabel, sectorLabel, type AssetClass } from '../../../shared/assetClass'
import { chipLabel, useClassOf } from '../lib/assetClass'
import '../styles/asset-chip.css'

export function AssetChip({
  symbol,
  cls,
  withSector = false,
  className = '',
}: {
  symbol: string
  /** Pass a class you already hold to skip the lookup. */
  cls?: AssetClass
  /** Add the sector (AI, DeFi, Layer 1…) after the group when it says something more than the group. */
  withSector?: boolean
  className?: string
}) {
  const classOf = useClassOf()
  const c = cls ?? classOf(symbol)
  const sector =
    withSector && c.sector !== 'other' && c.group !== 'tradfi' && c.group !== 'meme'
      ? sectorLabel(c.sector)
      : ''
  return (
    <span
      className={`asset-chip ${className}`}
      data-group={c.group}
      title={`${symbol}: ${groupLabel(c.group)}${c.sector !== 'other' ? ` · ${sectorLabel(c.sector)}` : ''}${c.tags.length > 1 ? ` (${c.tags.map(sectorLabel).join(', ')})` : ''}`}
    >
      {chipLabel(c)}
      {sector && <span className="asset-chip-sector">{sector}</span>}
    </span>
  )
}
