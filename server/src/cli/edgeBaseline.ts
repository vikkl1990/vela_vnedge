/**
 * Set the edge watch's baselines (decision 336) from paper screens: per (scanner, timeframe), the pooled mean and
 * standard deviation of R a trade under one policy, and the time from which live trades count against it.
 *
 *   node src/cli/edgeBaseline.ts SCREEN.jsonl [MORE.jsonl ...] --since=ISO [--policy=current] [--ids=a,b] [--dry]
 *
 * Needs screens written since paperScreen.ts records `moments`. Writes kv `edgeWatch.baseline` in data/vnedge.db,
 * merging with the baselines already set (a key is replaced only when this run covers it). --dry prints only.
 */
import fs from 'node:fs';
import { Db } from '../db.ts';
import { addMoments, emptyMoments, momentStats, type Moments } from '../validation/overfit.ts';
import type { Baseline } from '../analytics/edgeVerdict.ts';
import { KV } from '../ops/edgeWatch.ts';

const args = process.argv.slice(2);
const opt = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const files = args.filter(a => !a.startsWith('--'));
const since = Date.parse(opt('since') ?? '');
if (!files.length || !Number.isFinite(since)) { console.error('usage: edgeBaseline.ts SCREEN.jsonl [...] --since=ISO [--policy=current] [--ids=a,b] [--dry]'); process.exit(2); }
const policy = opt('policy') ?? 'current', ids = opt('ids') ? new Set(opt('ids')!.split(',')) : null;

const pooled = new Map<string, { m: Moments; cells: number; files: Set<string> }>();
for (const file of files) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r: any; try { r = JSON.parse(line); } catch { continue; }
  if (ids && !ids.has(r.scannerId)) continue;
  const v = r.policies?.[policy];
  if (!v?.moments || !v.trades) continue;
  const key = `${r.scannerId}|${r.tf}`;
  const p = pooled.get(key) ?? { m: emptyMoments(), cells: 0, files: new Set<string>() };
  p.m = addMoments(p.m, v.moments); p.cells++; p.files.add(file.split(/[\\/]/).pop()!);
  pooled.set(key, p);
}
const out: Record<string, Baseline> = {};
for (const [key, p] of pooled) {
  const s = momentStats(p.m);
  out[key] = { meanR: s.mean, sdR: s.sd, n: s.n, since, source: `${[...p.files].join('+')} · policy ${policy} · ${p.cells} markets` };
  console.log(`${key.padEnd(50)} ${String(s.n).padStart(5)} trades  mean ${s.mean.toFixed(3)}R  sd ${s.sd.toFixed(3)}R`);
}
if (args.includes('--dry')) process.exit(0);
const db = new Db();
db.kvSet(KV.baseline, { ...(db.kvGet<Record<string, Baseline>>(KV.baseline) ?? {}), ...out });
console.log(`set ${Object.keys(out).length} baselines (live trades count from ${new Date(since).toISOString()})`);
db.db.close();
