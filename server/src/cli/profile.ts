/**
 * What does each script actually produce in our runtime? Run it once per timeframe on one market
 * and classify it by what came out — not by what its description promises:
 *
 *   plan     entries with a stop or targets (a complete trade)
 *   signal   directional entries, no levels (our ATR fallback supplies them)
 *   levels   labels / plots only: information, nothing to trade on directly
 *   silent   ran without error and emitted nothing
 *   broken   did not run
 *
 *   IDS=ids.txt MARKET=ETHUSD TFS=15m,1h,4h OUT=profile.tsv npm run profile
 */
import fs from 'node:fs';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean);
const MARKET = process.env.MARKET ?? 'ETHUSD';
const TFS = (process.env.TFS ?? '15m,1h,4h').split(',');
const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const p = await rest.product(MARKET);
const tickSize = Number(p?.tick_size ?? 0.5);
const series = new Map<string, Bar[]>();
for (const tf of TFS) series.set(tf, toBars(await rest.recentCandles(MARKET, tf, BARS[tf], TF_SECONDS[tf])));
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 8), 120_000);
type Row = { id: string; tf: string; kind: string; ms: number; entries: number; withSl: number; withTp: number; exits: number; info: number; alertconds: number; shapes: number; labels: number; labelTexts: string; plots: number; error: string };
const rows: Row[] = [];
const tasks = ids.filter(id => registry.get(id)).flatMap(id => TFS.map(tf => ({ id, tf })));
await Promise.all(Array.from({ length: 8 }, async () => {
  for (;;) {
    const t = tasks.shift(); if (!t) return;
    const s = registry.get(t.id)!;
    const bars = series.get(t.tf)!;
    if (s.status !== 'ok') { rows.push({ id: t.id, tf: t.tf, kind: 'broken', ms: 0, entries: 0, withSl: 0, withTp: 0, exits: 0, info: 0, alertconds: 0, shapes: 0, labels: 0, labelTexts: '', plots: 0, error: s.reason ?? s.status }); continue; }
    const inputs = cfg.scanners[t.id]?.inputs;
    const res = await pool.run({ scannerId: t.id, source: s.patched, symbol: MARKET, tf: t.tf, tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined, timezone: cfg.scanners[t.id]?.timezone });
    if (!res.ok) { rows.push({ id: t.id, tf: t.tf, kind: 'broken', ms: res.ms, entries: 0, withSl: 0, withTp: 0, exits: 0, info: 0, alertconds: 0, shapes: 0, labels: 0, labelTexts: '', plots: 0, error: (res.error ?? '').slice(0, 80) }); continue; }
    const derived = applyRules({ scannerId: t.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[t.id]?.rule ?? null, bars, mode: 'backtest' });
    const ev = extractEvents(res.alerts, res.shapes, { derived, sources: cfg.scanners[t.id]?.sources });
    const entries = ev.filter(e => e.kind === 'entry');
    const withSl = entries.filter(e => e.sl).length, withTp = entries.filter(e => e.tp.length).length;
    const shapes = res.shapes.reduce((a, s) => a + s.times.length, 0);
    const texts = [...new Set(res.labels.map(l => l.text.replace(/[\d.,%:]+/g, '#').trim()).filter(Boolean))];
    const kind = entries.length ? (withSl || withTp ? 'plan' : 'signal') : (res.labels.length || res.plots.length ? 'levels' : 'silent');
    rows.push({ id: t.id, tf: t.tf, kind, ms: res.ms, entries: entries.length, withSl, withTp, exits: ev.filter(e => e.kind === 'exit').length, info: ev.filter(e => e.kind === 'info').length, alertconds: res.alerts.filter(a => a.type === 'alertcondition').length, shapes, labels: res.labels.length, labelTexts: texts.slice(0, 6).join(' | ').slice(0, 90), plots: res.plots.length, error: '' });
  }
}));
await pool.stop();
rows.sort((a, b) => a.id.localeCompare(b.id) || TFS.indexOf(a.tf) - TFS.indexOf(b.tf));
fs.writeFileSync(process.env.OUT ?? '/tmp/profile.tsv', ['scanner', 'tf', 'kind', 'ms', 'entries', 'withSl', 'withTp', 'exits', 'info', 'alertconds', 'shapes', 'labels', 'labelTexts', 'plots', 'error'].join('\t') + '\n' + rows.map(r => [r.id, r.tf, r.kind, r.ms, r.entries, r.withSl, r.withTp, r.exits, r.info, r.alertconds, r.shapes, r.labels, r.labelTexts, r.plots, r.error].join('\t')).join('\n') + '\n');
console.log(`${'scanner'.padEnd(46)} ${'tf'.padEnd(4)} ${'kind'.padEnd(7)} ${'ms'.padStart(6)} ${'entr'.padStart(5)} ${'sl'.padStart(4)} ${'tp'.padStart(4)} ${'exit'.padStart(4)} ${'info'.padStart(4)} ${'acnd'.padStart(4)} ${'shp'.padStart(5)} ${'lbl'.padStart(5)} ${'plt'.padStart(3)}  labels / error`);
for (const r of rows) console.log(`${r.id.padEnd(46)} ${r.tf.padEnd(4)} ${r.kind.padEnd(7)} ${String(r.ms).padStart(6)} ${String(r.entries).padStart(5)} ${String(r.withSl).padStart(4)} ${String(r.withTp).padStart(4)} ${String(r.exits).padStart(4)} ${String(r.info).padStart(4)} ${String(r.alertconds).padStart(4)} ${String(r.shapes).padStart(5)} ${String(r.labels).padStart(5)} ${String(r.plots).padStart(3)}  ${r.error || r.labelTexts}`);
process.exit(0);
