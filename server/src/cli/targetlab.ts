/**
 * Are a script's own targets worth obeying?
 *
 *   DETECT=1 IDS=ids.txt MARKETS=ETHUSD TFS=15m,1h,4h OUT=with-targets.txt npm run targetlab   # which scripts publish targets
 *   IDS=with-targets.txt MARKETS=… TFS=… OUT=rows.tsv npm run targetlab                       # use vs widen vs ignore
 *
 * Every (script, timeframe, market) whose entries carry a target is backtested three times on the
 * same events — `paper.scriptTargets` use / widen / ignore — with the live exit rules and exits on
 * sub-candles, and reported with halves and dollars, so a target policy that only helps in one
 * month or only in R per trade shows itself.
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
const MARKETS = (process.env.MARKETS ?? 'ETHUSD').split(',');
const CONC = Number(process.env.CONCURRENCY ?? 8);
const DETECT = process.env.DETECT === '1';
const MODES = ['use', 'widen', 'ignore'] as const;
const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const market = new Map<string, { contractValue: number; tickSize: number }>();
const series = new Map<string, Bar[]>();
for (const s of MARKETS) {
  const p = await rest.product(s);
  market.set(s, { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) });
  for (const tf of TFS) {
    const b = toBars(await rest.recentCandles(s, tf, BARS[tf], TF_SECONDS[tf]));
    series.set(`${s}:${tf}`, b);
    const need = Math.ceil((b.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]]);
    if (!DETECT) series.set(`${s}:${tf}:sub`, toBars(await rest.recentCandles(s, SUB[tf], Math.min(need, 60_000), TF_SECONDS[SUB[tf]])));
  }
  console.error(`  candles ready: ${s}`);
}

const lines: string[] = [];
if (!DETECT) lines.push(['scanner', 'tf', 'symbol', 'mode', 'trades', 'avgR', 'totalR', 'net', 'tpExits', 'trades1', 'avgR1', 'trades2', 'avgR2'].join('\t') + '\n');
const found = new Set<string>();
const pool = new PinePool(CONC, 120_000);
const tasks = ids.filter(id => registry.get(id)?.status === 'ok').flatMap(id => TFS.flatMap(tf => MARKETS.map(symbol => ({ id, tf, symbol }))));
let done = 0, withTargets = 0;
const started = Date.now();
async function worker() {
  for (;;) {
    const t = tasks.shift(); if (!t) return;
    try {
      const s = registry.get(t.id)!;
      const bars = series.get(`${t.symbol}:${t.tf}`)!;
      const m = market.get(t.symbol)!;
      const inputs = cfg.scanners[t.id]?.inputs;
      const res = await pool.run({ scannerId: t.id, source: s.patched, symbol: t.symbol, tf: t.tf, tickSize: m.tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined, timezone: cfg.scanners[t.id]?.timezone });
      if (!res.ok) continue;
      const derived = applyRules({ scannerId: t.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[t.id]?.rule ?? null, bars, mode: 'backtest' });
      const events = extractEvents(res.alerts, res.shapes, { derived });
      const entries = events.filter(e => e.kind === 'entry');
      const targeted = entries.filter(e => e.tp.length > 0).length;
      if (!targeted) continue;
      withTargets++; found.add(t.id);
      if (DETECT) { console.error(`  ${t.id} ${t.tf}: ${targeted}/${entries.length} entries carry targets`); continue; }
      const split = bars[Math.floor(bars.length / 2)].time;
      for (const mode of MODES) {
        const bt = runBacktest({ scannerId: t.id, scannerName: t.id, symbol: t.symbol, tf: t.tf, bars, events, cfg: { ...cfg.paper, scriptTargets: mode }, exitMode: cfg.scanners[t.id]?.exitMode ?? 'both', contractValue: m.contractValue, tickSize: m.tickSize, subBars: series.get(`${t.symbol}:${t.tf}:sub`) });
        const tr = bt.trades as any[];
        const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
        const h1 = tr.filter(x => x.entryAt < split), h2 = tr.filter(x => x.entryAt >= split);
        lines.push([t.id, t.tf, t.symbol, mode, tr.length, R(tr).toFixed(3), (R(tr) * tr.length).toFixed(1), bt.stats.pnl.toFixed(2), tr.filter(x => /^tp/.test(String(x.exitReason))).length, h1.length, R(h1).toFixed(3), h2.length, R(h2).toFixed(3)].join('\t') + '\n');
      }
    } catch (e: any) { console.error(`  ${t.id}/${t.symbol}/${t.tf}: ${e?.message ?? e}`); }
    finally { if (++done % 200 === 0) console.error(`  ${done}/${done + tasks.length} · ${withTargets} with targets · ${((Date.now() - started) / 60000).toFixed(0)} min`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await pool.stop();
if (DETECT) fs.writeFileSync(process.env.OUT ?? '/tmp/with-targets.txt', [...found].sort().join('\n') + '\n');
else fs.writeFileSync(process.env.OUT ?? '/tmp/targetlab.tsv', lines.join(''));
console.error(`done: ${done} runs, ${withTargets} with targets (${found.size} scripts), ${((Date.now() - started) / 60000).toFixed(0)} min`);
process.exit(0);
