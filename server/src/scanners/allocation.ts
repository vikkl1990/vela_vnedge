import type {ScannerConfig} from '../config.ts';

/** Authoritative scanner allocation shared by execution, incubator and fleet accounting.
 * An explicit empty pair list means no allocation. Legacy symbols expand only over that
 * scanner's timeframes (or the configured fallback), never the incubator screening frame. */
export function scannerPairs(scanner:Partial<ScannerConfig>|undefined, fallbackTimeframes:readonly string[]):Array<{symbol:string;tf:string}> {
  if(!scanner)return [];
  const pairs=Array.isArray(scanner.pairs)?scanner.pairs:
    (scanner.symbols??[]).flatMap(symbol=>(scanner.timeframes??fallbackTimeframes).map(tf=>({symbol,tf})));
  return [...new Map(pairs.map(({symbol,tf})=>[JSON.stringify([symbol,tf]),{symbol,tf}])).values()];
}
