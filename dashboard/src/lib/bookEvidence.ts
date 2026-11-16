const DAY = 86_400_000

export function quietShadowCount(
  pairs: Array<{ stage: string; since: number; lastTradeAt?: number | null }>,
  now: number,
): number {
  return pairs.filter(
    (p) =>
      p.stage === 'shadow' &&
      Number.isFinite(p.since) &&
      now >= p.since + 30 * DAY &&
      now - Math.max(p.since, p.lastTradeAt ?? p.since) >= 30 * DAY,
  ).length
}

/** R per trade must weight each screen by its sample, not give one-trade cells equal weight. */
export function screenMeanR(screens: Array<{ avgR: number | null; trades: number | null }>): number | null {
  const measured = screens.filter(
    (s) => Number.isFinite(s.avgR) && Number.isFinite(s.trades) && s.trades! > 0,
  )
  const n = measured.reduce((sum, s) => sum + s.trades!, 0)
  return n ? measured.reduce((sum, s) => sum + s.avgR! * s.trades!, 0) / n : null
}
