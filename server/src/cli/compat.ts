/**
 * Compatibility matrix: runs every manifest script through the worker pool on real Delta
 * candles and prints what each one produces. Usage: npm run compat -- [SYMBOL] [TF] [BARS]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DeltaRest } from '../delta/rest.ts';
import type { WorkerResult } from '../pine/worker.ts';
import { PinePool } from '../pine/pool.ts';
import { applyPatches } from '../pine/patches.ts';
import { PINE_DIR, SCRIPTS_DIR, TF_SECONDS } from '../config.ts';

const symbol = process.argv[2] || 'BTCUSD';
const tf = process.argv[3] || '15m';
const nBars = Number(process.argv[4] || 1000);
const only = process.argv[5];

const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as any[];
const rest = new DeltaRest();
const product = await rest.product(symbol);
const tick = Number(product?.tick_size ?? 0.5);
const candles = await rest.recentCandles(symbol, tf, nBars, TF_SECONDS[tf]);
const bars = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
console.log(`${symbol} ${tf}: ${bars.length} closed bars, tick ${tick}`);

const pool = new PinePool(4, 120_000);
const rows: any[] = [];
const reportFile = path.join(SCRIPTS_DIR, 'compat-report.json');
const merge = process.argv[6] === '--merge'; // keep rows of scripts not run this time
const previous: Record<string, any> = {};
if (merge && fs.existsSync(reportFile)) for (const r of JSON.parse(fs.readFileSync(reportFile, 'utf8')).rows ?? []) previous[r.id] = r;
const save = () => { const byId: Record<string, any> = { ...previous }; for (const r of rows) byId[r.id] = r; fs.writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), symbol, tf, bars: bars.length, rows: Object.values(byId) }, null, 1)); };
const withDeadline = <T,>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> => new Promise((resolve) => { const t = setTimeout(() => resolve(onTimeout()), ms); p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); }); });
await Promise.all(manifest.filter(m => m.status !== 'unavailable' && (!only || only === '-' || only.split(',').some((o: string) => m.id === o || m.id.includes(o)))).map(async (m) => {
  const raw = fs.readFileSync(path.join(PINE_DIR, m.file), 'utf8');
  const { source, applied } = applyPatches(raw, m.file);
  const r = await withDeadline(pool.run({ scannerId: m.id, source, symbol, tf, tickSize: tick, bars, tailBars: 'all', plotTail: 50 }), 150_000, (): WorkerResult => ({ id: -1, bars: bars.length, lastBarTime: bars.at(-1)?.time ?? 0, ok: false, error: 'hung: no result within 150s (script likely loops forever under PineTS)', ms: 150_000, alerts: [], shapes: [], labels: [], plots: [], warnings: 0 }));
  const entryish = r.alerts.filter(a => a.type === 'alert' && /🟢|🔴|LONG|SHORT|BUY|SELL/i.test(a.message)).length;
  rows.push({ id: m.id, ok: r.ok, ms: r.ms, error: r.error, patches: applied, alerts: r.alerts.length, entryish, shapes: r.shapes.map(s => `${s.title}:${s.times.length}`).join(','), labels: r.labels.length, plots: r.plots.length, warnings: r.warnings });
  if (rows.length % 10 === 0) save();
  console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + m.id.padEnd(36) + ` ${String(r.ms).padStart(5)}ms ` + (r.ok ? `alerts=${r.alerts.length} entryish=${entryish} shapes=[${r.shapes.map(s => `${s.title}:${s.times.length}`).join(',')}] labels=${r.labels.length} plots=${r.plots.length}` + (applied.length ? ` patches=${applied.join('+')}` : '') : `ERR ${r.error}`));
}));
save();
const ok = rows.filter(r => r.ok).length;
console.log(`\n${ok}/${rows.length} scripts run.`);
await pool.stop();
process.exit(0);
