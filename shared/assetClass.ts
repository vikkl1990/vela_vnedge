/**
 * Asset classes for Delta markets: one group and one sector for every symbol, used by the server (reports, filters)
 * and the dashboard (chips, filters, breakdowns) so a market is never classified two ways.
 *
 * Groups are the coarse split an operator reads first:
 *   majors      BTC, ETH, SOL, XRP
 *   large_alts  the established large-cap alternative coins (list below)
 *   alts        every other crypto market that is not a meme coin
 *   meme        meme coins (Delta's `meme` tag, or the curated list when tags are not loaded)
 *   tradfi      tokenised stocks and ETFs, metals, oil
 *   other       anything this file cannot recognise as one of the above
 *
 * A sector is the second dimension inside a group (AI, DeFi, layer 1, layer 2, gaming, stocks, metals…). `tags` keeps
 * every secondary label so an AI meme coin appears under both Meme (group) and AI (tag).
 *
 * Delta's own `product_specs.tags` / `top_tag` are the primary signal because they cover new listings without a code
 * change; the curated sets only decide the majors, the large-cap split and the markets Delta leaves untagged.
 */
export type AssetGroup = 'majors' | 'large_alts' | 'alts' | 'meme' | 'tradfi' | 'other';
export type AssetSector = 'store_of_value' | 'payments' | 'layer_1' | 'layer_2' | 'defi' | 'ai' | 'gaming' | 'meme' | 'stocks' | 'metals' | 'energy' | 'other';

export interface MarketSpecs { tags?: readonly string[] | null; topTag?: string | null }
export interface AssetClass { group: AssetGroup; sector: AssetSector; tags: AssetSector[] }

export const ASSET_GROUPS: ReadonlyArray<{ key: AssetGroup; label: string; hint: string }> = [
  { key: 'majors', label: 'Majors', hint: 'BTC, ETH, SOL, XRP' },
  { key: 'large_alts', label: 'Large-cap alts', hint: 'Established large-cap alternative coins' },
  { key: 'alts', label: 'Alts', hint: 'Other crypto markets that are not meme coins' },
  { key: 'meme', label: 'Meme', hint: 'Meme coins' },
  { key: 'tradfi', label: 'Stocks & metals', hint: 'Tokenised stocks and ETFs, metals, oil' },
  { key: 'other', label: 'Other', hint: 'Markets the classifier does not recognise' },
];

export const ASSET_SECTORS: ReadonlyArray<{ key: AssetSector; label: string }> = [
  { key: 'store_of_value', label: 'Store of value' }, { key: 'payments', label: 'Payments' },
  { key: 'layer_1', label: 'Layer 1' }, { key: 'layer_2', label: 'Layer 2' },
  { key: 'defi', label: 'DeFi' }, { key: 'ai', label: 'AI' }, { key: 'gaming', label: 'Gaming & NFT' }, { key: 'meme', label: 'Meme' },
  { key: 'stocks', label: 'Stocks & ETFs' }, { key: 'metals', label: 'Metals' }, { key: 'energy', label: 'Energy' },
  { key: 'other', label: 'Unspecified' },
];

export const MAJORS: ReadonlySet<string> = new Set(['BTC', 'ETH', 'SOL', 'XRP']);
const MAJOR_SECTOR: Record<string, AssetSector> = { BTC: 'store_of_value', XRP: 'payments', ETH: 'layer_1', SOL: 'layer_1' };

/** Established large-cap alternative coins. A judgement list: edit it here and every report and filter follows. */
export const LARGE_ALTS: ReadonlySet<string> = new Set([
  'BNB', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'TRX', 'TON', 'NEAR', 'SUI', 'APT', 'AAVE', 'UNI', 'XLM', 'HBAR',
  'XMR', 'HYPE', 'ARB', 'OP', 'INJ', 'ATOM', 'ICP', 'FIL', 'ETC', 'TAO', 'POL', 'ENA', 'ONDO',
]);

/** Meme coins by name, for the moment Delta's tags are not loaded or a new meme is not yet tagged. */
const MEME_NAMES: ReadonlySet<string> = new Set([
  'DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'PEOPLE', 'POPCAT', 'TRUMP', 'MELANIA', 'FARTCOIN', 'PNUT', 'GOAT', 'NEIRO',
  'MOODENG', 'PENGU', 'BABYDOGE', 'MEME', 'BRETT', 'MOG', 'SPX', 'DOGS', 'GIGGLE', 'MUBARAK', 'AIXBT', 'VIRTUAL',
]);

