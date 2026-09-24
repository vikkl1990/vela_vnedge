/**
 * Survey a set of scripts across timeframes and markets, with the live execution model.
 *
 *   IDS=ids.txt TFS=5m,15m,1h,4h MARKETS=BTCUSD,ETHUSD,… OUT=rows.tsv npm run survey
 *
 * Every (script, timeframe, market) is backtested with exits resolved on finer candles (1m for 5m and
 * 15m; 5m for 1h and 4h, where 1m history does not reach), the live exit rules, fees with GST, the
 * Scalper Offer when enabled, and again at `STRESS_BPS` of slippage. A script that produces no entry
 * on its first two markets at a timeframe is skipped for the rest at that timeframe.
 *
 * PAPER=file.json takes the paper settings from a file (e.g. the VM's). Runs `CONCURRENCY` jobs at a
 * time; each Pine worker is heap-capped by the pool.
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
const TFS = (process.env.TFS ?? '5m,15m,1h,4h').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD,XRPUSD,DOGEUSD').split(',');
const CONC = Number(process.env.CONCURRENCY ?? 8);
const STRESS = Number(process.env.STRESS_BPS ?? 10);
const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
/** DEEP=15m:12000,1h:6000 asks for a longer history than the default per timeframe. */
for (const part of (process.env.DEEP ?? '').split(',').filter(Boolean)) {
  const [tf, n] = part.split(':'); BARS[tf] = Number(n);
}
/**
 * Candles the exits are resolved on. 1m for the fast timeframes; 15m for 1h and 4h, which is still
 * far finer than the signal bar and costs one request per market instead of twenty for deep 5m.
 */
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };
/**
 * GATE=follow|fade|off with GATE_LEN and GATE_TF turns on the real trend gate (`paper.trendGate`),
 * so what is measured here is the same code the bot runs — not a filter that only exists in the lab.
 */
if (process.env.GATE) {
  cfg.paper.trendGate = { enabled: process.env.GATE !== 'off', emaLen: Number(process.env.GATE_LEN ?? 50), tf: process.env.GATE_TF ?? '', mode: process.env.GATE as any };
}

const out = fs.createWriteStream(process.env.OUT ?? '/tmp/survey.tsv', { flags: process.env.APPEND ? 'a' : 'w' });
if (!process.env.APPEND) out.write(['scanner', 'tf', 'symbol', 'trades', 'wins', 'net', 'pf', 'avgR', 'netStress', 'windowsUp', 'days'].join('\t') + '\n');

const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const market = new Map<string, { contractValue: number; tickSize: number }>();
const series = new Map<string, Bar[]>();
async function bars(symbol: string, tf: string, n: number): Promise<Bar[]> {
  const k = `${symbol}:${tf}:${n}`;
  if (!series.has(k)) series.set(k, toBars(await rest.recentCandles(symbol, tf, n, TF_SECONDS[tf])));
  return series.get(k)!;
}
for (const s of MARKETS) { const p = await rest.product(s); market.set(s, { contractValue: Number(p?.contract_value ?? 0.001), tickSize: Number(p?.tick_size ?? 0.5) }); }
// candles first, once: the sub-series covers the longest span needed per market
for (const s of MARKETS) {
  for (const tf of TFS) {
    const b = await bars(s, tf, BARS[tf]);
    const need = Math.ceil((b.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]]);
    await bars(s, SUB[tf], Math.min(need, 60_000));
  }
  console.error(`  candles ready: ${s}`);
}
console.error(`survey: ${ids.length} scripts × ${TFS.join(',')} × ${MARKETS.length} markets, concurrency ${CONC}`);

const pool = new PinePool(CONC, 120_000);
type Job = { id: string; tf: string; symbol: string };
async function runOne(j: Job): Promise<'entries' | 'silent' | 'failed'> {
  const s = registry.get(j.id)!;
  const b = series.get(`${j.symbol}:${j.tf}:${BARS[j.tf]}`)!;
  const sub = [...series.entries()].find(([k]) => k.startsWith(`${j.symbol}:${SUB[j.tf]}:`))?.[1];
  const m = market.get(j.symbol)!;
  const inputs = cfg.scanners[s.id]?.inputs;
  const res = await pool.run({ scannerId: s.id, source: s.patched, symbol: j.symbol, tf: j.tf, tickSize: m.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined });
  if (!res.ok) return 'failed';
  const derived = applyRules({ scannerId: s.id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[s.id]?.rule ?? null, bars: b, mode: 'backtest' });
  const events = extractEvents(res.alerts, res.shapes, { derived });
  if (!events.some(e => e.kind === 'entry')) return 'silent';
  const base = { scannerId: s.id, scannerName: s.id, symbol: j.symbol, tf: j.tf, bars: b, events, cfg: cfg.paper, exitMode: cfg.scanners[s.id]?.exitMode ?? 'both', trendGate: cfg.scanners[s.id]?.trendGate, contractValue: m.contractValue, tickSize: m.tickSize, subBars: sub } as const;
  const t = runBacktest(base).trades as any[];
  const stressed = runBacktest({ ...base, cfg: { ...cfg.paper, slippageBps: STRESS } }).stats.pnl;
  const span = (b.at(-1)!.time - b[0].time) / 8; const w = new Array(8).fill(0);
  for (const x of t) w[Math.min(7, Math.floor((x.entryAt - b[0].time) / span))] += x.pnl;
  const gp = t.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0), gl = -t.filter(x => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0);
  out.write([s.id, j.tf, j.symbol, t.length, t.filter(x => x.pnl > 0).length, (gp - gl).toFixed(2), (gl > 0 ? gp / gl : gp > 0 ? 99 : 0).toFixed(3),
    (t.length ? t.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / t.length : 0).toFixed(3), stressed.toFixed(2), w.filter(x => x > 0).length, ((b.at(-1)!.time - b[0].time) / 86400_000).toFixed(0)].join('\t') + '\n');
  return 'entries';
}

// one task per (script, tf): its markets in order, stopping early if the first two are silent
let done = 0, runs = 0, failed = 0, silent = 0;
const tasks = ids.filter(id => registry.get(id)?.status === 'ok').flatMap(id => TFS.map(tf => ({ id, tf })));
const started = Date.now();
async function worker() {
  for (;;) {
    const t = tasks.shift(); if (!t) return;
    let entries = false;
    for (let i = 0; i < MARKETS.length; i++) {
      if (i >= 2 && !entries) { silent += MARKETS.length - i; break; }
      runs++;
      try { const r = await runOne({ ...t, symbol: MARKETS[i] }); if (r === 'entries') entries = true; else if (r === 'failed') { failed++; break; } }
      catch { failed++; break; }
    }
    if (++done % 100 === 0) console.error(`  ${done}/${done + tasks.length} script×tf · ${runs} runs · ${failed} failed · ${((Date.now() - started) / 60000).toFixed(0)} min`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
await pool.stop(); out.end();
console.error(`done: ${runs} runs, ${failed} failed, ${silent} skipped as silent, ${((Date.now() - started) / 60000).toFixed(0)} min`);
