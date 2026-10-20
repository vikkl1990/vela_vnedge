/**
 * PineTS upgrade parity (decision 150): runs a list of scripts on one saved candle set and records exactly what each
 * produces (alert and shape bar times), so two engine versions can be compared signal by signal.
 * Usage: CANDLES=file.json IDS=ids.txt OUT=out.json [WORKERS=4] node src/cli/parity-dump.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { PinePool } from '../pine/pool.ts';
import { applyPatches } from '../pine/patches.ts';
import { PINE_DIR, SCRIPTS_DIR } from '../config.ts';
import { DeltaRest } from '../delta/rest.ts';
import { TF_SECONDS } from '../config.ts';

if (process.env.FETCH) {
  const [symbol, tf, n] = process.env.FETCH.split(':');
  const rest = new DeltaRest(); const product = await rest.product(symbol);
  const candles = await rest.recentCandles(symbol, tf, Number(n), TF_SECONDS[tf]);
  const bars = candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  fs.writeFileSync(process.env.CANDLES!, JSON.stringify({ symbol, tf, tick: Number(product?.tick_size ?? 0.5), bars }));
  console.log(`saved ${bars.length} bars of ${symbol} ${tf}`); process.exit(0);
}
const c = JSON.parse(fs.readFileSync(process.env.CANDLES!, 'utf8'));
const ids = new Set(fs.readFileSync(process.env.IDS!, 'utf8').split(/[\s,]+/).filter(Boolean));
const manifest = (JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as any[]).filter(m => ids.has(m.id) && m.status !== 'removed' && m.status !== 'unavailable');
const pool = new PinePool(Number(process.env.WORKERS) || 4, 120_000);
const out: Record<string, any> = {};
const withDeadline = <T,>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> => new Promise((resolve) => { const t = setTimeout(() => resolve(onTimeout()), ms); p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); }); });
let done = 0;
// at most WORKERS scripts in flight, so each one's deadline runs from its own start, not from the queue
const inFlight = Number(process.env.WORKERS) || 4; let next = 0;
const one = async (m: any) => {
  const { source } = applyPatches(fs.readFileSync(path.join(PINE_DIR, m.file), 'utf8'), m.file);
  const r: any = await withDeadline<any>(pool.run({ scannerId: m.id, source, symbol: c.symbol, tf: c.tf, tickSize: c.tick, bars: c.bars, tailBars: 'all', plotTail: 0 } as any), 150_000, () => ({ ok: false, error: 'hung: no result within 150s', ms: 150_000, alerts: [], shapes: [] }));
  out[m.id] = { ok: r.ok, error: r.error ? String(r.error).slice(0, 200) : undefined, ms: r.ms,
    alerts: (r.alerts ?? []).map((a: any) => `${a.time}|${a.type}|${String(a.title ?? '').slice(0, 40)}|${String(a.message).slice(0, 80)}`),
    shapes: Object.fromEntries((r.shapes ?? []).map((s: any) => [s.title, s.times])) };
  if (++done % 50 === 0) console.log(`${done}/${manifest.length}`);
};
await Promise.all(Array.from({ length: inFlight }, async () => { while (next < manifest.length) await one(manifest[next++]); }));
fs.writeFileSync(process.env.OUT!, JSON.stringify(out));
console.log(`done ${done}: ${Object.values(out).filter((x: any) => x.ok).length} ran`);
await pool.stop(); process.exit(0);
