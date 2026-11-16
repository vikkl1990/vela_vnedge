import { useCallback } from 'react'
import { useAssetClasses } from '../api/queries'
import type { PerformanceGroup } from '../api/types'
import { classifySymbol, type AssetClass } from '../../../shared/assetClass'

/**
 * The asset class of any market: the server's answer once it has loaded (it knows Delta's own tags), the shared
 * classifier on the symbol alone until then, so a chip never waits on the network and never disagrees with the server
 * about the four majors, the meme coins or the stocks.
 */
export function useClassOf(): (symbol: string) => AssetClass {
  const map = useAssetClasses().data?.classes
  return useCallback(
    (symbol: string) => (map?.[symbol] as AssetClass | undefined) ?? classifySymbol(symbol),
    [map],
  )
}

/** Short label for a chip: the group, except stocks & metals, which read better by their sector. */
export function chipLabel(c: AssetClass): string {
  switch (c.group) {
    case 'majors':
      return 'Major'
    case 'large_alts':
      return 'Large alt'
    case 'alts':
      return 'Alt'
    case 'meme':
      return 'Meme'
    case 'tradfi':
      return c.sector === 'metals' ? 'Metal' : c.sector === 'energy' ? 'Energy' : 'Stock'
    default:
      return 'Other'
  }
}

export interface ClassRow {
  key: string
  trades: number
  avgR: number | null
  net: number
}
/** One book's side of the performance report's groups, as breakdown rows. */
export const classRows = (rows: PerformanceGroup[] | undefined, book: 'paper' | 'shadow'): ClassRow[] =>
  (rows ?? []).map((r) => ({ key: r.key, trades: r[book].trades, avgR: r[book].avgR, net: r[book].net }))
