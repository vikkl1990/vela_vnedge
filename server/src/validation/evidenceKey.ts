/**
 * Version stamp for cached research evidence (backtests and walk-forward results).
 *
 * The simulation version alone does not change when a scanner's source, inputs, reading,
 * exit mode, cost settings or regime gate change, so a cached result could keep informing
 * auto-tune after the strategy it measured had been edited. Each cached result now carries
 * the strategy identity it was produced under (the same `strategyId` that forward trade
 * evidence uses, see `paper/strategyIdentity.ts`) plus the market-data window it covered.
 *
 * Results written before this stamp existed have no identity: they stay readable for display
 * but are never current evidence for a decision.
 */
export interface CachedEvidence {
  /** `TradePolicy.strategyId` resolved for the cell when the result was produced; null when unresolvable. */
  strategyId: string | null;
  /** Patched Pine source hash at production time (diagnostic; already part of `strategyId`). */
  sourceHash: string | null;
  /** First and last bar open times of the window the result was computed over. */
  windowStart: number | null;
  windowEnd: number | null;
  bars: number;
}

export function cachedEvidence(identity: { strategyId: string; sourceHash: string | null } | null, bars: ReadonlyArray<{ time: number }>): CachedEvidence {
  return {
    strategyId: identity?.strategyId ?? null,
    sourceHash: identity?.sourceHash ?? null,
    windowStart: bars.length ? bars[0].time : null,
    windowEnd: bars.length ? bars[bars.length - 1].time : null,
    bars: bars.length,
  };
}

/**
 * True only when a cached result was stamped with the cell's current strategy identity.
 * Unstamped (legacy) results and results for an unresolvable current identity are not current.
 */
export function evidenceCurrent(result: { evidence?: CachedEvidence } | null | undefined, currentStrategyId: string | null): boolean {
  const id = result?.evidence?.strategyId;
  return Boolean(id && currentStrategyId && id === currentStrategyId);
}
