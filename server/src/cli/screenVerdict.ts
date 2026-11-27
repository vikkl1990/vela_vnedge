/**
 * Judge a paper screen for selection bias (LuxAlgo Quant 2.0's checks; see validation/overfit.ts).
 *
 *   node src/cli/screenVerdict.ts SCREEN.jsonl [MORE.jsonl ...] [--policy=name] [--json=OUT.json]
 *
 * A candidate is one scanner under one screened policy, pooled across the markets of the screen. For each it reports
 * the pooled pass (>= 20 trades, profit factor >= 1.2, all three time segments positive, >= 5 holdout trades, at
 * least half its traded markets positive), and its Deflated Sharpe Ratio against the luck benchmark of every
 * candidate the screen tried. Across all candidates with 20+ trades it reports the screen's PBO: how often the
 * in-sample best lands in the bottom half out of sample. A scanner is worth trading only when it passes, its DSR is
 * at least 0.95, and the screen's PBO is low; a high PBO says the ranking itself is noise.
 *
 * Needs rows written by paperScreen.ts since it records `blocks` and `moments` per policy; older rows are skipped.
 * Read-only.
 */
import fs from 'node:fs';
import { addMoments, deflatedSharpe, emptyMoments, momentStats, pboCscv, type Moments } from '../validation/overfit.ts';

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const opt = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
if (!files.length) { console.error('usage: screenVerdict.ts SCREEN.jsonl [MORE.jsonl ...] [--policy=name] [--json=OUT.json]'); process.exit(2); }

interface Cand { key: string; id: string; name: string; policy: string; trades: number; pnl: number; gp: number; gl: number; seg: number[]; holdoutTrades: number; markets: number; marketsUp: number; moments: Moments; blocks: number[] }
const cands = new Map<string, Cand>();
let rows = 0, skipped = 0;
for (const file of files) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let r: any; try { r = JSON.parse(line); } catch { continue; }
  rows++;
  for (const [policy, v] of Object.entries<any>(r.policies ?? {})) {
    if (opt('policy') && policy !== opt('policy')) continue;
    if (!v?.trades) continue;
    if (!v.moments || !Array.isArray(v.blocks)) { skipped++; continue; }
    const key = `${r.scannerId}|${policy}`;
    const c = cands.get(key) ?? { key, id: r.scannerId, name: r.name ?? r.scannerId, policy, trades: 0, pnl: 0, gp: 0, gl: 0, seg: [0, 0, 0], holdoutTrades: 0, markets: 0, marketsUp: 0, moments: emptyMoments(), blocks: new Array(v.blocks.length).fill(0) };
    c.trades += v.trades; c.pnl += v.pnl; c.markets++; if (v.pnl > 0) c.marketsUp++;
    c.seg[0] += v.early.pnl; c.seg[1] += v.middle.pnl; c.seg[2] += v.holdout.pnl; c.holdoutTrades += v.holdout.trades;
    // gross profit and loss from each segment's PF and net, so the pooled PF is exact where the segments allow it
    for (const g of [v.early, v.middle, v.holdout]) {
      if (g.pf > 0 && g.pf < 99 && g.pnl !== 0) { const gl = g.pnl / (g.pf - 1 || 1e-9); if (Number.isFinite(gl) && gl > 0) { c.gl += gl; c.gp += gl * g.pf; continue; } }
      if (g.pnl > 0) c.gp += g.pnl; else c.gl -= g.pnl;
    }
    c.moments = addMoments(c.moments, v.moments);
    v.blocks.forEach((x: number, b: number) => { c.blocks[b] = (c.blocks[b] ?? 0) + x; });
    cands.set(key, c);
  }
}
const all = [...cands.values()];
if (!all.length) { console.log(`${rows} rows read; no candidate carries blocks and moments (${skipped} older policy rows skipped). Re-run paperScreen.ts.`); process.exit(0); }

const pf = (c: Cand) => (c.gl > 0 ? c.gp / c.gl : c.gp > 0 ? 99 : 0);
const pass = (c: Cand) => c.trades >= 20 && pf(c) >= 1.2 && c.seg.every(x => x > 0) && c.holdoutTrades >= 5 && c.marketsUp * 2 >= c.markets;
const sized = all.filter(c => c.trades >= 20);
const srs = sized.map(c => momentStats(c.moments).sr);
const srMean = srs.reduce((a, x) => a + x, 0) / Math.max(1, srs.length);
const srVariance = srs.reduce((a, x) => a + (x - srMean) ** 2, 0) / Math.max(1, srs.length - 1);
const trials = all.length;
const nBlocks = Math.max(...sized.map(c => c.blocks.length), 0);
const pbo = sized.length >= 2 && nBlocks >= 4 && nBlocks % 2 === 0
  ? pboCscv(Array.from({ length: nBlocks }, (_, b) => sized.map(c => c.blocks[b] ?? 0)))
  : { pbo: NaN, splits: 0, medianLogit: NaN };

const judged = all.filter(pass).map(c => ({ c, s: momentStats(c.moments), d: deflatedSharpe(c.moments, trials, srVariance) }))
  .sort((a, b) => b.d.dsr - a.d.dsr || b.c.pnl - a.c.pnl);
const confirmed = judged.filter(x => x.d.dsr >= 0.95);

console.log(`${rows} rows · ${trials} candidates (scanner × policy) · ${sized.length} with 20+ trades · ${skipped} older policy rows skipped`);
console.log(`luck benchmark: the best of ${trials} skill-less candidates reaches a per-trade Sharpe of ${deflatedSharpe(emptyMoments(), trials, srVariance).sr0.toFixed(3)}`);
console.log(`PBO ${Number.isNaN(pbo.pbo) ? 'n/a' : `${(pbo.pbo * 100).toFixed(0)}%`} over ${pbo.splits} splits of ${nBlocks} time blocks — ${Number.isNaN(pbo.pbo) ? 'too few candidates or blocks' : pbo.pbo < 0.2 ? 'the in-sample ranking carries out of sample' : pbo.pbo < 0.5 ? 'the ranking is weak; trust only strong DSRs' : 'the ranking is noise: in-sample winners are luck'}`);
console.log(`${judged.length} pass pooled · ${confirmed.length} also clear the Deflated Sharpe (DSR >= 95%)\n`);
console.log('scanner                             policy             trades  R/trade  SR/trade   PF   mkts+    DSR');
for (const { c, s, d } of judged.slice(0, 40)) console.log(`${c.name.slice(0, 34).padEnd(35)} ${c.policy.slice(0, 17).padEnd(18)} ${String(c.trades).padStart(6)} ${s.mean.toFixed(3).padStart(8)} ${s.sr.toFixed(3).padStart(9)} ${pf(c).toFixed(2).padStart(5)} ${`${c.marketsUp}/${c.markets}`.padStart(6)} ${(d.dsr * 100).toFixed(1).padStart(6)}%${d.dsr >= 0.95 ? ' ✓' : ''}`);
const out = opt('json');
if (out) fs.writeFileSync(out, JSON.stringify({ rows, trials, sized: sized.length, srVariance, pbo, passed: judged.map(({ c, s, d }) => ({ id: c.id, policy: c.policy, trades: c.trades, meanR: s.mean, sr: s.sr, pf: pf(c), markets: c.markets, marketsUp: c.marketsUp, dsr: d.dsr, sr0: d.sr0 })) }, null, 1));
