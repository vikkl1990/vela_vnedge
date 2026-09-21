/**
 * Consensus filter: require `minScanners` distinct scanners to call the same side on the same
 * symbol×timeframe within `windowBars` bars before an entry is allowed. Off by default.
 *
 * The scanner engine calls `shouldEnter(candidate)` for every live entry BEFORE the paper
 * engine sees it; the candidate is recorded first, so the N-th agreeing scanner on a bar is the
 * one that passes (earlier ones on the same bar are rejected with `consensus k/N`). Scanners
 * that emit identical signals on identical bars therefore count as agreement, not as
 * duplicates — pair this with a duplicate-scanner review of the walk-forward matrix.
 */
import { TF_SECONDS, type ConsensusConfig } from '../config.ts';
import type { EntryCandidate } from '../scanners/engine.ts';

interface Vote { scannerId: string; scannerName: string; symbol: string; tf: string; side: 'long' | 'short'; barTime: number; at: number }

export class ConsensusFilter {
  private cfgRef: () => ConsensusConfig;
  private votes: Vote[] = [];
  private now: () => number;
  private maxVotes = 2000;

  constructor(cfgRef: () => ConsensusConfig, now: () => number = () => Date.now()) { this.cfgRef = cfgRef; this.now = now; }

  get config(): ConsensusConfig { return this.cfgRef(); }

  /** Remember a vote (idempotent per scanner×symbol×tf×bar×side). */
  record(c: Vote) {
    if (this.votes.some(v => v.scannerId === c.scannerId && v.symbol === c.symbol && v.tf === c.tf && v.side === c.side && v.barTime === c.barTime)) return;
    this.votes.push({ ...c });
    if (this.votes.length > this.maxVotes) this.votes.splice(0, this.votes.length - this.maxVotes);
  }

  /** Distinct scanners agreeing with the candidate within the window (including itself once recorded). */
  agreeing(c: Pick<Vote, 'symbol' | 'tf' | 'side' | 'barTime'>): string[] {
    const win = (this.config.windowBars ?? 1) * (TF_SECONDS[c.tf] ?? 900) * 1000;
    const ids = new Set<string>();
    for (const v of this.votes) if (v.symbol === c.symbol && v.tf === c.tf && v.side === c.side && Math.abs(v.barTime - c.barTime) <= win) ids.add(v.scannerId);
    return [...ids];
  }

  shouldEnter(c: EntryCandidate): { ok: boolean; reason?: string; agreeing: number; scanners: string[] } {
    this.record({ scannerId: c.scannerId, scannerName: c.scannerName, symbol: c.symbol, tf: c.tf, side: c.side, barTime: c.barTime, at: c.at ?? this.now() });
    const cfg = this.config;
    const scanners = this.agreeing(c);
    if (!cfg.enabled) return { ok: true, agreeing: scanners.length, scanners };
    const ok = scanners.length >= Math.max(1, cfg.minScanners);
    return { ok, reason: ok ? undefined : `consensus ${scanners.length}/${cfg.minScanners}`, agreeing: scanners.length, scanners };
  }

  status() {
    const cfg = this.config;
    return { enabled: cfg.enabled, minScanners: cfg.minScanners, windowBars: cfg.windowBars, votes: this.votes.length, recent: this.votes.slice(-50).reverse() };
  }
}
