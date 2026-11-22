import type { AppConfig } from '../config.ts';
import { scannerPairs } from '../scanners/allocation.ts';

/**
 * Which of two kinds an entry in the paper account is (decision 323).
 * - own: the cell (scanner, market, timeframe) is on the account's own list: an enabled, visible scanner with that pair allocated,
 *   traded at full size. The same test the bound-exit job uses.
 * - copy: anything else the account took, which is a shadow cell's signal copied at the pilot size.
 * The test is made against today's allocation, so a cell moved onto the list shows its earlier trades as own.
 */
export type TradeSource = 'own' | 'copy';
type FleetConfig = Pick<AppConfig, 'scanners' | 'timeframes' | 'incubator'>;

export const cellKey = (scannerId: string, symbol: string, tf: string) => `${scannerId}|${symbol}|${tf}`;

/** Every cell on the account's own list, as keys. */
export function ownCellKeys(cfg: Pick<AppConfig, 'scanners' | 'timeframes'>): Set<string> {
  const keys = new Set<string>();
  for (const [id, sc] of Object.entries(cfg.scanners)) {
    if (!sc?.enabled || sc.hidden) continue;
    for (const p of scannerPairs(sc, cfg.timeframes)) keys.add(cellKey(id, p.symbol, p.tf));
  }
  return keys;
}

export function sourceOf(own: ReadonlySet<string>, scannerId: string, symbol: string, tf: string): TradeSource {
  return own.has(cellKey(scannerId, symbol, tf)) ? 'own' : 'copy';
}

export interface FleetEntry { scannerId: string; symbol: string; tf: string }

export function paperFleet(cfg: FleetConfig, entries: FleetEntry[], now: number, days: number) {
  const own = ownCellKeys(cfg);
  const ownCells = [...own].sort().map((k) => { const [scannerId, symbol, tf] = k.split('|'); return { scannerId, symbol, tf }; });
  const ownScanners = new Set(ownCells.map((c) => c.scannerId));
  // enabled and visible, but nothing allocated: switched on, runs nothing
  const idle = Object.entries(cfg.scanners).filter(([id, sc]) => sc?.enabled && !sc.hidden && !ownScanners.has(id)).map(([id]) => id).sort();
  let ownEntries = 0, copyEntries = 0;
  const copyScanners = new Set<string>(), ownTraded = new Set<string>();
  for (const e of entries) {
    if (own.has(cellKey(e.scannerId, e.symbol, e.tf))) { ownEntries++; ownTraded.add(e.scannerId); }
    else { copyEntries++; copyScanners.add(e.scannerId); }
  }
  const m = cfg.incubator.mirror;
  return {
    at: now,
    own: { scanners: ownScanners.size, pairs: ownCells.length },
    ownCells,
    idle,
    window: { days, entries: { own: ownEntries, copy: copyEntries, total: ownEntries + copyEntries }, ownScanners: ownTraded.size, copyScanners: copyScanners.size },
    copy: {
      enabled: !!m?.enabled,
      sizeScale: m?.pilot?.sizeScale ?? null,
      minTrades: m?.minTrades ?? null,
      minNetR: m?.minNetR ?? null,
    },
  };
}
export type PaperFleet = ReturnType<typeof paperFleet>;
