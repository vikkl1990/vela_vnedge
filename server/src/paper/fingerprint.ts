/**
 * Configuration history on every trade (decision 90). A trade carries a fingerprint of the settings that
 * produced it — the commit, how its scanner is read, the stop and exit policy, the gates — so a book can be
 * split into "under the current settings" and "before", and a change can be measured instead of blended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.ts';

let sha: string | null = null;
/** The commit the process runs, from the repository's .git (never from the network); 'unknown' outside a checkout. */
export function repoSha(): string {
  if (sha !== null) return sha;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) { if (fs.existsSync(path.join(dir, '.git'))) break; dir = path.dirname(dir); }
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    sha = head.startsWith('ref: ') ? fs.readFileSync(path.join(dir, '.git', head.slice(5)), 'utf8').trim().slice(0, 12) : head.slice(0, 12);
  } catch { sha = 'unknown'; }
  return sha;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * Decision 190: the simulation's own version. Bump it whenever the paper's fill or exit mechanics change in a way the
 * settings do not show (190: limits no longer fill on their placing minute, expiry is checked at the fill, a limit fill
 * keeps the scanner's stop rule), so trades before and after the change fall into different cohorts.
 */
export const SIM_VERSION = 190;

/** A short, stable hash of a scanner's patched Pine source: library imports change outside the commit. */
export function sourceHash(patched: string | undefined | null): string | null {
  return patched ? createHash('sha1').update(patched).digest('hex').slice(0, 12) : null;
}

/**
 * What decided this trade: a short hash plus the parts, so the hash can be explained.
 *
 * Decision 190: every setting of the paper engine and the risk manager is hashed, not a hand-picked list. The old list
 * left out the limit entry, fees, margin sizing, the trail steps and stall, the drawdown size rule and more, so trades
 * under different strategies shared one fingerprint. The scanner's patched source, the book and the simulation version
 * are in it too.
 */
export function configFingerprint(cfg: AppConfig, scannerId: string, tf: string, opts: { source?: string | null; book?: number } = {}): { fp: string; parts: Record<string, unknown> } {
  const parts = {
    sim: SIM_VERSION, sha: repoSha(), scanner: scannerId, tf, book: opts.book ?? null, source: opts.source ?? null,
    read: cfg.scanners[scannerId] ?? {},
    paper: cfg.paper,
    risk: cfg.risk,
  };
  return { fp: createHash('sha1').update(stable(parts)).digest('hex').slice(0, 12), parts: JSON.parse(stable(parts)) };
}
