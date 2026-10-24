/**
 * Decision 194: shadow pairs that are one exposure under two names.
 *
 * Different scanners can trade the same moves (on 24 October psol-01-donchian-channels and
 * dnse-vn301-donchian-break-out-strategy had 20 shadow trades on the same symbol, timeframe and side, entered within
 * five seconds of each other). Judged pair by pair, each looks like independent evidence. This report clusters pairs
 * whose entries coincide, so the evidence and the exposure can be read per cluster. It does not judge or retire anyone.
 */
import type { Db } from '../db.ts';

export interface OverlapLink { a: string; b: string; symbol: string; tf: string; shared: number; aTrades: number; bTrades: number; share: number }
export interface OverlapCluster { members: string[]; links: OverlapLink[]; trades: number; sharedTrades: number }

/** Pairs (scanner|symbol|tf) whose entries on the same side land within `withinMs` of each other, with at least `minShared` such trades and `minShare` of the smaller pair's trades. */
export function overlapClusters(db: Db, opts: { since: number; book?: number; withinMs?: number; minShared?: number; minShare?: number }): OverlapCluster[] {
  const within = opts.withinMs ?? 5000, minShared = opts.minShared ?? 5, minShare = opts.minShare ?? 0.5;
  const rows = db.all<{ scanner_id: string; symbol: string; tf: string; side: string; entry_at: number }>(
    "SELECT scanner_id, symbol, tf, side, entry_at FROM positions WHERE bt=? AND status IN ('open','closed') AND entry_at >= ? ORDER BY symbol, tf, side, entry_at", opts.book ?? 2, opts.since);
  const count = new Map<string, number>();
  const shared = new Map<string, number>();
  const cellOf = (r: { scanner_id: string; symbol: string; tf: string }) => `${r.scanner_id}|${r.symbol}|${r.tf}`;
  for (const r of rows) count.set(cellOf(r), (count.get(cellOf(r)) ?? 0) + 1);
  // rows are sorted by market, side and time: compare each entry with the ones just after it
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const seen = new Set<string>();
    for (let j = i + 1; j < rows.length; j++) {
      const q = rows[j];
      if (q.symbol !== r.symbol || q.tf !== r.tf || q.side !== r.side || q.entry_at - r.entry_at > within) break;
      if (q.scanner_id === r.scanner_id || seen.has(q.scanner_id)) continue;
      seen.add(q.scanner_id);
      const [a, b] = [cellOf(r), cellOf(q)].sort();
      shared.set(`${a}\u0000${b}`, (shared.get(`${a}\u0000${b}`) ?? 0) + 1);
    }
  }
  const links: OverlapLink[] = [];
  for (const [k, n] of shared) {
    const [a, b] = k.split('\u0000');
    const na = count.get(a) ?? 0, nb = count.get(b) ?? 0, share = n / Math.max(1, Math.min(na, nb));
    if (n < minShared || share < minShare) continue;
    const [, symbol, tf] = a.split('|');
    links.push({ a, b, symbol, tf, shared: n, aTrades: na, bTrades: nb, share });
  }
  // union-find over the links
  const parent = new Map<string, string>();
  const find = (x: string): string => { let p = parent.get(x) ?? x; if (p !== x) { p = find(p); parent.set(x, p); } return p; };
  for (const l of links) { const ra = find(l.a), rb = find(l.b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map<string, OverlapCluster>();
  for (const l of links) {
    const root = find(l.a);
    const g = groups.get(root) ?? { members: [], links: [], trades: 0, sharedTrades: 0 };
    for (const m of [l.a, l.b]) if (!g.members.includes(m)) { g.members.push(m); g.trades += count.get(m) ?? 0; }
    g.links.push(l); g.sharedTrades += l.shared;
    groups.set(root, g);
  }
  return [...groups.values()].map(g => ({ ...g, members: g.members.sort() })).sort((x, y) => y.sharedTrades - x.sharedTrades);
}
