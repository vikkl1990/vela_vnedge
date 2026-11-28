/**
 * Decision 195: how a scanner's outputs are read, in one place. Each caller used to assemble the reading options by
 * hand — channels, edge, label allow-list, inversion — and they drifted: the account's live path left out the bar
 * length the shadow path passed, and none passed the scanner's own title contract or its rule inputs. Every production
 * path that turns a script's outputs into trades now asks here.
 */
import { TF_SECONDS, type ScannerConfig } from '../config.ts';
import { declaredChannels, type ExtractOptions } from './extractor.ts';
import type { RuleContext } from './rules.ts';

const declaredCache = new Map<string, { src: string; set: ReturnType<typeof declaredChannels> }>();

/**
 * Decision 338: whether this scanner's signals are faded on this timeframe. `invertTfs`, when set, names the timeframes
 * that are faded and replaces `invert` (a scanner can fade its 5m signals and follow its 1h ones); otherwise `invert`.
 */
export function invertOn(sc: Partial<ScannerConfig> | undefined, barMs: number | undefined): boolean | undefined {
  if (sc?.invertTfs && barMs && barMs > 0) {
    const tf = Object.entries(TF_SECONDS).find(([, s]) => s * 1000 === barMs)?.[0];
    return tf ? sc.invertTfs.includes(tf) : sc.invert;
  }
  return sc?.invert;
}

export function readingOf(sc: Partial<ScannerConfig> | undefined, scannerId: string, barMs: number | undefined, patched?: string, variantOf?: string): {
  extract: Pick<ExtractOptions, 'scannerId' | 'barMs' | 'sources' | 'edge' | 'labels' | 'invert' | 'sides' | 'labelStyles' | 'declared' | 'reader'>;
  rule: Pick<RuleContext, 'rule' | 'inputs' | 'pin' | 'ruleFor'>;
} {
  let declared: ReturnType<typeof declaredChannels> | undefined;
  if (patched) {
    const c = declaredCache.get(scannerId);
    if (c && c.src === patched) declared = c.set;
    else { declared = declaredChannels(patched); declaredCache.set(scannerId, { src: patched, set: declared }); }
  }
  return {
    extract: { scannerId, barMs: barMs && barMs > 0 ? barMs : undefined, sources: sc?.sources, edge: sc?.edge, labels: sc?.labels, invert: invertOn(sc, barMs), sides: sc?.sides, labelStyles: sc?.labelStyles, declared, reader: sc?.reader },
    rule: { rule: sc?.rule ?? null, inputs: sc?.inputs, pin: sc?.rulePin ?? null, ruleFor: variantOf },
  };
}
