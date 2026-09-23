/**
 * How far price actually travels after each entry, per scanner and market.
 *
 *   IN=recon.json npm run targets
 *
 * For every entry, the raw 1m path is followed until the original stop or 24 h — independent of how
 * the trade actually ended — and the best result in R is recorded with the time it took. That gives
 * the two numbers a target policy needs: how often a level is reachable at all, and how long the
 * money is tied up waiting. It also splits the stop-outs into the two problems they hide: trades
 * that never went anywhere (entry quality) and trades that were ahead and gave it back (exit policy).
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import type { Bar } from '../data/candleStore.ts';

const H = Number(process.env.HOURS ?? 24) * 3600_000;
const LEVELS = [0.5, 1, 1.5, 2, 3, 6];
const entries: any[] = JSON.parse(fs.readFileSync(process.env.IN!, 'utf8'));
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

const bySymbol = new Map<string, Bar[]>();
for (const s of new Set(entries.map(e => e.symbol))) {
  const es = entries.filter(e => e.symbol === s);
  bySymbol.set(s, toBars(await rest.candles(s, '1m', Math.floor(Math.min(...es.map(e => e.fillAt)) / 1000) - 60, Math.floor((Math.max(...es.map(e => e.fillAt)) + H) / 1000), 120_000)));
}

interface Row { key: string; n: number; reach: number[]; mins: number[][]; peaks: number[]; stops: number; dead: number; gaveBack: number }
const rows = new Map<string, Row>();
const blank = (key: string): Row => ({ key, n: 0, reach: LEVELS.map(() => 0), mins: LEVELS.map(() => []), peaks: [], stops: 0, dead: 0, gaveBack: 0 });

for (const e of entries) {
  const dir = e.side === 'long' ? 1 : -1, risk = Math.abs(e.entry - e.sl);
  if (!(risk > 0)) continue;
  const path = bySymbol.get(e.symbol)!.filter(b => b.time >= e.fillAt && b.time <= e.fillAt + H);
  let peak = 0, stopped = false;
  const hitAt = LEVELS.map(() => -1);
  for (let i = 0; i < path.length; i++) {
    const b = path[i];
    const lo = ((dir === 1 ? b.low : b.high) - e.entry) * dir / risk;
    const hi = ((dir === 1 ? b.high : b.low) - e.entry) * dir / risk;
    if (lo <= -1) { stopped = true; break; }
    peak = Math.max(peak, hi);
    LEVELS.forEach((lv, k) => { if (hitAt[k] < 0 && hi >= lv) hitAt[k] = i; });
  }
  for (const key of [`scanner:${e.scanner}`, `market:${e.symbol}`, `pair:${e.scanner} ${e.symbol}`, 'ALL']) {
    const r = rows.get(key) ?? blank(key); rows.set(key, r);
    r.n++; r.peaks.push(peak);
    LEVELS.forEach((_, k) => { if (hitAt[k] >= 0) { r.reach[k]++; r.mins[k].push(hitAt[k]); } });
    if (stopped) { r.stops++; if (peak < 0.25) r.dead++; else r.gaveBack++; }
  }
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const pct = (a: number, b: number) => (b ? (a / b * 100).toFixed(0).padStart(3) + '%' : '   -');
const show = (prefix: string, title: string) => {
  const list = [...rows.values()].filter(r => r.key.startsWith(prefix) && r.n >= (prefix === 'pair:' ? 20 : 1)).sort((a, b) => b.n - a.n);
  if (!list.length) return;
  console.log(`\n${title}\n`);
  console.log(`  ${'name'.padEnd(42)} ${'trades'.padStart(6)} ${LEVELS.map(l => `${l}R`.padStart(5)).join('')} ${'median peak'.padStart(12)} ${'stops'.padStart(6)} ${'never +0.25R'.padStart(13)} ${'gave back'.padStart(10)}`);
  for (const r of list) {
    console.log(`  ${r.key.replace(prefix, '').slice(0, 42).padEnd(42)} ${String(r.n).padStart(6)} ${r.reach.map((c, k) => pct(c, r.n).padStart(5)).join('')} ${med(r.peaks).toFixed(2).padStart(11)}R ${String(r.stops).padStart(6)} ${pct(r.dead, r.stops).padStart(13)} ${pct(r.gaveBack, r.stops).padStart(10)}`);
  }
};
show('ALL', 'EVERY ENTRY');
show('scanner:', 'BY SCANNER — share of entries whose price reached each level before the stop');
show('market:', 'BY MARKET');
show('pair:', 'BY PAIR (20+ trades)');
const all = rows.get('ALL')!;
console.log(`\n  median minutes to reach each level: ${LEVELS.map((l, k) => `${l}R ${med(all.mins[k]).toFixed(0)}m`).join(' · ')}`);
console.log(`  of ${all.stops} stop-outs, ${all.dead} never reached +0.25R (entry quality) and ${all.gaveBack} were ahead and gave it back (exit policy)`);
