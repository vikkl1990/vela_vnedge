import type { Position, Signal } from '../api/types'

export type TradingHorizon = 'all' | 'scalp' | 'swing'
/** Unknown frames must not silently become scalp trades. Display filter only. */
export function inHorizon(tf: string, horizon: TradingHorizon): boolean {
  if (horizon === 'all') return true
  const match = /^(\d+)(m|h|d)$/.exec(tf)
  if (!match) return false
  const minutes = Number(match[1]) * ({ m: 1, h: 60, d: 1440 }[match[2]] ?? 0)
  return horizon === 'scalp' ? minutes < 60 : minutes >= 60
}

export function workspaceSignals(rows: Signal[], horizon: TradingHorizon, symbol?: string): Signal[] {
  return rows
    .filter((s) => s.kind === 'entry' && inHorizon(s.tf, horizon) && (!symbol || s.symbol === symbol))
    .sort((a, b) => b.at - a.at || b.id - a.id)
}

/** Missing margin metadata is unknown, never zero available capital. */
export function openCapital(positions: Position[]) {
  let margin = 0,
    unknown = 0,
    risk = 0
  for (const p of positions) {
    const leverage = p.marginLeverage
    const amount =
      p.margin ?? (leverage && leverage > 0 ? (p.qtyOpen * p.contractValue * p.entryPrice) / leverage : null)
    if (amount !== null && Number.isFinite(amount) && amount >= 0) margin += amount
    else unknown++
    if (Number.isFinite(p.riskAmount) && p.riskAmount >= 0) risk += p.riskAmount
  }
  return { margin, unknown, risk }
}
