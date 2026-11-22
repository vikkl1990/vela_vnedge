import type { AppConfig } from '../config.ts';
import { scannerPairs } from '../scanners/allocation.ts';

/** Entry origin is frozen in admission receipts; current allocations describe only today's fleet. */
export type TradeSource = 'own' | 'copy' | 'unknown';
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

/** Correlated read over retained admission receipts, never today's allocation or pilot scale. */
export const entryOriginSql = `(SELECT d.snapshot FROM decision_trace d WHERE d.position_id=p.id AND d.book=0
  AND d.scanner_id=p.scanner_id AND d.symbol=p.symbol AND d.tf=p.tf AND d.signal_id IS p.signal_id
  AND d.stage IN ('pending','opened','reversed') ORDER BY d.id LIMIT 1)`;
const parsed = (v: unknown): any => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
export function entryOrigin(fills: unknown, receipt: unknown): { fleetSource: TradeSource; entrySizeScale: number | null } {
  const meta = parsed(fills), trace = parsed(receipt), origin = trace?.entryOrigin;
  const features = meta?.features ?? meta?.limitEntry?.features ?? meta?.pendingEntry?.features ?? meta?.reclaimSetup?.features;
  const scale = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? v : null;
  if (origin?.version === 1 && ['own','copy'].includes(origin.source)) {
    if (origin.source === 'own' && features?.copy_pilot === 1) return { fleetSource: 'unknown', entrySizeScale: null };
    return { fleetSource: origin.source, entrySizeScale: scale(origin.sizeScale) };
  }
  // Legacy copy_pilot is positive entry-time evidence; its absence does not prove own-list origin.
  if (features?.copy_pilot === 1) return { fleetSource: 'copy', entrySizeScale: trace?.version === 3 ? scale(trace.sizeScale) : null };
  return { fleetSource: 'unknown', entrySizeScale: null };
}

export interface FleetEntry { scannerId: string; symbol: string; tf: string; fleetSource: TradeSource }

export function paperFleet(cfg: FleetConfig, entries: FleetEntry[], now: number, days: number) {
  const own = ownCellKeys(cfg);
  const ownCells = [...own].sort().map((k) => { const [scannerId, symbol, tf] = k.split('|'); return { scannerId, symbol, tf }; });
  const ownScanners = new Set(ownCells.map((c) => c.scannerId));
  // enabled and visible, but nothing allocated: switched on, runs nothing
  const idle = Object.entries(cfg.scanners).filter(([id, sc]) => sc?.enabled && !sc.hidden && !ownScanners.has(id)).map(([id]) => id).sort();
  let ownEntries = 0, copyEntries = 0, unknownEntries = 0;
  const copyScanners = new Set<string>(), ownTraded = new Set<string>();
  for (const e of entries) {
    if (e.fleetSource === 'own') { ownEntries++; ownTraded.add(e.scannerId); }
    else if(e.fleetSource === 'copy') { copyEntries++; copyScanners.add(e.scannerId); }
    else unknownEntries++;
  }
  const m = cfg.incubator.mirror;
  return {
    at: now,
    own: { scanners: ownScanners.size, pairs: ownCells.length },
    ownCells,
    idle,
    window: { days, entries: { own: ownEntries, copy: copyEntries, unknown: unknownEntries, total: ownEntries + copyEntries + unknownEntries }, ownScanners: ownTraded.size, copyScanners: copyScanners.size },
    copy: {
      enabled: !!m?.enabled,
      sizeScale: m?.pilot?.sizeScale ?? null,
      minTrades: m?.minTrades ?? null,
      minNetR: m?.minNetR ?? null,
    },
  };
}
export type PaperFleet = ReturnType<typeof paperFleet>;
