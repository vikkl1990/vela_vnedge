/**
 * Decision 286: propose shadow "own exits" research plans. Read-only: it reads a copy of the config, validates the result with
 * the same validator the config save uses, and writes the plans to add as JSON. It never writes the config; applying the
 * file is a separate, deliberate step through the config route.
 *
 * Usage: CONFIG=config.json OUT=own-exits-plans.json [GRADES=ownledger.json] [IDS=a,b,c] [MARKETS=BTCUSD,ETHUSD] [TFS=4h,1h] node src/cli/ownexitsplans.ts
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

/** Plans to add, in priority order (slower timeframe first, then the deeper market), for cells not already covered. */
export function proposeOwnExitsPlans(cfg: AppConfig, ids: string[], markets: string[], tfs: string[], referenceEquity: number, notReplicable: ReadonlySet<string> = new Set()): { add: ExecutionPlan[]; dropped: string[]; skipped: string[]; free: number; errors: string[] } {
  const existing = cfg.executionPlans ?? [];
  const have = new Set(existing.map(p => `${p.scannerId}|${p.symbol}|${p.tf}|${p.exitPolicy ?? ''}`));
  const wanted: ExecutionPlan[] = [];
  // a script that exits in parts cannot be replayed by a plan (it would hold the whole position to the author's last exit), so its
  // own-ledger edge says nothing about the plan: it is named, never proposed
  const skipped = ids.filter(id => notReplicable.has(id));
  ids = ids.filter(id => !notReplicable.has(id));
  for (const tf of tfs) for (const symbol of markets) for (const scannerId of ids) {
    if (have.has(`${scannerId}|${symbol}|${tf}|own-exits`)) continue;
    wanted.push({ id: `own-${scannerId}-${symbol.toLowerCase()}-${tf}`.slice(0, 80).replace(/-+$/, ''), revision: 1, enabled: true, scannerId, symbol, tf, variant: 'current',
      referenceEquity, exitPolicy: 'own-exits', label: `Own exits: ${scannerId} ${symbol} ${tf}` });
  }
  const free = Math.max(0, MAX_RESEARCH_PLANS - existing.length), add = wanted.slice(0, free);
  const dropped = wanted.slice(free).map(p => p.id);
  const errors = validateExecutionPlans([...existing, ...add], TF_SECONDS, cfg);
  return { add, dropped, skipped, free, errors };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  if (!process.env.CONFIG || !process.env.OUT) { console.error('CONFIG=<config.json copy> and OUT=<file> are required'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, 'utf8')) as AppConfig;
  const ids = (process.env.IDS?.split(',').filter(Boolean)) ?? OWN_EXITS_SURVIVORS;
  const markets = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(','), tfs = (process.env.TFS ?? '4h,1h').split(',');
  const equity = Number(process.env.REFERENCE_EQUITY ?? (cfg.executionPlans ?? []).find(p => p.referenceEquity > 0)?.referenceEquity ?? 1000);
  const missing = ids.filter(id => !cfg.scanners[id]);
  if (missing.length) console.error(`not in this config's scanners (plans still proposed, they read the script directly): ${missing.join(', ')}`);
  // GRADES=ownledger.json (the CLI's output) names the scripts whose ledger uses partial exits; they are left out
  const grades = process.env.GRADES ? JSON.parse(fs.readFileSync(process.env.GRADES, 'utf8')).results as Array<{ id: string; verdict?: { replicable?: boolean } }> : [];
  const notReplicable = new Set(grades.filter(g => g.verdict?.replicable === false).map(g => g.id));
  if (!process.env.GRADES) console.error('no GRADES file: partial-exit scripts cannot be told apart, run cli/ownledger.ts first and pass its output as GRADES');
  const r = proposeOwnExitsPlans(cfg, ids, markets, tfs, equity, notReplicable);
  if (r.skipped.length) console.log(`left out, partial exits the plans cannot replicate: ${r.skipped.join(', ')}`);
  console.log(`existing plans ${(cfg.executionPlans ?? []).length} of ${MAX_RESEARCH_PLANS} | free ${r.free} | proposing ${r.add.length} | does not fit ${r.dropped.length}`);
  if (r.dropped.length) console.log(`does not fit: ${r.dropped.join(', ')}`);
  if (r.errors.length) { console.error(`the result would not validate:\n  ${r.errors.join('\n  ')}`); process.exit(1); }
  fs.writeFileSync(process.env.OUT, JSON.stringify({ add: r.add, dropped: r.dropped }, null, 1));
  console.log(`wrote ${process.env.OUT} (nothing applied)`);
}
