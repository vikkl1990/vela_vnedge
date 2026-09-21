/**
 * Mark price + funding state per symbol (phase 2). Fed by the `mark_price` and `funding_rate`
 * websocket channels; the paper engine reads marks for liquidation and the funding scheduler
 * (`dueFunding`) hands out one charge per symbol per funding timestamp.
 */
import { EventEmitter } from 'node:events';
import type { WsFunding, WsMark } from '../delta/ws.ts';

export interface MarkState { markPrice: number; at: number; bestBid: number | null; bestAsk: number | null }
export interface FundingState {
  /** Percent per funding interval (Delta convention: 0.01 = 0.01 %). Positive → longs pay shorts. */
  ratePct: number;
  predictedRatePct: number | null;
  intervalSec: number;
  /** Next funding realization (epoch ms). */
  nextAt: number;
  /** When the rate was last received (epoch ms). */
  at: number;
  /** Last realization timestamp that was charged (epoch ms). */
  lastChargedAt: number | null;
}
export interface FundingCharge { symbol: string; ratePct: number; at: number }

export const FUNDING_INTERVAL_MS = 8 * 3600 * 1000;

export class MarkStore extends EventEmitter {
  private marks = new Map<string, MarkState>();
  private fundingBySymbol = new Map<string, FundingState>();

  setMark(symbol: string, markPrice: number, at = Date.now(), bestBid: number | null = null, bestAsk: number | null = null): void {
    if (!(markPrice > 0)) return;
    const prev = this.marks.get(symbol);
    if (prev && at < prev.at) return;
    this.marks.set(symbol, { markPrice, at, bestBid, bestAsk });
    this.emit('mark', { symbol, markPrice, at });
  }
  /**
   * Executable side of a fresh top-of-book: `buy` → ask, `sell` → bid.
   * Returns null when there is no quote, it is stale, or it is crossed/invalid.
   */
  executable(symbol: string, side: 'buy' | 'sell', maxAgeMs: number, now = Date.now()): number | null {
    const q = this.marks.get(symbol);
    if (!q || q.bestBid === null || q.bestAsk === null) return null;
    if (!(q.bestBid > 0 && q.bestAsk > 0 && q.bestBid <= q.bestAsk)) return null;
    if (maxAgeMs > 0 && now - q.at > maxAgeMs) return null;
    return side === 'buy' ? q.bestAsk : q.bestBid;
  }

  onWsMark(m: WsMark): void { this.setMark(m.symbol, m.markPrice, m.timeMs, m.bestBid, m.bestAsk); }
  mark(symbol: string): number | undefined { return this.marks.get(symbol)?.markPrice; }
  markState(symbol: string): MarkState | undefined { return this.marks.get(symbol); }
  /** Quoted spread in bps; null when no quotes. */
  spreadBps(symbol: string): number | null {
    const m = this.marks.get(symbol);
    if (!m || m.bestBid === null || m.bestAsk === null || !(m.bestBid > 0)) return null;
    return (m.bestAsk - m.bestBid) / ((m.bestAsk + m.bestBid) / 2) * 10_000;
  }

  setFunding(symbol: string, f: { ratePct: number; predictedRatePct?: number | null; intervalSec?: number; nextAt: number; at?: number }): void {
    const prev = this.fundingBySymbol.get(symbol);
    const intervalSec = f.intervalSec && f.intervalSec > 0 ? f.intervalSec : FUNDING_INTERVAL_MS / 1000;
    const at = f.at ?? Date.now();
    let nextAt = f.nextAt > 0 ? f.nextAt : prev?.nextAt ?? nextFundingAfter(at, intervalSec);
    // Delta keeps publishing the previous realization for a moment after it passed; never re-charge a charged slot.
    if (prev?.lastChargedAt !== null && prev?.lastChargedAt !== undefined && nextAt <= prev.lastChargedAt) nextAt = prev.lastChargedAt + intervalSec * 1000;
    this.fundingBySymbol.set(symbol, { ratePct: f.ratePct, predictedRatePct: f.predictedRatePct ?? null, intervalSec, nextAt, at, lastChargedAt: prev?.lastChargedAt ?? null });
    this.emit('funding', { symbol, ratePct: f.ratePct, nextAt });
  }
  onWsFunding(f: WsFunding): void { this.setFunding(f.symbol, { ratePct: f.ratePct, predictedRatePct: f.predictedRatePct, intervalSec: f.intervalSec, nextAt: f.nextAt, at: f.timeMs }); }
  funding(symbol: string): FundingState | undefined { return this.fundingBySymbol.get(symbol); }

  /**
   * Charges that became due by `now`: one per symbol per realization timestamp, with the rate
   * in force at that time. Advances the schedule so each slot is returned exactly once; if the
   * feed was silent for several slots only the most recent one is charged.
   */
  dueFunding(now = Date.now()): FundingCharge[] {
    const out: FundingCharge[] = [];
    for (const [symbol, f] of this.fundingBySymbol) {
      while (f.nextAt > 0 && f.nextAt <= now) {
        const at = f.nextAt;
        const next = at + f.intervalSec * 1000;
        if (next <= now) { f.nextAt = next; continue; }
        out.push({ symbol, ratePct: f.ratePct, at });
        f.lastChargedAt = at;
        f.nextAt = next;
      }
    }
    return out;
  }

  snapshot(): Record<string, { markPrice: number | null; at: number; funding: FundingState | null }> {
    const out: Record<string, { markPrice: number | null; at: number; funding: FundingState | null }> = {};
    for (const [s, m] of this.marks) out[s] = { markPrice: m.markPrice, at: m.at, funding: this.fundingBySymbol.get(s) ?? null };
    for (const [s, f] of this.fundingBySymbol) if (!out[s]) out[s] = { markPrice: null, at: 0, funding: f };
    return out;
  }
}

/** Next Delta funding realization strictly after `at` (multiples of the interval from the UTC epoch: 00:00/08:00/16:00 UTC). */
export function nextFundingAfter(at: number, intervalSec = FUNDING_INTERVAL_MS / 1000): number {
  const ms = intervalSec * 1000;
  return Math.floor(at / ms) * ms + ms;
}
