export interface StoppedPosition { symbol: string; scannerId: string; exitReason?: string | null; exitAt?: number | null }

/** A failed market setup belongs to the pair, regardless of which scanner asks next. */
export function recentPairStop<T extends StoppedPosition>(closed: T[], symbol: string, at: number, minutes: number): T | undefined {
  if (!(minutes > 0) || !Number.isFinite(at)) return undefined;
  return closed.filter(p => p.symbol === symbol && p.exitReason === 'sl' && p.exitAt != null
    && p.exitAt <= at && at - p.exitAt < minutes * 60_000)
    .reduce<T | undefined>((last, p) => !last || p.exitAt! > last.exitAt! ? p : last, undefined);
}
