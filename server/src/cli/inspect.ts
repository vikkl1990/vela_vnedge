/**
 * Inspect what a scanner emits: alert templates, alertcondition titles, plotshape names,
 * label texts. Usage: node src/cli/inspect.ts <scanner-id>[,<id>...] [SYMBOL] [TF] [BARS]
 */
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { TF_SECONDS } from '../config.ts';

const [ids, symbol = 'BTCUSD', tf = '15m', barsArg = '1000'] = process.argv.slice(2);
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const product = await rest.product(symbol);
const tick = Number(product?.tick_size ?? 0.5);
const candles = await rest.recentCandles(symbol, tf, Number(barsArg), TF_SECONDS[tf]);
const bars = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
const pool = new PinePool(3, 180_000);
const norm = (s: string) => s.replace(/-?\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 160);
for (const id of ids.split(',')) {
  const s = registry.get(id);
  if (!s) { console.log('unknown', id); continue; }
  const r = await pool.run({ scannerId: id, source: s.patched, symbol, tf, tickSize: tick, bars, tailBars: 'all', plotTail: 5 });
  console.log(`\n### ${s.name} (${id}) ${r.ok ? '' : 'ERROR ' + r.error}`);
  const al: Record<string, number> = {}, ac: Record<string, number> = {};
  for (const a of r.alerts) { if (a.type === 'alertcondition') ac[a.title ?? a.message] = (ac[a.title ?? a.message] ?? 0) + 1; else al[norm(a.message)] = (al[norm(a.message)] ?? 0) + 1; }
  console.log('  alert() templates:'); for (const [k, v] of Object.entries(al).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(v).padStart(4)} × ${k}`);
  console.log('  alertcondition titles:', Object.entries(ac).map(([k, v]) => `${k} (${v})`).join(', ') || '-');
  console.log('  shapes:', r.shapes.map(x => `${x.title}:${x.times.length}`).join(', ') || '-');
  const lt: Record<string, number> = {}; for (const l of r.labels) { const k = norm(l.text.replace(/\n/g, ' / ')); lt[k] = (lt[k] ?? 0) + 1; }
  console.log('  labels:', Object.entries(lt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `"${k}"×${v}`).join(', ') || '-');
  console.log('  plots:', r.plots.map(p => p.title).join(', ') || '-');
}
await pool.stop();
