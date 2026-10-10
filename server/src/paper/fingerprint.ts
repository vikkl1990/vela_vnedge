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

/** What decided this trade: a short hash plus the parts, so the hash can be explained. */
export function configFingerprint(cfg: AppConfig, scannerId: string, tf: string): { fp: string; parts: Record<string, unknown> } {
  const sc = cfg.scanners[scannerId] ?? {};
  const p = cfg.paper, r = cfg.risk;
  const parts = {
    sha: repoSha(), scanner: scannerId, tf,
    read: { sources: sc.sources ?? null, labels: sc.labels ?? null, invert: Boolean(sc.invert), edge: sc.edge ?? null, rule: sc.rule ?? null, inputs: sc.inputs ?? null, timezone: sc.timezone ?? null, exitMode: sc.exitMode ?? null, exit: sc.exit ?? null, trendGate: sc.trendGate ?? null },
    stops: { fallbackAtrSl: p.fallbackAtrSl, fallbackRR: p.fallbackRR, tpSplit: p.tpSplit, trailAfterR: p.trailAfterR, trailGiveBackPct: p.trailGiveBackPct, floorAtR: p.floorAtR, floorKeepR: p.floorKeepR, breakEvenAfterTp1: p.breakEvenAfterTp1, maxStopLossPct: p.maxStopLossPct },
    fills: { fillSource: p.fillSource, latencyMs: p.latencyMs, slippageBps: p.slippageBps, useSpread: p.useSpread, minRiskFeeRatio: p.minRiskFeeRatio, sizingMode: p.sizingMode, riskPerTradePct: p.riskPerTradePct },
    gates: { regime: r.regime ?? null, market: r.marketGate ? { minTurnoverUsd: r.marketGate.minTurnoverUsd, maxBookCostPct: r.marketGate.maxBookCostPct, minAtrFeeMult: r.marketGate.minAtrFeeMult, minTrades: r.marketGate.minTrades, minPf: r.marketGate.minPf } : null, reentryCooldownMinutes: r.reentryCooldownMinutes ?? null, burstWindowSec: r.burstWindowSec ?? null },
  };
  return { fp: createHash('sha1').update(stable(parts)).digest('hex').slice(0, 12), parts };
}
