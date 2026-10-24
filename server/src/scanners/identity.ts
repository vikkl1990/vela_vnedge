/**
 * Decision 194: a scanner's identity is what it trades, not its library id.
 *
 * The library holds byte-identical copies under different ids (14 groups on the VM on 24 October: the TradingView
 * mirror of a script beside the original, a re-import with a suffix). Each copy was screened on its own and could be
 * admitted on its own, so one strategy's evidence was counted twice under two names. The identity is the patched Pine
 * source plus every setting that changes how it is read and traded; copies with the same identity are aliases of one
 * canonical id, which the screen runs. Admitted pairs keep their own id: nothing is migrated or deleted.
 */
import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.ts';

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

export function strategyIdentity(patched: string, cfg: AppConfig, scannerId: string): string {
  const sc = cfg.scanners[scannerId];
  // a scanner with no settings reads its script the default way, as one whose settings are all defaults does
  const empty = (v: unknown) => v == null || (typeof v === 'object' && Object.keys(v as object).length === 0) ? null : v;
  const read = { sources: empty(sc?.sources), edge: sc?.edge ?? null, labels: empty(sc?.labels), invert: Boolean(sc?.invert), rule: sc?.rule ?? null, inputs: empty(sc?.inputs), timezone: sc?.timezone ?? null, exitMode: sc?.exitMode ?? 'both', exit: empty(sc?.exit), trendGate: sc?.trendGate ?? null };
  return createHash('sha1').update(patched).update('\u0000').update(stable(read)).digest('hex').slice(0, 16);
}

export interface DuplicateGroup { identity: string; canonical: string; aliases: string[] }

/**
 * Groups of scanners with one identity. The canonical id is the one the operator relies on: an enabled scanner first,
 * then one with incubator pairs, then the shortest id (the original usually carries no import suffix), then by name.
 */
export function duplicateGroups(scanners: Array<{ id: string; patched: string; status?: string }>, cfg: AppConfig, hasPairs: (id: string) => boolean = () => false): DuplicateGroup[] {
  const byIdentity = new Map<string, string[]>();
  for (const s of scanners) {
    if (s.status && s.status !== 'ok') continue;
    if (!s.patched) continue;
    const k = strategyIdentity(s.patched, cfg, s.id);
    const l = byIdentity.get(k) ?? []; l.push(s.id); byIdentity.set(k, l);
  }
  const rank = (id: string) => [cfg.scanners[id]?.enabled ? 0 : 1, hasPairs(id) ? 0 : 1, id.length] as const;
  const out: DuplicateGroup[] = [];
  for (const [identity, ids] of byIdentity) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return a < b ? -1 : 1; });
    out.push({ identity, canonical: ids[0], aliases: ids.slice(1) });
  }
  return out.sort((a, b) => b.aliases.length - a.aliases.length || (a.canonical < b.canonical ? -1 : 1));
}

/** alias id → canonical id, for every alias in the library. */
export function aliasMap(groups: DuplicateGroup[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) for (const a of g.aliases) m.set(a, g.canonical);
  return m;
}
