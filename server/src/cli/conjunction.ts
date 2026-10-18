/**
 * The conjunction test (decision 130): an entry only when two scanners fire on the same closed bar, same side, same
 * market and timeframe, judged on the nightly screen's own path and against each component alone on identical history.
 *
 *   PAIRS=pairs.txt [BARS=15m=4000] [OUT=conj.md] [CONCURRENCY=2] npm run conjunction
 *
 * pairs.txt, one conjunction per line: `<scannerA> <scannerB> <tf> <SYM,SYM,…>`. The conjunction is run twice, once
 * with each scanner's events (its levels and exits) gated by the other's entries. Measurement only: nothing is
 * promoted, no setting changes.
 */
import fs from 'node:fs';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { PinePool, processWorker } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest, type BacktestInput } from '../paper/backtest.ts';
import { screenVerdict, type ScreenResult } from '../incubator/cycle.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
const inc = cfg.incubator;
const lines = fs.readFileSync(process.env.PAIRS!, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 4000, '4h': 2000 };
for (const kv of (process.env.BARS ?? '').split(',').filter(Boolean)) { const [tf, n] = kv.split('='); if (tf && Number(n) > 0) BARS[tf] = Number(n); }
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };
const rest = new DeltaRest();
const registry = new ScannerRegistry();
const pool = new PinePool(Number(process.env.CONCURRENCY ?? 2), 120_000, processWorker);
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const series = new Map<string, Bar[]>();
async function bars(symbol: string, tf: string, n: number): Promise<Bar[]> { const k = `${symbol}:${tf}`; if (!series.has(k)) series.set(k, toBars(await rest.recentCandles(symbol, tf, n, TF_SECONDS[tf]))); return series.get(k)!; }
const market = new Map<string, ReturnType<typeof marketSpec>>();
const bookCost = new Map<string, number>();
try { for (const m of (new Db().kvGet<{ markets: Array<{ symbol: string; bookCostPct: number | null }> }>('risk.marketsToday')?.markets ?? [])) if (m.bookCostPct != null) bookCost.set(m.symbol, m.bookCostPct); } catch { /* no reading: no spread */ }

