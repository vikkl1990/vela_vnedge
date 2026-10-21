/**
 * Decision 172: what do the library's silent scripts emit? Every runnable script is run on a few markets and its output
 * is read exactly as the scanner reads it (`extractEvents` with the scanner's own overrides). A script that yields no
 * entry anywhere is classified by what it did emit, and the titles and label texts of that set are tallied, so the
 * reading rules can be extended where a pattern repeats and a script completed where it is worth it.
 *
 *   [MARKETS=BTCUSD,SOLUSD] [TF=15m] [BARS=1500] [WORKERS=6] [IDS=ids.txt] [CONFIG_FILE=…/config.json] OUT=survey.tsv npm run silent-survey
 */
import fs from 'node:fs';
import path from 'node:path';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { applyPatches } from '../pine/patches.ts';
import { extractEvents } from '../scanners/extractor.ts';
import { PINE_DIR, SCRIPTS_DIR, TF_SECONDS } from '../config.ts';
import type { WorkerResult } from '../pine/worker.ts';

const MARKETS = (process.env.MARKETS ?? 'BTCUSD,SOLUSD').split(',');
const TF = process.env.TF ?? '15m';
const BARS = Number(process.env.BARS ?? 1500);
const OUT = process.env.OUT ?? 'silent-survey.tsv';
const scannersCfg: Record<string, any> = process.env.CONFIG_FILE ? (JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, 'utf8')).scanners ?? {}) : {};
const only = process.env.IDS ? new Set(fs.readFileSync(process.env.IDS, 'utf8').split(/\s+/).filter(Boolean)) : null;
const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as any[];
const todo = manifest.filter(m => m.status === 'ok' && (!only || only.has(m.id)));

const rest = new DeltaRest();
const data: Array<{ symbol: string; tick: number; bars: any[] }> = [];
for (const symbol of MARKETS) {
  const product = await rest.product(symbol);
  const candles = await rest.recentCandles(symbol, TF, BARS, TF_SECONDS[TF]);
  data.push({ symbol, tick: Number(product?.tick_size ?? 0.5), bars: candles.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) });
}
console.log(`${todo.length} scripts × ${MARKETS.join('/')} ${TF}, ${data[0].bars.length} bars`);

const pool = new PinePool(Number(process.env.WORKERS) || 6, 120_000);
const withDeadline = <T,>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> => new Promise((resolve) => { const t = setTimeout(() => resolve(onTimeout()), ms); p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout()); }); });

type Row = { id: string; author: string; type: string; cls: string; entries: number; alerts: number; conds: number; shapes: number; labels: number; plots: number; ms: number; condTitles: string; shapeTitles: string; labelTexts: string; alertSample: string; error: string };
const rows: Row[] = [];
const top = (xs: string[], n = 6) => { const c = new Map<string, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(' | '); };
const norm = (s: string) => s.replace(/[0-9.,%+-]+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);

let next = 0;
const one = async (m: any) => {
  const raw = fs.readFileSync(path.join(PINE_DIR, m.file), 'utf8');
  const { source } = applyPatches(raw, m.file);
  const sc = scannersCfg[m.id];
  let entries = 0, alerts = 0, conds = 0, shapes = 0, labels = 0, plots = 0, ms = 0, error = '';
  const condTitles: string[] = [], shapeTitles: string[] = [], labelTexts: string[] = [], alertSamples: string[] = [];
  for (const d of data) {
    const r = await withDeadline(pool.run({ scannerId: m.id, source, symbol: d.symbol, tf: TF, tickSize: d.tick, bars: d.bars, tailBars: 'all', plotTail: 5, inputs: sc?.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc?.timezone }), 150_000, (): WorkerResult => ({ id: -1, bars: d.bars.length, lastBarTime: 0, ok: false, error: 'hung', ms: 150_000, alerts: [], shapes: [], labels: [], plots: [], warnings: 0 }));
    ms += r.ms;
    if (!r.ok) { error = error || String(r.error ?? 'error').slice(0, 120); continue; }
    const ev = extractEvents(r.alerts, r.shapes, { drawn: r.labels, scannerId: m.id, sources: sc?.sources, edge: sc?.edge, labels: sc?.labels, invert: sc?.invert });
    entries += ev.filter(e => e.kind === 'entry').length;
    alerts += r.alerts.filter(a => a.type === 'alert').length;
    conds += r.alerts.filter(a => a.type === 'alertcondition').length;
    shapes += r.shapes.reduce((a, s) => a + s.times.length, 0);
    labels += r.labels.length; plots += r.plots.length;
    for (const a of r.alerts) if (a.type === 'alertcondition') condTitles.push(norm(String(a.title ?? a.message ?? '')));
    for (const s of r.shapes) if (s.times.length) shapeTitles.push(norm(String(s.title ?? '')));
    for (const l of r.labels as any[]) labelTexts.push(norm(String(l.text ?? '')));
    for (const a of r.alerts) if (a.type === 'alert') alertSamples.push(norm(String(a.message ?? '')));
  }
  const cls = error && !entries && !alerts && !conds && !shapes && !labels ? 'error'
    : entries > 0 ? 'reads'
    : alerts > 0 ? 'alert-text'
    : conds > 0 ? 'cond-titles'
    : shapes > 0 ? 'shape-titles'
    : labels > 0 ? 'labels-only'
    : plots > 0 ? 'plots-only' : 'nothing';
  rows.push({ id: m.id, author: m.author ?? '', type: m.scriptType ?? '', cls, entries, alerts, conds, shapes, labels, plots, ms, condTitles: top(condTitles), shapeTitles: top(shapeTitles), labelTexts: top(labelTexts), alertSample: top(alertSamples, 3), error });
  if (rows.length % 50 === 0) { save(); console.log(`… ${rows.length}/${todo.length}`); }
};
const save = () => fs.writeFileSync(OUT, ['id\tauthor\ttype\tclass\tentries\talerts\tconds\tshapes\tlabels\tplots\tms\tcondTitles\tshapeTitles\tlabelTexts\talertSample\terror', ...rows.map(r => [r.id, r.author, r.type, r.cls, r.entries, r.alerts, r.conds, r.shapes, r.labels, r.plots, r.ms, r.condTitles, r.shapeTitles, r.labelTexts, r.alertSample, r.error].join('\t'))].join('\n'));
await Promise.all(Array.from({ length: Number(process.env.WORKERS) || 6 }, async () => { while (next < todo.length) await one(todo[next++]); }));
save();
const by = new Map<string, number>(); for (const r of rows) by.set(r.cls, (by.get(r.cls) ?? 0) + 1);
console.log('\nclasses:', [...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · '));
await pool.stop();
process.exit(0);
