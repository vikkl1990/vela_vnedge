/**
 * Would a second script, run across every market, make a good global filter?
 *
 *   GATE_ID=reversal-signals-algoalpha IDS=fleet.txt MARKETS=… npm run gatelab
 *
 * The question is not whether the filter script is a good scanner — it is whether the fleet's own
 * entries do better when they agree with it. So each fleet entry is joined to the filter's state on
 * the same bar and split: does it agree with the filter's trend, and did the filter call a reversal
 * the same way within the last few bars? Both halves are reported, because a filter that only works
 * in one of them is the usual false positive (decisions 33, 39).
 *
 * Nothing is built or wired: this measures the gate before anyone pays to implement it.
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const GATE_ID = process.env.GATE_ID ?? 'reversal-signals-algoalpha';
const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean).filter(x => x !== GATE_ID);
const TFS = (process.env.TFS ?? '15m').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const BARS: Record<string, number> = { '15m': 12000, '1h': 6000, '4h': 4000 };
const WINDOWS = (process.env.WINDOWS ?? '3,10,30').split(',').map(Number);

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 6), 300_000);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

type Bucket = { n: number; r: number };
const add = (m: Map<string, Bucket>, k: string, r: number) => { const b = m.get(k) ?? { n: 0, r: 0 }; b.n++; b.r += r; m.set(k, b); };
const fit = new Map<string, Bucket>(), test = new Map<string, Bucket>();

for (const tf of TFS) {
  for (const symbol of MARKETS) {
    try {
      const product = await rest.product(symbol);
      const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
      const bars = toBars(await rest.recentCandles(symbol, tf, BARS[tf] ?? 4000, TF_SECONDS[tf]));
      if (bars.length < 500) continue;
      const idx = new Map(bars.map((b, i) => [b.time, i]));
      const split = bars[Math.floor(bars.length / 2)].time;

      // the filter's own state on every bar: its stepped trend, and the bars it called a reversal on
      const g = registry.get(GATE_ID)!;
      const gr = await pool.run({ scannerId: g.id, source: g.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
      if (!gr.ok) { console.error(`  gate failed on ${symbol} ${tf}: ${gr.error}`); continue; }
      const ma = gr.plots.find(p => /stepped/i.test(p.title));
      const maAt = new Map<number, number>();
      for (const d of ma?.data ?? []) if (d.value != null) maAt.set(d.time, d.value);
      const revUp: number[] = [], revDn: number[] = [];
      for (const s of gr.shapes) {
        const into = /buy/i.test(s.title) ? revUp : /sell/i.test(s.title) ? revDn : null;
        if (!into) continue;
        for (const t of s.times) { const i = idx.get(t); if (i !== undefined) into.push(i); }
      }
      const near = (list: number[], i: number, w: number) => list.some(j => i - j >= 0 && i - j <= w);

      for (const id of ids) {
        const s = registry.get(id);
        if (!s || s.status !== 'ok') continue;
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars, tailBars: 'all', plotTail: bars.length });
        if (!res.ok) continue;
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars, mode: 'backtest' });
        const events = extractEvents(res.alerts, res.shapes, { derived });
        const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol, tf, bars, events, cfg: cfg.paper, exitMode: 'both', contractValue: market.contractValue, tickSize: market.tickSize });
        for (const t of bt.trades as any[]) {
          const i = idx.get(t.entryAt);
          if (i === undefined) continue;
          const r = t.rMultiple ?? 0;
          const m = t.entryAt < split ? fit : test;
          const long = t.side === 'long';
          add(m, 'all', r);
          const maV = maAt.get(t.entryAt);
          if (maV !== undefined) add(m, (long ? bars[i].close > maV : bars[i].close < maV) ? 'with the stepped trend' : 'against the stepped trend', r);
          for (const w of WINDOWS) {
            const hit = long ? near(revUp, i, w) : near(revDn, i, w);
            add(m, `${hit ? 'after' : 'without'} a same-side reversal within ${w} bars`, r);
          }
        }
      }
      console.error(`  ${symbol} ${tf} done`);
    } catch (e: any) { console.error(`  ${symbol}/${tf}: ${e?.message ?? e}`); }
  }
}

const keys = [...new Set([...fit.keys(), ...test.keys()])].sort();
console.log(`\nfilter: ${GATE_ID}\n`);
console.log(`${'fleet entries'.padEnd(46)} ${'1st half'.padStart(20)} ${'2nd half'.padStart(20)}`);
for (const k of keys) {
  const a = fit.get(k) ?? { n: 0, r: 0 }, b = test.get(k) ?? { n: 0, r: 0 };
  console.log(`${k.padEnd(46)} ${`${a.n} @ ${(a.r / Math.max(1, a.n)).toFixed(3)}R`.padStart(20)} ${`${b.n} @ ${(b.r / Math.max(1, b.n)).toFixed(3)}R`.padStart(20)}`);
}
await pool.stop();
process.exit(0);
