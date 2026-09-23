/**
 * How many live scans this machine can actually do between bar closes.
 *
 *   SCRIPTS=120 MARKETS=BTCUSD,ETHUSD BARS=1000,400,250 WORKERS=6,12,16 npm run bench
 *
 * Runs live-shaped jobs (the last few bars asked for, the way the engine runs them on a bar close)
 * and reports throughput per pool size and per history length. Pine has no incremental state: every
 * run recomputes the whole series, so the bar count is a direct multiplier on cost.
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { ScriptHealth } from '../scanners/health.ts';
import { Db } from '../db.ts';
import { TF_SECONDS } from '../config.ts';

const N = Number(process.env.SCRIPTS ?? 120);
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const BARSETS = (process.env.BARS ?? '1000,400,250').split(',').map(Number);
const POOLS = (process.env.WORKERS ?? '6,12').split(',').map(Number);
const TF = process.env.TF ?? '15m';

const health = new ScriptHealth(new Db());
const registry = new ScannerRegistry();
const scripts = registry.runnable().filter(s => !health.isQuarantined(s.id)).slice(0, N);
const rest = new DeltaRest();
const bars = new Map<string, any[]>();
for (const m of MARKETS) {
  const c = await rest.recentCandles(m, TF, Math.max(...BARSETS) + 5, TF_SECONDS[TF]);
  bars.set(m, c.slice(0, -1).map((x: any) => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume })));
}
console.log(`${scripts.length} scripts × ${MARKETS.length} markets = ${scripts.length * MARKETS.length} live runs per pass\n`);
console.log(`${'workers'.padStart(7)} ${'bars'.padStart(5)} ${'wall'.padStart(7)} ${'runs/s'.padStart(7)} ${'median'.padStart(7)} ${'p95'.padStart(7)} ${'failed'.padStart(6)}   scanners a 15m bar could carry`);

for (const workers of POOLS) {
  for (const nbars of BARSETS) {
    const pool = new PinePool(workers, 60_000);
    const jobs = scripts.flatMap(s => MARKETS.map(m => ({ s, m })));
    const t0 = Date.now();
    const times: number[] = [];
    let failed = 0;
    await Promise.all(jobs.map(async ({ s, m }) => {
      const b = bars.get(m)!.slice(-nbars);
      const r = await pool.run({ scannerId: s.id, source: s.patched, symbol: m, tf: TF, tickSize: 0.5, bars: b, tailBars: 3, plotTail: 400 });
      if (!r.ok) failed++; else times.push(r.ms);
    }));
    const wall = (Date.now() - t0) / 1000;
    times.sort((a, b) => a - b);
    const rate = jobs.length / wall;
    console.log(`${String(workers).padStart(7)} ${String(nbars).padStart(5)} ${wall.toFixed(1).padStart(6)}s ${rate.toFixed(1).padStart(7)} ${String(times[Math.floor(times.length * .5)] ?? 0).padStart(6)}ms ${String(times[Math.floor(times.length * .95)] ?? 0).padStart(6)}ms ${String(failed).padStart(6)}   ${Math.round(rate * 900 / MARKETS.length).toLocaleString()} on ${MARKETS.length} markets`);
    await pool.stop();
  }
}
process.exit(0);
