/** Public quote inputs only. This module has no authenticated exchange client. */
export interface ShadowQuote { symbol: string; bid: number; ask: number; markPrice: number; timeMs: number }
export const QUOTE_MAX_AGE_MS = 10_000;
export const SIGNAL_MAX_AGE_MS = 30_000;
export function freshQuote(q: ShadowQuote, now: number): boolean {
  return [q.bid, q.ask, q.markPrice, q.timeMs].every(v => Number.isFinite(v) && v > 0)
    && q.bid <= q.ask && now - q.timeMs >= -1000 && now - q.timeMs <= QUOTE_MAX_AGE_MS;
}
/** Delta timestamps can be seconds, milliseconds or microseconds. Missing time is invalid. */
export function exchangeTimeMs(raw: unknown): number {
  const n = Number(raw);
  return n >= 1e14 ? Math.floor(n / 1000) : n >= 1e11 ? n : n >= 1e9 ? n * 1000 : NaN;
}
