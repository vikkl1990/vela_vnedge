/**
 * Replay the account's real closed trades under different target policies.
 *
 *   LIVE=positions.json npm run replaytargets
 *
 * Every other target test used backtest entries. This uses the trades the account actually took:
 * their real fill, stop and time, walked forward on 1m candles, with the live stop logic (stop at
 * −1R, +0.5R locked once +1R is reached, trail 60% of the peak from +1.5R), Delta's fees with GST,
 * and the Scalper Offer's free exit inside the window. Only the targets change.
 *
 * Manual closes are replaced by the rule, which is the point: it shows what each policy would have
 * done with the position, not what was done by hand.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { ConfigStore } from '../config.ts';

const paper = new ConfigStore().get().paper;
if (process.env.PAPER) Object.assign(paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const HOURS = Number(process.env.HOURS ?? 48);
const rows = JSON.parse(fs.readFileSync(process.env.LIVE!, 'utf8')).filter((p: any) => p.exit_at && p.risk_amount > 0);
const rest = new DeltaRest();

type Policy = { name: string; tps: number[]; split: number[] };
const policies: Policy[] = [
  { name: 'live: 2/4/6 R, all at TP3', tps: [2, 4, 6], split: [0, 0, 1] },
  { name: '2/3/4 R, all at TP3', tps: [2, 3, 4], split: [0, 0, 1] },
  { name: '1/2/3 R, all at TP3', tps: [1, 2, 3], split: [0, 0, 1] },
  { name: 'live targets, half at TP1', tps: [2, 4, 6], split: [0.5, 0, 0.5] },
  { name: '2/3/4 R, thirds', tps: [2, 3, 4], split: [0.34, 0.33, 0.33] },
  { name: '1/2/3 R, thirds', tps: [1, 2, 3], split: [0.34, 0.33, 0.33] },
];

const bySymbol = new Map<string, any[]>();
for (const s of new Set<string>(rows.map((r: any) => r.symbol))) {
  const es = rows.filter((r: any) => r.symbol === s);
  bySymbol.set(s, await rest.candles(s, '1m', Math.floor(Math.min(...es.map((e: any) => e.entry_at)) / 1000) - 120, Math.floor((Math.max(...es.map((e: any) => e.entry_at)) + HOURS * 3600_000) / 1000), 60_000));
}

const MAJORS = new Set(paper.scalperOffer?.majors ?? []);
const windowMin = (sym: string) => (MAJORS.has(sym) ? paper.scalperOffer?.majorsMinutes ?? 30 : paper.scalperOffer?.othersMinutes ?? 15);

/** One trade under one policy: net R after costs, plus how it ended. */
function replay(t: any, p: Policy): { r: number; why: string; mins: number } {
  const dir = t.side === 'long' ? 1 : -1;
  const risk = Math.abs(t.entry_price - t.sl_original);
  const riskPct = risk / t.entry_price * 100;
  const feeR = paper.feeRatePct * (1 + (paper.feeTaxPct ?? 0) / 100) / riskPct;
  const slipR = paper.slippageBps / 100 / riskPct;
  const waiver = paper.scalperOffer?.enabled ? windowMin(t.symbol) : 0;
  const path = (bySymbol.get(t.symbol) ?? []).filter(b => b.time * 1000 >= t.entry_at && b.time * 1000 <= t.entry_at + HOURS * 3600_000);
  const R = (x: number) => (x - t.entry_price) * dir / risk;
  let net = -(feeR + slipR), left = 1, stop = -1, peak = 0, why = 'still open at the horizon', mins = 0;
  const take = (i: number, share: number, r: number) => { net += share * (r - slipR - (waiver && i + 1 <= waiver ? 0 : feeR)); left -= share; mins = i; };
  for (let i = 0; i < path.length; i++) {
    const b = path[i];
    const lo = R(dir === 1 ? b.low : b.high), hi = R(dir === 1 ? b.high : b.low);
    if (lo <= stop) { take(i, left, stop); why = stop <= -1 ? 'stop' : stop > 0 ? 'trail/floor' : 'break-even'; break; }
    for (let k = 0; k < p.tps.length; k++) {
      const share = p.split[k];
      if (share > 0 && left > 1e-9 && hi >= p.tps[k] && !(t[`__tp${k}`] as any)) {
        t[`__tp${k}`] = true;
        take(i, Math.min(share, left), p.tps[k]);
        why = `TP${k + 1}`;
      }
    }
    if (left <= 1e-9) break;
    peak = Math.max(peak, hi);
    stop = Math.max(stop, peak >= 1.5 ? peak * 0.6 : peak >= 1 ? 0.5 : -1);
  }
  for (const k of [0, 1, 2]) delete t[`__tp${k}`];
  if (left > 1e-9 && path.length) { take(path.length - 1, left, R(path.at(-1).close)); }
  return { r: net, why, mins };
}

const results = policies.map(p => ({ p, rs: rows.map((t: any) => replay(t, p)) as Array<{ r: number; why: string; mins: number }> }));
const actualR: number[] = rows.map((t: any) => (t.realized_pnl - t.fees) / t.risk_amount);

console.log(`\nREAL TRADES REPLAYED · ${rows.length} closed live trades · 1m paths · live stop logic · fees, GST and the Scalper Offer\n`);
console.log(`  ${'#'.padStart(3)} ${'pair'.padEnd(34)} ${'actual'.padStart(7)} ${policies.map(p => p.name.split(',')[0].slice(0, 11).padStart(12)).join('')}`);
rows.forEach((t: any, i: number) => {
  const a = actualR[i];
  console.log(`  ${String(t.id).padStart(3)} ${`${t.scanner_id.slice(0, 22)} ${t.symbol}`.padEnd(34)} ${a.toFixed(2).padStart(7)} ${results.map(r => r.rs[i].r.toFixed(2).padStart(12)).join('')}`);
});
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
console.log(`\n  ${'TOTAL R'.padStart(38)} ${sum(actualR).toFixed(2).padStart(7)} ${results.map(r => sum(r.rs.map(x => x.r)).toFixed(2).padStart(12)).join('')}`);
console.log(`  ${'winners'.padStart(38)} ${String(actualR.filter(x => x > 0).length).padStart(7)} ${results.map(r => String(r.rs.filter(x => x.r > 0).length).padStart(12)).join('')}`);
console.log(`  ${'TP fills'.padStart(38)} ${''.padStart(7)} ${results.map(r => String(r.rs.filter(x => x.why.startsWith('TP')).length).padStart(12)).join('')}`);
console.log(`\n  policies: ${policies.map((p, i) => `${i + 1}) ${p.name}`).join('   ')}`);
console.log('  "actual" includes the manual closes; every replayed column lets the rule decide instead.');
