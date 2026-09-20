import fs from 'node:fs';
import path from 'node:path';
import { PINE_DIR, SCRIPTS_DIR } from '../config.ts';
import { applyPatches } from '../pine/patches.ts';

export type ScannerStatus = 'ok' | 'incompatible' | 'unavailable';

export interface ScannerMeta {
  id: string;
  name: string;
  author: string;
  file: string;
  url: string;
  pub: string | null;
  access: string | null;
  pineVersion: string | null;
  lines: number | null;
  updated: string | null;
  status: ScannerStatus;
  reason: string | null;
  overlay: boolean;
  category: string;
}

export interface LoadedScanner extends ScannerMeta {
  source: string;
  patched: string;
  patches: string[];
}

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/liquidity|sweep|smart money|ict|mirage|pools/i, 'Liquidity / SMC'],
  [/volume profile|s\/r|zones|channels/i, 'Volume / Levels'],
  [/breakout|squeeze/i, 'Breakout'],
  [/momentum|fusion|classifier|radar|spectral|nexus/i, 'Momentum'],
  [/fib|elliott|abcd|harmonic|pivot|structure|vwap|strat/i, 'Structure / Fib'],
  [/trend|trail|supertrend|ichimoku|cloud|sniper|volatility|meridian/i, 'Trend'],
];

export function categorize(name: string): string {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return 'Other';
}

/** Loads `scripts/manifest.json` + Pine sources, applying compatibility patches. */
export class ScannerRegistry {
  private map = new Map<string, LoadedScanner>();

  constructor() { this.reload(); }

  reload(): void {
    const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as any[];
    let report: Record<string, any> = {};
    const reportFile = path.join(SCRIPTS_DIR, 'compat-report.json');
    if (fs.existsSync(reportFile)) {
      try { for (const r of JSON.parse(fs.readFileSync(reportFile, 'utf8')).rows ?? []) report[r.id] = r; } catch { report = {}; }
    }
    this.map.clear();
    for (const m of manifest) {
      const file = path.join(PINE_DIR, m.file);
      const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const { source: patched, applied } = source ? applyPatches(source, m.file) : { source: '', applied: [] };
      let status: ScannerStatus = m.status;
      let reason: string | null = m.reason ?? null;
      if (status !== 'unavailable' && report[m.id]) {
        status = report[m.id].ok ? 'ok' : 'incompatible';
        reason = report[m.id].ok ? null : `PineTS runtime: ${report[m.id].error}`;
      }
      if (!source.trim() || source.trim().length < 100) { status = 'unavailable'; reason = reason ?? 'source not published'; }
      this.map.set(m.id, {
        id: m.id, name: m.name, author: m.author ?? 'WillyAlgoTrader', file: m.file, url: m.url, pub: m.pub ?? null, access: m.access ?? null,
        pineVersion: m.pineVersion ?? null, lines: m.lines ?? null, updated: m.updated ?? null,
        status, reason, overlay: m.overlay ?? true, category: categorize(m.name),
        source, patched, patches: applied,
      });
    }
  }

  all(): LoadedScanner[] { return [...this.map.values()]; }
  get(id: string): LoadedScanner | undefined { return this.map.get(id); }
  runnable(): LoadedScanner[] { return this.all().filter(s => s.status === 'ok'); }
}