const eventCache = new Map<string, ScanEvent[] | null>();
async function eventsFor(id: string, symbol: string, tf: string, b: Bar[]): Promise<ScanEvent[] | null> {
  const k = `${id}:${symbol}:${tf}`;
  if (eventCache.has(k)) return eventCache.get(k)!;
  const s = registry.get(id); if (!s || s.status !== 'ok') { eventCache.set(k, null); return null; }
  const sc = cfg.scanners[id] ?? {};
  const res = await pool.run({ scannerId: id, source: s.patched, symbol, tf, tickSize: market.get(symbol)!.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone });
  if (!res.ok) { console.error(`  ${id} ${symbol} ${tf}: ${res.error}`); eventCache.set(k, null); return null; }
  const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars: b, mode: 'backtest' });
  const ev = extractEvents(res.alerts, res.shapes, { derived, sources: sc.sources, edge: sc.edge, labels: sc.labels, invert: sc.invert });
  eventCache.set(k, ev); return ev;
}
/** A's events with its entries kept only where B also entered on the same bar and side. */
function gate(a: ScanEvent[], b: ScanEvent[]): ScanEvent[] {
  const key = new Set(b.filter(e => e.kind === 'entry' && e.side).map(e => `${e.barTime}:${e.side}`));
  return a.filter(e => e.kind !== 'entry' || (e.side && key.has(`${e.barTime}:${e.side}`)));
}
interface Cell { trades: number; avgR: number; sumR: number; pf: number; windowsUp: number; r1: number; r2: number; holdR: number | null; pass: boolean; sl: number; peak: number; density: number }
function judge(id: string, symbol: string, tf: string, b: Bar[], events: ScanEvent[]): Cell {
  const m = market.get(symbol)!; const sc = cfg.scanners[id] ?? {};
  const base: BacktestInput = { scannerId: id, scannerName: id, symbol, tf, bars: b, events, cfg: cfg.paper, exitMode: sc.exitMode ?? 'both', trendGate: sc.trendGate, scannerExit: sc.exit, contractValue: m.contractValue, tickSize: m.tickSize, maintenanceMarginPct: m.maintenanceMarginPct, maxLeverage: m.maxLeverage, subBars: series.get(`${symbol}:${SUB[tf]}`), spreadPct: bookCost.get(symbol) ?? 0, chopGate: cfg.risk.regime?.enabled && (cfg.risk.regime.minEr ?? 0) > 0 ? { minEr: cfg.risk.regime.minEr } : undefined } as any;
  const bt = runBacktest(base); const stressed = runBacktest({ ...base, cfg: { ...cfg.paper, slippageBps: inc.screen.stressBps } });
  const r: ScreenResult = screenVerdict(bt.trades as any[], stressed.trades as any[], b, inc, Date.now(), events.filter(e => e.kind === 'entry').length);
  const t = bt.trades as any[]; const rs = t.map(x => x.rMultiple ?? 0);
  return { trades: t.length, avgR: t.length ? rs.reduce((a, x) => a + x, 0) / t.length : 0, sumR: rs.reduce((a, x) => a + x, 0), pf: r.profitFactor, windowsUp: r.windowsUp, r1: r.avgR1 ?? 0, r2: r.avgR2 ?? 0, holdR: r.holdoutAvgR ?? null, pass: r.pass && r.holdoutPass !== false, sl: t.length ? t.filter(x => x.exitReason === 'sl').length / t.length : 0, peak: t.length ? t.reduce((a, x) => a + (x.peakR ?? 0), 0) / t.length : 0, density: r.entryDensity ?? 0 };
}
const f = (x: number, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const pool_ = (cells: Cell[]): Cell => { const n = cells.reduce((a, c) => a + c.trades, 0); const sum = cells.reduce((a, c) => a + c.sumR, 0); const w = (k: keyof Cell) => n ? cells.reduce((a, c) => a + (c[k] as number) * c.trades, 0) / n : 0; return { trades: n, avgR: n ? sum / n : 0, sumR: sum, pf: 0, windowsUp: 0, r1: w('r1'), r2: w('r2'), holdR: w('holdR' as any), pass: cells.some(c => c.pass), sl: w('sl'), peak: w('peak'), density: w('density') }; };

const md: string[] = [`# Conjunction test — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '', `An entry only when both scanners enter on the same closed bar and side. Screen path: ${inc.screen.minTrades}+ trades, PF ${inc.screen.minProfitFactor}, ${inc.screen.minWindowsUp}/8 windows, both halves, stressed ${inc.screen.stressBps} bps, holdout ${(inc.screen.holdoutShare ?? 0.3) * 100}%; the fleet's current exits (trail ${cfg.paper.trailGiveBackPct}%); book cost paid.`, ''];
let cleared = 0, beat = 0, totalConj = 0, totalBetter = 0, nConj = 0;
for (const line of lines) {
  const [A, B, tf, syms] = line.split(/\s+/); const markets = syms.split(',');
  for (const s of markets) if (!market.has(s)) { try { market.set(s, marketSpec(await rest.product(s))); } catch { console.error(`no market ${s}`); } }
  const rows: Array<{ sym: string; a: Cell; b: Cell; ab: Cell; ba: Cell }> = [];
  for (const sym of markets) {
    if (!market.has(sym)) continue;
    const b = await bars(sym, tf, BARS[tf]); await bars(sym, SUB[tf], Math.min(60_000, Math.ceil((b.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]])));
    const ea = await eventsFor(A, sym, tf, b), eb = await eventsFor(B, sym, tf, b); if (!ea || !eb) continue;
    rows.push({ sym, a: judge(A, sym, tf, b, ea), b: judge(B, sym, tf, b, eb), ab: judge(A, sym, tf, b, gate(ea, eb)), ba: judge(B, sym, tf, b, gate(eb, ea)) });
    console.error(`${A} + ${B} ${sym} ${tf}: A ${rows.at(-1)!.a.trades} B ${rows.at(-1)!.b.trades} both ${rows.at(-1)!.ab.trades}/${rows.at(-1)!.ba.trades} trades`);
  }
  if (!rows.length) continue;
  nConj++;
  md.push(`## ${A} + ${B} · ${tf} · ${rows.map(r => r.sym).join(', ')}`, '', '| market | reading | trades | avg R | sum R | PF | windows | half 1 | half 2 | holdout | stop-outs | peak R | screen |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) for (const [name, c] of [[A + ' alone', r.a], [B + ' alone', r.b], ['both, ' + A + "'s levels", r.ab], ['both, ' + B + "'s levels", r.ba]] as Array<[string, Cell]>)
    md.push(`| ${r.sym} | ${name} | ${c.trades} | ${f(c.avgR, 3)} | ${f(c.sumR, 1)} | ${c.pf.toFixed(2)} | ${c.windowsUp}/8 | ${f(c.r1, 3)} | ${f(c.r2, 3)} | ${c.holdR == null ? '–' : f(c.holdR, 3)} | ${(c.sl * 100).toFixed(0)}% | ${c.peak.toFixed(2)} | ${c.pass ? 'pass' : 'fail'} |`);
  const pa = pool_(rows.map(r => r.a)), pb = pool_(rows.map(r => r.b)), pab = pool_(rows.map(r => r.ab)), pba = pool_(rows.map(r => r.ba));
  const best = [pab, pba].sort((x, y) => y.avgR - x.avgR)[0]; const bestName = best === pab ? `${A}'s levels` : `${B}'s levels`;
  const better = pa.avgR >= pb.avgR ? pa : pb; const betterName = better === pa ? A : B;
  const perMarket = rows.map(r => { const c = best === pab ? r.ab : r.ba; const comp = better === pa ? r.a : r.b; return c.sumR - comp.sumR; });
  const up = perMarket.filter(x => x > 0.5).length, dn = perMarket.filter(x => x < -0.5).length;
  const clears = rows.some(r => (best === pab ? r.ab : r.ba).pass); const beats = best.trades > 0 && best.avgR > better.avgR && best.r1 > 0 && best.r2 > 0 && dn <= up;
  if (clears) cleared++; if (beats) beat++; totalConj += best.sumR; totalBetter += better.sumR;
  md.push('', `Pooled: ${A} alone ${f(pa.avgR, 3)}R over ${pa.trades} · ${B} alone ${f(pb.avgR, 3)}R over ${pb.trades} · conjunction (${bestName}) ${f(best.avgR, 3)}R over ${best.trades}, halves ${f(best.r1, 2)} / ${f(best.r2, 2)}, stop-outs ${(best.sl * 100).toFixed(0)}% against ${(better.sl * 100).toFixed(0)}% for ${betterName}.`,
    `Clears the screen on any market: **${clears ? 'yes' : 'no'}**. Beats the better component (${betterName}, ${f(better.avgR, 3)}R) on the cell yardstick: **${beats ? 'yes' : 'no'}**. Markets better / worse than it: ${up} / ${dn}.`, '');
}
md.push('## Summary', '', `${nConj} conjunctions run. ${cleared} cleared the screen on at least one market; ${beat} beat their better component on the cell yardstick (higher R per trade, both halves positive, not worse on a majority of markets).`, `Sum R of the conjunctions ${f(totalConj, 1)} against ${f(totalBetter, 1)} for their better components on the same history.`);
fs.writeFileSync(process.env.OUT ?? '/tmp/conjunction.md', md.join('\n') + '\n');
console.error(`done: ${nConj} conjunctions · ${process.env.OUT ?? '/tmp/conjunction.md'}`);
await pool.stop();
process.exit(0);
