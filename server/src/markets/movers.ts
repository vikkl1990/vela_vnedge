/**
 * What is moving right now. Delta's tickers carry only a 24-hour change, so a pump that is ten minutes old looks like
 * any other busy market. This keeps a short ring of mark prices per market, filled each time the market list is fetched,
 * and reads the change over 5, 15 and 60 minutes from it.
 *
 * Display only: nothing here opens, sizes or skips a trade. A change is reported only when the ring really reaches back
 * that far, so a server that restarted ten minutes ago shows no 60-minute figure instead of a wrong one.
 */
export const MOVER_WINDOWS_MIN = [5, 15, 60] as const;
export type MoverWindow = (typeof MOVER_WINDOWS_MIN)[number];

/** Samples closer together than this replace the last one: the market list is fetched by several callers. */
const MIN_GAP_MS = 20_000;
/** A window is answered from the newest sample at or before its start, and only if that sample is not older than the window plus this slack. */
const SLACK_MS = 2 * 60_000;
const KEEP_MS = (Math.max(...MOVER_WINDOWS_MIN) + 5) * 60_000;

interface Sample {
  at: number;
  price: number;
}

export interface MoverRow {
  symbol: string;
  price: number;
  /** Percent change over each window, null when the ring does not reach back far enough. */
  ch5: number | null;
  ch15: number | null;
  ch60: number | null;
  /** The largest absolute change across the windows that are known, the sort key. */
  peak: number;
}

export class MoverStore {
  private readonly rings = new Map<string, Sample[]>();

  /** Record one reading for every market. Non-finite or non-positive prices are skipped, never stored as zero. */
  record(at: number, readings: Iterable<{ symbol: string; price: number }>): void {
    for (const { symbol, price } of readings) {
      if (!Number.isFinite(price) || price <= 0) continue;
      let ring = this.rings.get(symbol);
      if (!ring) this.rings.set(symbol, (ring = []));
      const last = ring[ring.length - 1];
      if (last && at - last.at < MIN_GAP_MS) {
        last.price = price;
        continue;
      }
      if (last && at < last.at) continue; // a late arrival never rewrites history
      ring.push({ at, price });
      const cut = at - KEEP_MS;
      let drop = 0;
      while (drop < ring.length - 1 && ring[drop + 1].at <= cut) drop++;
      if (drop) ring.splice(0, drop);
    }
  }

  /** Minutes of history the oldest market has, for the "warming up" note. */
  historyMinutes(now: number): number {
    let oldest = now;
    for (const ring of this.rings.values()) if (ring.length && ring[0].at < oldest) oldest = ring[0].at;
    return Math.max(0, Math.floor((now - oldest) / 60_000));
  }

  private change(ring: Sample[], now: number, windowMin: number): number | null {
    const last = ring[ring.length - 1];
    if (!last || now - last.at > SLACK_MS) return null; // the market stopped updating: no figure is better than a stale one
    const start = now - windowMin * 60_000;
    let base: Sample | null = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].at <= start) {
        base = ring[i];
        break;
      }
    }
    if (!base || start - base.at > SLACK_MS) return null;
    return (last.price / base.price - 1) * 100;
  }

  /** Every market with at least one known window, biggest mover first. */
  movers(now: number, limit = 40): MoverRow[] {
    const rows: MoverRow[] = [];
    for (const [symbol, ring] of this.rings) {
      const last = ring[ring.length - 1];
      if (!last) continue;
      const ch5 = this.change(ring, now, 5);
      const ch15 = this.change(ring, now, 15);
      const ch60 = this.change(ring, now, 60);
      const known = [ch5, ch15, ch60].filter((v): v is number => v !== null);
      if (!known.length) continue;
      rows.push({ symbol, price: last.price, ch5, ch15, ch60, peak: Math.max(...known.map(Math.abs)) });
    }
    rows.sort((a, b) => b.peak - a.peak);
    return rows.slice(0, limit);
  }
}
