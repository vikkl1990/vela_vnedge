/**
 * Are weekend trades worse, or is `risk.regime.noWeekend` just refusing two days a week?
 *
 *   IDS=ids.txt MARKETS=… TFS=15m,1h,4h npm run weekend
 *
 * Crypto trades through Saturday and Sunday, so a weekend block is an assumption, not a fact of the
 * venue: thinner books and lazier trends might make those entries worse, or they might not. This
 * splits every backtested trade by the UTC weekday it was entered on and compares.
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
const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean);
const TFS = (process.env.TFS ?? '15m,1h,4h').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD').split(',');
const BARS: Record<string, number> = { '15m': 12000, '1h': 6000, '4h': 4000 };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 7), 300_000);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));

const byDay = new Map<number, { n: number; r: number; wins: number }>();
const byScanner = new Map<string, { wknd: { n: number; r: number }; week: { n: number; r: number } }>();
let bars = 0;

for (const tf of TFS) {
  for (const id of ids) {
    const s = registry.get(id);
    if (!s || s.status !== 'ok') continue;
    for (const symbol of MARKETS) {
      try {
        const product = await rest.product(symbol);
        const market = { contractValue: Number(product?.contract_value ?? 0.001), tickSize: Number(product?.tick_size ?? 0.5) };
        const b = toBars(await rest.recentCandles(symbol, tf, BARS[tf] ?? 4000, TF_SECONDS[tf]));
        if (b.length < 500) continue;
        bars += b.length;
        const res = await pool.run({ scannerId: s.id, source: s.patched, symbol, tf, tickSize: market.tickSize, bars: b, tailBars: 'all', plotTail: b.length });
        if (!res.ok) continue;
        const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars: b, mode: 'backtest' });
        const events = extractEvents(res.alerts, res.shapes, { derived });
        const bt = runBacktest({ scannerId: s.id, scannerName: s.id, symbol, tf, bars: b, events, cfg: cfg.paper, exitMode: 'both', contractValue: market.contractValue, tickSize: market.tickSize });
        for (const t of bt.trades as any[]) {
          const d = new Date(t.entryAt).getUTCDay();
          const cur = byDay.get(d) ?? { n: 0, r: 0, wins: 0 };
          cur.n++; cur.r += t.rMultiple ?? 0; cur.wins += (t.pnl > 0 ? 1 : 0);
          byDay.set(d, cur);
          const sc = byScanner.get(id) ?? { wknd: { n: 0, r: 0 }, week: { n: 0, r: 0 } };
          const side = d === 0 || d === 6 ? sc.wknd : sc.week;
          side.n++; side.r += t.rMultiple ?? 0;
          byScanner.set(id, sc);
        }
      } catch (e: any) { console.error(`  ${id}/${symbol}/${tf}: ${e?.message ?? e}`); }
    }
  }
  console.error(`  ${tf} done`);
}

console.log(`\n${'day'.padEnd(6)} ${'trades'.padStart(7)} ${'share'.padStart(6)} ${'win%'.padStart(5)} ${'avgR'.padStart(8)} ${'total'.padStart(9)}`);
const total = [...byDay.values()].reduce((a, v) => a + v.n, 0);
for (let d = 0; d < 7; d++) {
  const v = byDay.get(d); if (!v) continue;
  console.log(`${DAYS[d].padEnd(6)} ${String(v.n).padStart(7)} ${(Math.round(100 * v.n / total) + '%').padStart(6)} ${String(Math.round(100 * v.wins / v.n)).padStart(5)} ${(v.r / v.n >= 0 ? '+' : '') + (v.r / v.n).toFixed(3)} ${((v.r >= 0 ? '+' : '') + v.r.toFixed(1) + 'R').padStart(9)}`);
}
const wknd = [0, 6].map(d => byDay.get(d) ?? { n: 0, r: 0, wins: 0 }).reduce((a, v) => ({ n: a.n + v.n, r: a.r + v.r, wins: a.wins + v.wins }), { n: 0, r: 0, wins: 0 });
const week = [1, 2, 3, 4, 5].map(d => byDay.get(d) ?? { n: 0, r: 0, wins: 0 }).reduce((a, v) => ({ n: a.n + v.n, r: a.r + v.r, wins: a.wins + v.wins }), { n: 0, r: 0, wins: 0 });
console.log(`\nweekend  ${String(wknd.n).padStart(6)} trades  ${(wknd.r / Math.max(1, wknd.n)).toFixed(3)}R  total ${wknd.r.toFixed(1)}R`);
console.log(`weekday  ${String(week.n).padStart(6)} trades  ${(week.r / Math.max(1, week.n)).toFixed(3)}R  total ${week.r.toFixed(1)}R`);
console.log(`\nblocking weekends costs ${wknd.r >= 0 ? 'the ' + wknd.r.toFixed(1) + 'R those trades made' : 'nothing — it avoids ' + Math.abs(wknd.r).toFixed(1) + 'R of losses'}`);
console.log(`\n${'scanner'.padEnd(44)} ${'weekend'.padStart(18)} ${'weekday'.padStart(18)}`);
for (const [id, v] of [...byScanner].sort((a, b) => (b[1].wknd.r / Math.max(1, b[1].wknd.n)) - (a[1].wknd.r / Math.max(1, a[1].wknd.n))))
  console.log(`${id.slice(0, 44).padEnd(44)} ${`${v.wknd.n} @ ${(v.wknd.r / Math.max(1, v.wknd.n)).toFixed(3)}R`.padStart(18)} ${`${v.week.n} @ ${(v.week.r / Math.max(1, v.week.n)).toFixed(3)}R`.padStart(18)}`);
await pool.stop();
process.exit(0);
