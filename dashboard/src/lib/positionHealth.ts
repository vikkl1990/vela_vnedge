import type { PositionHealth } from '../../../shared/positionHealth.ts'

/** Separate queries may arrive out of order; never join an estimate to changed exposure. */
export function healthMatches(
  p: { id: number } & PositionHealth['identity'],
  h: PositionHealth | undefined,
): h is PositionHealth {
  return (
    !!h &&
    h.id === p.id &&
    Object.entries(h.identity).every(([k, v]) => p[k as keyof PositionHealth['identity']] === v)
  )
}
/** Monotonic local elapsed time plus the entire request RTT avoids assuming clock sync. */
export function quoteFresh(h: PositionHealth, receivedAt: number, requestMs: number, now: number): boolean {
  const elapsed = now - receivedAt
  return (
    h.closeNow.netUsd !== null &&
    Number.isFinite(elapsed) &&
    elapsed >= 0 &&
    requestMs >= 0 &&
    elapsed + requestMs < h.closeNow.validForMs
  )
}
