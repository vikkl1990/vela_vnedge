import { classOf } from '../markets/classes.ts';
import type { ScreenResult } from './cycle.ts';

export interface ResearchScreen { scannerId: string; symbol: string; tf: string; result: ScreenResult }
export interface ResearchFit { score: number; markets: number; trades: number; reason: string }

/** Research ordering only. Use other markets' TRAINING halves, never the target's
 * result, held-out returns, paper P&L or a class-wide admission veto. Callers must
 * supply only fresh screens matching the current source, reader and policy. */
export function researchFits(screens: ResearchScreen[]) {
  const groups = new Map<string, ResearchScreen[]>();
  const key = (id: string, symbol: string, tf: string) => {
    const c = classOf(symbol);
    // Stocks, metals and energy are different instruments, not one performance pool.
    return JSON.stringify([id, tf, c.group, c.group === 'tradfi' ? c.sector : null]);
  };
  for (const s of screens) {
    const r = s.result;
    if (!(r.trades > 0) || !Number.isFinite(r.trades)
      || !Number.isFinite(r.avgR1) || !Number.isFinite(r.avgR2)) continue;
    const k = key(s.scannerId, s.symbol, s.tf);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return (id: string, symbol: string, tf: string): ResearchFit => {
    const peers = (groups.get(key(id, symbol, tf)) ?? []).filter(s => s.symbol !== symbol);
    const trades = peers.reduce((n, s) => n + s.result.trades, 0);
    // Equal market weights prevent a busy coin dominating the class. Bound each
    // contribution and shrink small peer sets toward unknown (zero).
    const score = peers.reduce((n, s) => n + Math.max(-1, Math.min(1,
      Math.min(s.result.avgR1!, s.result.avgR2!))), 0) / (peers.length + 3);
    return { score, markets: peers.length, trades, reason: peers.length
      ? `${peers.length} other markets, same class/TF and current policy; training halves only`
      : 'No matching peer history; explore this scanner/market/TF' };
  };
}

export interface ResearchCell { id: string; symbol: string }
export const researchCellKey = (id: string, symbol: string) => JSON.stringify([id, symbol]);

/** An explicit batch is a set of cells, not the Cartesian product of its columns. */
export function parseResearchCells(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const cells: unknown = JSON.parse(raw);
  if (!Array.isArray(cells) || !cells.length || cells.some(c => !c || typeof c.id !== 'string'
    || !c.id || typeof c.symbol !== 'string' || !/^[A-Z0-9]+USD$/.test(c.symbol)))
    throw new Error('Invalid explicit research cells');
  return new Set(cells.map(c => researchCellKey(c.id, c.symbol)));
}
