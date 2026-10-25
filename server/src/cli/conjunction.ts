/**
 * The conjunction test (decision 130): an entry only when two scanners fire on the same closed bar, same side, same
 * market and timeframe, judged on the nightly screen's own path and against each component alone on identical history.
 *
 *   PAIRS=pairs.txt [BARS=15m=4000] [OUT=conj.md] [CONCURRENCY=2] npm run conjunction
 *
 * pairs.txt, one conjunction per line: `<scannerA> <scannerB> <tf> <SYM,SYM,…>`. The conjunction is run twice, once
 * with each scanner's events (its levels and exits) gated by the other's entries. Measurement only: nothing is
 * promoted, no setting changes.
 *
 * Cross-timeframe (decision 134): `<htfScanner> <htfTf> <ltfScanner> <ltfTf> <SYM,…>`. A lower-timeframe entry is kept
 * only when the higher-timeframe scanner agrees at the moment the lower bar closes, read two ways: its signal state
 * (the side of its last entry, until an exit for that side or an opposite entry) and its position (an open trade on
 * that side under the fleet's exits). Only higher bars that had closed by then count, so there is no look-ahead.
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
import { crossingPct } from '../risk/marketGate.ts';

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
try { for (const m of (new Db().kvGet<{ markets: Array<{ symbol: string; bookCostPct: number | null }> }>('risk.marketsToday')?.markets ?? [])) if (m.bookCostPct != null) bookCost.set(m.symbol, crossingPct(m.bookCostPct, cfg.paper)); /* decision 202: crossing only, the backtest charges the fees */ } catch { /* no reading: no spread */ }

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
function baseFor(id: string, symbol: string, tf: string, b: Bar[], events: ScanEvent[]): BacktestInput {
  const m = market.get(symbol)!; const sc = cfg.scanners[id] ?? {};
  return { scannerId: id, scannerName: id, symbol, tf, bars: b, events, cfg: cfg.paper, exitMode: sc.exitMode ?? 'both', trendGate: sc.trendGate, scannerExit: sc.exit, contractValue: m.contractValue, tickSize: m.tickSize, maintenanceMarginPct: m.maintenanceMarginPct, maxLeverage: m.maxLeverage, subBars: series.get(`${symbol}:${SUB[tf]}`), spreadPct: bookCost.get(symbol) ?? 0, chopGate: cfg.risk.regime?.enabled && (cfg.risk.regime.minEr ?? 0) > 0 ? { minEr: cfg.risk.regime.minEr } : undefined } as any;
}
/** The higher scanner's signal state: [the time it became known, the side or null], in time order. */
function htfStates(events: ScanEvent[], htfMs: number): Array<[number, 'long' | 'short' | null]> {
  const out: Array<[number, 'long' | 'short' | null]> = []; let st: 'long' | 'short' | null = null;
  for (const e of [...events].sort((a, b) => a.barTime - b.barTime)) {
    const at = e.barTime + htfMs;
    if (e.kind === 'entry' && e.side) { st = e.side; out.push([at, st]); }
    else if (e.kind === 'exit' && e.side && e.side === st) { st = null; out.push([at, null]); }
  }
  return out;
}
const stateAt = (states: Array<[number, 'long' | 'short' | null]>, t: number) => { let lo = 0, hi = states.length - 1, ans: 'long' | 'short' | null = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (states[mid][0] <= t) { ans = states[mid][1]; lo = mid + 1; } else hi = mid - 1; } return ans; };
function gateByState(ltf: ScanEvent[], states: Array<[number, 'long' | 'short' | null]>, ltfMs: number): ScanEvent[] {
  return ltf.filter(e => e.kind !== 'entry' || (e.side && stateAt(states, e.barTime + ltfMs) === e.side));
}
function gateByPosition(ltf: ScanEvent[], htfTrades: any[], htfMs: number, ltfMs: number): ScanEvent[] {
  return ltf.filter(e => { if (e.kind !== 'entry' || !e.side) return e.kind !== 'entry'; const d = e.barTime + ltfMs; return htfTrades.some(t => t.side === e.side && t.entryAt + htfMs <= d && d < (t.exitAt ?? Infinity)); });
}
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
let xCleared = 0, xBeat = 0, xConj = 0, xBetter = 0, xN = 0, xJoint = 0, xLtf = 0, xLtfSum = 0, xLtfBeat = 0;
async function crossTf([H, htf, L, ltf, syms]: string[]): Promise<void> {
  const markets = syms.split(','); const htfMs = TF_SECONDS[htf] * 1000, ltfMs = TF_SECONDS[ltf] * 1000;
  for (const s of markets) if (!market.has(s)) { try { market.set(s, marketSpec(await rest.product(s))); } catch { console.error(`no market ${s}`); } }
  const rows: Array<{ sym: string; h: Cell; l: Cell; st: Cell; pos: Cell; ltfEntries: number; stEntries: number; posEntries: number }> = [];
  for (const sym of markets) {
    if (!market.has(sym)) continue;
    const hb = await bars(sym, htf, BARS[htf]); await bars(sym, SUB[htf], Math.min(60_000, Math.ceil((hb.length + 2) * TF_SECONDS[htf] / TF_SECONDS[SUB[htf]])));
    const lb = await bars(sym, ltf, BARS[ltf]); await bars(sym, SUB[ltf], Math.min(60_000, Math.ceil((lb.length + 2) * TF_SECONDS[ltf] / TF_SECONDS[SUB[ltf]])));
    const eh = await eventsFor(H, sym, htf, hb), el = await eventsFor(L, sym, ltf, lb); if (!eh || !el) continue;
    const hTrades = runBacktest(baseFor(H, sym, htf, hb, eh)).trades as any[];
    const st = gateByState(el, htfStates(eh, htfMs), ltfMs), pos = gateByPosition(el, hTrades, htfMs, ltfMs);
    const n = (x: ScanEvent[]) => x.filter(e => e.kind === 'entry').length;
    rows.push({ sym, h: judge(H, sym, htf, hb, eh), l: judge(L, sym, ltf, lb, el), st: judge(L, sym, ltf, lb, st), pos: judge(L, sym, ltf, lb, pos), ltfEntries: n(el), stEntries: n(st), posEntries: n(pos) });
    const r = rows.at(-1)!; console.error(`${H} ${htf} > ${L} ${ltf} ${sym}: HTF ${r.h.trades} LTF ${r.l.trades} gated ${r.st.trades}/${r.pos.trades} trades (entries ${r.ltfEntries} → ${r.stEntries}/${r.posEntries})`);
  }
  if (!rows.length) return;
  xN++;
  md.push(`## ${H} ${htf} gating ${L} ${ltf} · ${rows.map(r => r.sym).join(', ')}`, '', '| market | reading | entries | trades | avg R | sum R | PF | windows | half 1 | half 2 | holdout | stop-outs | peak R | screen |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) for (const [name, c, e] of [[`${H} ${htf} alone`, r.h, '–'], [`${L} ${ltf} alone`, r.l, r.ltfEntries], [`${ltf} entry, ${htf} signal agrees`, r.st, r.stEntries], [`${ltf} entry, ${htf} position open`, r.pos, r.posEntries]] as Array<[string, Cell, number | string]>)
    md.push(`| ${r.sym} | ${name} | ${e} | ${c.trades} | ${f(c.avgR, 3)} | ${f(c.sumR, 1)} | ${c.pf.toFixed(2)} | ${c.windowsUp}/8 | ${f(c.r1, 3)} | ${f(c.r2, 3)} | ${c.holdR == null ? '–' : f(c.holdR, 3)} | ${(c.sl * 100).toFixed(0)}% | ${c.peak.toFixed(2)} | ${c.pass ? 'pass' : 'fail'} |`);
  const ph = pool_(rows.map(r => r.h)), pl = pool_(rows.map(r => r.l)), pst = pool_(rows.map(r => r.st)), ppos = pool_(rows.map(r => r.pos));
  const better = ph.avgR >= pl.avgR ? ph : pl; const betterName = better === ph ? `${H} ${htf}` : `${L} ${ltf}`; const comp = (r: typeof rows[number]) => (better === ph ? r.h : r.l);
  // both readings judged in full; the gate is credited if either one wins (two chances, generous to the idea)
  const judgeReading = (pooled: Cell, pick: (r: typeof rows[number]) => Cell, entries: (r: typeof rows[number]) => number) => {
    const per = rows.map(r => pick(r).sumR - comp(r).sumR); const up = per.filter(x => x > 0.5).length, dn = per.filter(x => x < -0.5).length;
    return { pooled, up, dn, clears: rows.some(r => pick(r).pass), beats: pooled.trades > 0 && pooled.avgR > better.avgR && pooled.r1 > 0 && pooled.r2 > 0 && dn <= up, joint: rows.reduce((a, r) => a + entries(r), 0) };
  };
  const rs = judgeReading(pst, r => r.st, r => r.stEntries), rp = judgeReading(ppos, r => r.pos, r => r.posEntries);
  const ltfAll = rows.reduce((a, r) => a + r.ltfEntries, 0);
  const clears = rs.clears || rp.clears, beats = rs.beats || rp.beats;
  if (clears) xCleared++; if (beats) xBeat++; xConj += Math.max(pst.sumR, ppos.sumR); xBetter += better.sumR; xJoint += Math.max(rs.joint, rp.joint); xLtf += ltfAll;
  xLtfSum += pl.sumR; const filterHelps = [pst, ppos].some(x => x.trades > 0 && x.avgR > pl.avgR && x.r1 > 0 && x.r2 > 0 && x.sumR >= pl.sumR); if (filterHelps) xLtfBeat++;
  const line = (name: string, x: ReturnType<typeof judgeReading>) => `${name}: ${f(x.pooled.avgR, 3)}R over ${x.pooled.trades} trades, sum ${f(x.pooled.sumR, 1)}, halves ${f(x.pooled.r1, 2)} / ${f(x.pooled.r2, 2)}, stop-outs ${(x.pooled.sl * 100).toFixed(0)}%, joint entries ${x.joint} of ${ltfAll} (${ltfAll ? (x.joint / ltfAll * 100).toFixed(0) : 0}%), markets better / worse than ${betterName} ${x.up} / ${x.dn}, clears the screen ${x.clears ? 'yes' : 'no'}, beats it ${x.beats ? 'yes' : 'no'}.`;
  md.push('', `Pooled: ${H} ${htf} alone ${f(ph.avgR, 3)}R over ${ph.trades} (sum ${f(ph.sumR, 1)}) · ${L} ${ltf} alone ${f(pl.avgR, 3)}R over ${pl.trades} (sum ${f(pl.sumR, 1)}). Better component: ${betterName}.`,
    '', `- ${line(`${htf} signal agrees`, rs)}`, `- ${line(`${htf} position open`, rp)}`, '',
    `Clears the screen on any market: **${clears ? 'yes' : 'no'}**. Beats the better component on the cell yardstick: **${beats ? 'yes' : 'no'}**. Improves ${L} ${ltf} as a filter (higher R per trade, both halves positive, and no less total R): **${filterHelps ? 'yes' : 'no'}**.`, '');
}
let cleared = 0, beat = 0, totalConj = 0, totalBetter = 0, nConj = 0;
for (const line of lines) {
  const parts = line.split(/\s+/);
  if (parts.length === 5) { await crossTf(parts); continue; }
  const [A, B, tf, syms] = parts; const markets = syms.split(',');
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
if (xN) md.push('## Cross-timeframe summary', '', `${xN} higher-timeframe gates run. ${xCleared} cleared the screen on at least one market; ${xBeat} beat their better component on the cell yardstick.`, `Sum R of the gated readings ${f(xConj, 1)} against ${f(xBetter, 1)} for their better components and ${f(xLtfSum, 1)} for the lower-timeframe scanners alone, on the same history. The gate improves the lower scanner as a filter in ${xLtfBeat} of ${xN}. Joint entries ${xJoint} of ${xLtf} lower-timeframe entries (${xLtf ? (xJoint / xLtf * 100).toFixed(0) : 0}%).`, '');
if (nConj) md.push('## Summary', '', `${nConj} conjunctions run. ${cleared} cleared the screen on at least one market; ${beat} beat their better component on the cell yardstick (higher R per trade, both halves positive, not worse on a majority of markets).`, `Sum R of the conjunctions ${f(totalConj, 1)} against ${f(totalBetter, 1)} for their better components on the same history.`);
fs.writeFileSync(process.env.OUT ?? '/tmp/conjunction.md', md.join('\n') + '\n');
console.error(`done: ${nConj} conjunctions, ${xN} cross-timeframe gates · ${process.env.OUT ?? '/tmp/conjunction.md'}`);
await pool.stop();
process.exit(0);
