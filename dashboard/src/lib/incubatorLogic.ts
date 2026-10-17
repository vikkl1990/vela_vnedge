import type { IncubatorPair, IncubatorView } from '../api/types'

export const pf = (v: number | null | undefined) => (v === null ? '∞' : v === undefined ? '—' : v.toFixed(2))
export const r = (v: number | undefined) => (v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)

/** How urgent a live cell's clocks are: 2 = a demotion is due, 1 = half way, 0 = none (decision 121). */
export function clockRank(p: IncubatorPair, cfg: IncubatorView['config']['demote'], now: number): number {
  const outDays = (p.gate as { marketOutDays?: number } | null)?.marketOutDays ?? 0
  const out = p.market && !p.market.allowed ? (cfg.marketOutDays && outDays >= cfg.marketOutDays ? 2 : 1) : 0
  const days = (now - (p.lastTradeAt ?? p.since)) / 86_400_000
  const silent = cfg.silentDays ? (days >= cfg.silentDays ? 2 : days >= cfg.silentDays / 2 ? 1 : 0) : 0
  const starved = cfg.costStarvedRefusals && p.funnel && p.funnel.opened === 0 && p.funnel.cost > 0 ? (p.funnel.cost >= cfg.costStarvedRefusals ? 2 : 1) : 0
  return Math.max(out, silent, starved)
}
