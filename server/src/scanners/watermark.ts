/**
 * The live window of a scanner run (decision 125). A run is dispatched per closed bar, but a bar that closes
 * while the previous run is still going is deferred and only the newest request survives; a deep queue skips
 * bars outright. The run that finally happens used to read events from its last bar only, so a script exit
 * raised on a superseded bar was never seen. Each pair now remembers the last bar it acted on, and a run reads
 * every bar after it, up to the few bars the live job evaluates. Entries on a superseded bar are still dropped:
 * they are stale by definition and the engine would refuse them. Exits and information pass.
 */
import { TF_SECONDS } from '../config.ts';

/** How many bars behind the last one a run may reach back: the live job evaluates the last three. */
export const LOOKBACK_BARS = 2;

/**
 * Decision 193: a run after a stall reaches back to the bar after the watermark, up to this many bars; the job is asked
 * for that many bars of output (it used to return only the last three, so an exit further back was gone before the
 * watermark could ask for it). A gap beyond the cap is reported as missing history.
 */
export const MAX_CATCHUP_BARS = 48;

/** The window a run should read: from which bar, how many bars of output the job must return, and how many bars fall beyond reach. */
export function liveWindow(mark: number | undefined, lastBarTime: number, tf: string, cap = MAX_CATCHUP_BARS): { since: number; tailBars: number; missed: number } {
  const tfMs = (TF_SECONDS[tf] ?? 0) * 1000;
  if (mark === undefined || !tfMs || mark >= lastBarTime) return { since: lastBarTime, tailBars: LOOKBACK_BARS + 1, missed: 0 };
  const gap = Math.round((lastBarTime - mark) / tfMs);          // bars after the mark, the last one included
  const lookback = Math.min(gap - 1, cap);
  return { since: liveSince(mark, lastBarTime, tf, lookback), tailBars: Math.max(LOOKBACK_BARS + 1, lookback + 1), missed: Math.max(0, gap - 1 - cap) };
}

/** The first bar time a run should read events from, given the last bar it acted on. */
export function liveSince(mark: number | undefined, lastBarTime: number, tf: string, lookback = LOOKBACK_BARS): number {
  const tfMs = (TF_SECONDS[tf] ?? 0) * 1000;
  if (mark === undefined || !tfMs || mark >= lastBarTime) return lastBarTime;
  return Math.max(mark + tfMs, lastBarTime - lookback * tfMs);
}

export interface MarkStore { load(): Record<string, number> | undefined; save(rec: Record<string, number>): void }

/** The last bar each pair acted on, kept across restarts so a restart neither replays nor skips a bar. */
export class BarWatermark {
  private marks: Record<string, number> | null = null;
  private store: MarkStore;
  constructor(store: MarkStore) { this.store = store; }
  private all(): Record<string, number> { if (!this.marks) this.marks = this.store.load() ?? {}; return this.marks; }
  get(key: string): number | undefined { return this.all()[key]; }
  since(key: string, lastBarTime: number, tf: string): number { return liveSince(this.get(key), lastBarTime, tf); }
  /** Decision 193: the catch-up window for this pair's next run. */
  window(key: string, lastBarTime: number, tf: string): { since: number; tailBars: number; missed: number } { return liveWindow(this.get(key), lastBarTime, tf); }
  /** Record that every bar up to `barTime` has been acted on; never moves backwards. */
  advance(key: string, barTime: number): void {
    const m = this.all();
    if ((m[key] ?? -Infinity) >= barTime) return;
    m[key] = barTime;
    try { this.store.save(m); } catch { /* the in-memory mark still holds for this process */ }
  }
}
