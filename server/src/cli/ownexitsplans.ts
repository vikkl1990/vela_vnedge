/**
 * Decision 286: propose shadow "own exits" research plans. Read-only: it reads a copy of the config, validates the result with
 * the same validator the config save uses, and writes the plans to add as JSON. It never writes the config; applying the
 * file is a separate, deliberate step through the config route.
 *
 * Usage: CONFIG=config.json OUT=own-exits-plans.json GRADES=ownledger.json [IDS=a,b,c] [MARKETS=BTCUSD,ETHUSD] [TFS=4h,1h] node src/cli/ownexitsplans.ts
 * The ten scripts that held up in the 14 Nov 2026 own-ledger study are the default. Capacity is bounded by MAX_RESEARCH_PLANS:
 * what does not fit is listed, never silently dropped.
 */
import fs from 'node:fs';
import { TF_SECONDS, type AppConfig } from '../config.ts';
import { MAX_RESEARCH_PLANS, validateExecutionPlans, type ExecutionPlan } from '../paper/executionPlans.ts';

export const OWN_EXITS_SURVIVORS = [
  'mcginley-t3-flow-campaign-nick789-v-1', 'norn-weave-thurisaz', 'dema-atr-strategy', 'rsi-divergence-ema-filter', 'btc-trend-momentum-strategy',
  'super-trend-signal-engine-strat', 'vumanchu-wt-zero-cross-strategy-v1-2-2', 'vumanchu-wt-zero-cross-strategy-v1-2-3', 'caldera-meridian-strategy', 'kpt-ahab-poor-man-s-orderflow-simple-algopilot',
];

/** Version 2 uses actual candle volume and records successful cell coverage. Older
 * study output is not proof that a proposed cell ran, passed, or is replicable. */
export interface OwnExitGrades {
  version: 2;
  results: Array<{ id: string; error?: string; errors?: string[]; cells?: Array<{symbol:string;tf:string}>;
    verdict?: { pass?: boolean; replicable?: boolean } }>;
}

/** Plans to add, in priority order (slower timeframe first, then the deeper market), for cells not already covered. */
export function proposeOwnExitsPlans(cfg: AppConfig, ids: string[], markets: string[], tfs: string[], referenceEquity: number, grades?: OwnExitGrades): { add: ExecutionPlan[]; dropped: string[]; skipped: string[]; free: number; errors: string[] } {
  const existing = cfg.executionPlans ?? [];
  const have = new Set(existing.map(p => `${p.scannerId}|${p.symbol}|${p.tf}|${p.exitPolicy ?? ''}`));
  const wanted: ExecutionPlan[] = [];
  const skipped: string[] = [];
  for (const tf of tfs) for (const symbol of markets) for (const scannerId of ids) {
    if (have.has(`${scannerId}|${symbol}|${tf}|own-exits`)) continue;
    const matches=grades?.version===2 ? grades.results.filter(g=>g.id===scannerId) : [];
    const g=matches.length===1 ? matches[0] : undefined;
    if(!g || g.error || !Array.isArray(g.errors) || g.errors.length || g.verdict?.pass!==true || g.verdict.replicable!==true ||
      !g.cells?.some(c=>c.symbol===symbol&&c.tf===tf)) {
      skipped.push(`${scannerId}|${symbol}|${tf}`);continue;
    }
    wanted.push({ id: `own-${scannerId}-${symbol.toLowerCase()}-${tf}`.slice(0, 80).replace(/-+$/, ''), revision: 1, enabled: true, scannerId, symbol, tf, variant: 'current',
      referenceEquity, exitPolicy: 'own-exits', label: `Own exits: ${scannerId} ${symbol} ${tf}` });
  }
  const free = Math.max(0, MAX_RESEARCH_PLANS - existing.length), add = wanted.slice(0, free);
  const dropped = wanted.slice(free).map(p => p.id);
  const errors = validateExecutionPlans([...existing, ...add], TF_SECONDS, cfg);
  return { add, dropped, skipped, free, errors };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  if (!process.env.CONFIG || !process.env.OUT || !process.env.GRADES) { console.error('CONFIG=<config.json copy>, OUT=<file> and GRADES=<ownledger.json> are required'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, 'utf8')) as AppConfig;
  const ids = (process.env.IDS?.split(',').filter(Boolean)) ?? OWN_EXITS_SURVIVORS;
  const markets = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(','), tfs = (process.env.TFS ?? '4h,1h').split(',');
  const equity = Number(process.env.REFERENCE_EQUITY ?? (cfg.executionPlans ?? []).find(p => p.referenceEquity > 0)?.referenceEquity ?? 1000);
  const missing = ids.filter(id => !cfg.scanners[id]);
  if (missing.length) console.error(`not in this config's scanners (plans still proposed, they read the script directly): ${missing.join(', ')}`);
  const grades = JSON.parse(fs.readFileSync(process.env.GRADES, 'utf8')) as OwnExitGrades;
  if(grades.version!==2 || !Array.isArray(grades.results)) { console.error('Regenerate GRADES with the version 2 ownledger CLI'); process.exit(2); }
  const r = proposeOwnExitsPlans(cfg, ids, markets, tfs, equity, grades);
  if (r.skipped.length) console.log(`left out, missing passing/replicable grade or cell coverage: ${r.skipped.join(', ')}`);
  console.log(`existing plans ${(cfg.executionPlans ?? []).length} of ${MAX_RESEARCH_PLANS} | free ${r.free} | proposing ${r.add.length} | does not fit ${r.dropped.length}`);
  if (r.dropped.length) console.log(`does not fit: ${r.dropped.join(', ')}`);
  if (r.errors.length) { console.error(`the result would not validate:\n  ${r.errors.join('\n  ')}`); process.exit(1); }
  fs.writeFileSync(process.env.OUT, JSON.stringify({ add: r.add, dropped: r.dropped, skipped:r.skipped }, null, 1));
  console.log(`wrote ${process.env.OUT} (nothing applied)`);
}