/** Tradfi names for when Delta's `top_tag` is unavailable. */
const METALS: ReadonlySet<string> = new Set(['PAXG', 'XAUT', 'SLVON', 'XAU', 'XAG']);
const ENERGY: ReadonlySet<string> = new Set(['OIL', 'BRENT', 'WTI']);
const STOCK_NAMES: ReadonlySet<string> = new Set([
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'COIN', 'MSTR', 'SPY', 'QQQ', 'CRCL', 'HOOD', 'PLTR', 'AMD', 'INTC', 'TSM', 'AVGO', 'ORCL',
]);

const SECTOR_FROM_TAG: Record<string, AssetSector> = {
  ai: 'ai', defi: 'defi', layer_1: 'layer_1', smart_contracts: 'layer_1', layer_2: 'layer_2',
  gaming: 'gaming', nft: 'gaming', meme: 'meme', xstock: 'stocks', metal: 'metals',
};
// when a market carries several tags, the first of these that it has is its sector
const SECTOR_PRIORITY: AssetSector[] = ['ai', 'defi', 'layer_2', 'layer_1', 'gaming'];

/** The base asset of a Delta symbol: BTCUSD → BTC, 1000PEPEUSD → PEPE, 1MBABYDOGEUSD → BABYDOGE, AAPLBUSD → AAPLB. */
export function baseAsset(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase().replace(/(USDT|USDC|USD)$/, '');
  return s.replace(/^(1000|1M|10000)(?=[A-Z])/, '');
}

export function classifySymbol(symbol: string, specs?: MarketSpecs | null): AssetClass {
  const sym = String(symbol ?? '').toUpperCase();
  const base = baseAsset(sym);
  const rawTags = (specs?.tags ?? []).map(t => String(t).toLowerCase());
  const tags: AssetSector[] = [...new Set(rawTags.map(t => SECTOR_FROM_TAG[t]).filter((x): x is AssetSector => !!x))];
  if (!/USD[TC]?$/.test(sym) || !base) return { group: 'other', sector: 'other', tags: [] };

  // tokenised stocks, metals, oil
  const tradfi = specs?.topTag === 'tradfi' || rawTags.includes('xstock') || rawTags.includes('metal')
    || METALS.has(base) || ENERGY.has(base) || STOCK_NAMES.has(base.replace(/[BX]$/, ''));
  if (tradfi) {
    const sector: AssetSector = rawTags.includes('metal') || METALS.has(base) ? 'metals' : ENERGY.has(base) ? 'energy' : 'stocks';
    return { group: 'tradfi', sector, tags: [sector] };
  }
  if (MAJORS.has(base)) return { group: 'majors', sector: MAJOR_SECTOR[base] ?? 'layer_1', tags: [MAJOR_SECTOR[base] ?? 'layer_1'] };
  if (rawTags.includes('meme') || MEME_NAMES.has(base)) {
    return { group: 'meme', sector: 'meme', tags: [...new Set<AssetSector>(['meme', ...tags])] };
  }
  const sector = SECTOR_PRIORITY.find(s => tags.includes(s)) ?? 'other';
  return { group: LARGE_ALTS.has(base) ? 'large_alts' : 'alts', sector, tags: tags.length ? tags : [sector] };
}

export const groupLabel = (g: string): string => ASSET_GROUPS.find(x => x.key === g)?.label ?? g;
export const sectorLabel = (s: string): string => ASSET_SECTORS.find(x => x.key === s)?.label ?? s;
export const isAssetGroup = (v: unknown): v is AssetGroup => ASSET_GROUPS.some(g => g.key === v);
export const isAssetSector = (v: unknown): v is AssetSector => ASSET_SECTORS.some(s => s.key === v);

/** True when the class matches a group or sector filter; an empty filter matches everything. A sector also matches secondary tags. */
export function matchesClass(c: AssetClass, group?: string | null, sector?: string | null): boolean {
  if (group && c.group !== group) return false;
  if (sector && c.sector !== sector && !c.tags.includes(sector as AssetSector)) return false;
  return true;
}
