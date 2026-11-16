/**
 * Server side of the asset classes (shared/assetClass.ts): Delta's per-market tags are remembered when the product
 * list loads, and every report, filter and API answer classifies through `classOf` so a market has one class everywhere.
 */
import type { Db } from '../db.ts';
import { classifySymbol, matchesClass, type AssetClass, type MarketSpecs } from '../../../shared/assetClass.ts';

export { classifySymbol, matchesClass } from '../../../shared/assetClass.ts';
export type { AssetClass } from '../../../shared/assetClass.ts';

const specs = new Map<string, MarketSpecs>();

/** Remember each product's Delta tags. Replaces the whole set: a delisted market keeps no stale tags. */
export function registerProductSpecs(products: Iterable<{ symbol: string; product_specs?: { tags?: string[] | null; top_tag?: string | null } | null }>): void {
  const next = new Map<string, MarketSpecs>();
  for (const p of products) {
    const s = p.product_specs;
    next.set(p.symbol.toUpperCase(), { tags: Array.isArray(s?.tags) ? s.tags.filter(t => typeof t === 'string') : [], topTag: typeof s?.top_tag === 'string' ? s.top_tag : null });
  }
  if (!next.size) return;
  specs.clear();
  for (const [k, v] of next) specs.set(k, v);
}

export const classOf = (symbol: string): AssetClass => classifySymbol(symbol, specs.get(symbol.toUpperCase()));

/** The symbols the trade history knows about that match a group and/or sector filter. */
export function symbolsMatching(db: Db, group?: string, sector?: string): string[] {
  const rows = db.all<{ symbol: string }>("SELECT DISTINCT symbol FROM positions WHERE symbol IS NOT NULL AND symbol != ''");
  return rows.map(r => r.symbol).filter(s => matchesClass(classOf(s), group, sector));
}

/** A SQL fragment for `column IN (…)` that restricts rows to a group and/or sector; null when no class filter is set. */
export function classClause(db: Db, f: { group?: string; sector?: string }, column: string): { sql: string; args: string[] } | null {
  if (!f.group && !f.sector) return null;
  const symbols = symbolsMatching(db, f.group, f.sector);
  if (!symbols.length) return { sql: '1=0', args: [] };
  return { sql: `${column} IN (${symbols.map(() => '?').join(',')})`, args: symbols };
}

/** Every symbol in `symbols` with its class, for the dashboard's chips and filters. */
export function classMap(symbols: Iterable<string>): Record<string, AssetClass> {
  const out: Record<string, AssetClass> = {};
  for (const s of symbols) out[s] = classOf(s);
  return out;
}
