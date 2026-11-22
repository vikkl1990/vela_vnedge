#!/usr/bin/env node
/**
 * Replay every resting-limit entry both ways on 1m candles (decision 332). Read-only; public market data only, no keys.
 *
 *   CASES=cases.json PAPER=paper.json OUT=out/ CACHE=cache/ node server/src/cli/limit-entry-replay.ts
 *
 *   CASES    the export made by docs/research/limit-entry-replay-2026-11-23/vm-queries/export-cases.mjs
 *   PAPER    the `paper` section of the config that traded them (from the same export)
 *   OUT      results.json and results.md are written here
 *   CACHE    downloaded candles are kept here, so a stopped run resumes
 *   HORIZON_H  hours a trade may run before it is censored (default 120)
 *   SYMBOLS  comma list to restrict the run (a smoke test); MAX_CASES caps the cases
 *
 * See the README beside the export for the question, the arms and the reading rule, which were written before this ran.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { lastAtr } from '../data/indicators.ts';
import type { Bar } from '../data/candleStore.ts';
import { TF_SECONDS, type PaperConfig } from '../config.ts';
import { productFees, withProductFees } from '../paper/productFees.ts';
import { calibration, replayLimitCase, summarize, type Bar1m, type CaseResult, type Group, type LimitCase } from '../research/limitEntryReplay.ts';

interface ExportedCase extends LimitCase { barTime: number | null }
const env = process.env;
const CASES = env.CASES, PAPER = env.PAPER, OUT = env.OUT ?? 'limit-replay-out', CACHE = env.CACHE ?? path.join(OUT, 'candles');
if (!CASES || !PAPER) throw new Error('set CASES and PAPER');
const HORIZON_H = Number(env.HORIZON_H ?? 120), MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const paper = JSON.parse(fs.readFileSync(PAPER, 'utf8')) as PaperConfig;
let cases = (JSON.parse(fs.readFileSync(CASES, 'utf8')).cases as ExportedCase[]).filter((c) => c.tf in TF_SECONDS);
if (env.SYMBOLS) { const s = new Set(env.SYMBOLS.split(',')); cases = cases.filter((c) => s.has(c.symbol)); }
if (env.MAX_CASES) cases = cases.slice(0, Number(env.MAX_CASES));
fs.mkdirSync(CACHE, { recursive: true });
const rest = new DeltaRest();
const products = await rest.products();
const now = Date.now();

/** Candles from the cache or the public API, in windows of seven days; a window still in progress is never cached. */
async function candles(symbol: string, res: string, fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  const W = 7 * DAY;
  for (let s = Math.floor(fromMs / W) * W; s < toMs; s += W) {
    const file = path.join(CACHE, `${symbol}-${res}-${s}.json`);
    let list: Bar[] | null = null;
    if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      const raw = await rest.candles(symbol, res, Math.floor(s / 1000), Math.floor(Math.min(s + W, now) / 1000) - 1, 60_000);
      list = raw.map((c) => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      if (s + W + HOUR < now) fs.writeFileSync(file, JSON.stringify(list));
    }
    out.push(...list!);
  }
  const seen = new Set<number>();
  return out.filter((b) => b.time >= fromMs && b.time <= toMs && (seen.has(b.time) ? false : (seen.add(b.time), true))).sort((a, b) => a.time - b.time);
}

const bySymbol = new Map<string, ExportedCase[]>();
for (const c of cases) (bySymbol.get(c.symbol) ?? bySymbol.set(c.symbol, []).get(c.symbol)!).push(c);
const results: CaseResult[] = [];
const tick = new Map<string, number>();
/** The 1h orders rest 0.1 ATR from the reference, so the recorded price implies the ATR the engine used. It checks the candle ATR and the reference rebuilt from candles. */
const atrCheck: Record<string, number[]> = {};
let done = 0;
for (const [symbol, list] of bySymbol) {
  const product = products.get(symbol);
  if (!product) { for (const c of list) { const r = { status: 'unverified' as const, reason: 'product not listed' }; results.push({ case: c, limit: r, market: r }); } continue; }
  const spec = marketSpec(product);
  tick.set(symbol, spec.tickSize);
  const cfg = withProductFees(paper, productFees(product), symbol);
  const lo = Math.min(...list.map((c) => c.signalAt)), hi = Math.max(...list.map((c) => c.signalAt));
  const horizon = HORIZON_H * HOUR;
  let m1: Bar[] = [];
  try { m1 = await candles(symbol, '1m', lo - 10 * MIN, Math.min(now, hi + horizon + 12 * HOUR)); } catch (e) { console.error(`${symbol}: 1m candles failed: ${(e as Error).message}`); }
  const bars: Bar1m[] = m1.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const tfBars = new Map<string, Bar[]>();
  for (const tf of new Set(list.map((c) => c.tf))) {
    const tfMs = TF_SECONDS[tf] * 1000;
    try { tfBars.set(tf, await candles(symbol, tf, lo - 60 * tfMs, hi)); } catch (e) { console.error(`${symbol} ${tf}: candles failed: ${(e as Error).message}`); }
  }
  for (const c of list) {
    const tfMs = TF_SECONDS[c.tf] * 1000;
    const barTime = c.barTime ?? Math.floor(c.signalAt / tfMs) * tfMs - tfMs;
    const upTo = (tfBars.get(c.tf) ?? []).filter((b) => b.time <= barTime).slice(-200);
    const atr = lastAtr(upTo, 14);
    const sigBar = upTo.find((b) => b.time === barTime);
    const reference = c.reference > 0 ? c.reference : sigBar?.close;
    const le = cfg.limitEntry;
    const from = (() => { let a = 0, b = bars.length; const t = c.signalAt - 2 * MIN; while (a < b) { const m = (a + b) >> 1; if (bars[m].time < t) a = m + 1; else b = m; } return a; })();
    const slice = bars.slice(from, from + Math.ceil((horizon + 12 * HOUR) / MIN) + 10);
    const off = le?.atrByTf?.[c.tf] ?? le?.atr ?? 0;
    if (atr && reference && off > 0 && c.limitPrice) (atrCheck[c.tf] ??= []).push((Math.abs(reference - c.limitPrice) / off) / atr);
    const r = !atr || !reference ? (() => { const x = { status: 'unverified' as const, reason: !atr ? 'no ATR' : 'signal bar missing' }; return { case: c, limit: x, market: x }; })()
      : replayLimitCase({ ...c, atr, reference }, slice, { cfg, market: spec, equity: cfg.initialEquity, horizonMs: horizon, atrOffset: le?.atrByTf?.[c.tf] ?? le?.atr ?? 0, bars: le?.bars ?? 2 });
    results.push(r);
    done++;
  }
  console.error(`${symbol}: ${list.length} cases (${done}/${cases.length})`);
}

// ---- report ----
const f = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? '–' : (x >= 0 ? '+' : '') + x.toFixed(d));
const est = (e: { mean: number | null; se: number | null }) => `${f(e.mean)} ±${e.se === null ? '–' : e.se.toFixed(3)}`;
const row = (name: string, g: Group) => `| ${name} | ${g.signals} | ${g.fillRatePct ?? '–'}% | ${est(g.limitR)} | ${est(g.marketR)} | ${est(g.difference)} | ${g.verdict} | ${est(g.missedMinusTaken)} |`;
const head = '| group | signals | fill rate | limit R/signal | market R/signal | limit − market | verdict | unfilled − filled (market R) |\n|---|---:|---:|---:|---:|---:|---|---:|';
const s = summarize(results);
const cal = calibration(results, (sym) => tick.get(sym) ?? 0);
const lines: string[] = [];
lines.push(`# Limit entry replay — ${new Date().toISOString().slice(0, 10)}`, '', `${cases.length} limit-path signals, ${HORIZON_H}h horizon. Read README.md for the question, the arms and the reading rule, which were fixed before this ran.`, '');
lines.push('## Counts', '', '```', JSON.stringify(s.counts, null, 1), '```', '');
lines.push('## Result (per signal, net R after fees; ± is a standard error clustered by day)', '', head, row('all (both books)', s.all));
for (const [k, g] of Object.entries(s.byBook)) lines.push(row(`book: ${k}`, g));
for (const [k, g] of Object.entries(s.byTf)) lines.push(row(`timeframe: ${k}`, g));
for (const [k, g] of Object.entries(s.bySide)) lines.push(row(`side: ${k}`, g));
lines.push('', '"all (both books)" counts a signal once per book it reached; the account and shadow rows are the independent readings.', '');
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : null; };
lines.push('## Does the rebuilt reference and ATR match what the engine used?', '', 'Recorded 1h limit price implies an ATR; the ratio is the candle ATR over that implied ATR (1.00 = identical).', '', '```', JSON.stringify(Object.fromEntries(Object.entries(atrCheck).map(([tf, a]) => [tf, { n: a.length, p10: q(a, 0.1), median: q(a, 0.5), p90: q(a, 0.9), within10pct: a.length ? Math.round(100 * a.filter((x) => Math.abs(x - 1) <= 0.1).length / a.length) + '%' : null }])), null, 1), '```', '');
lines.push('## Does the replay reproduce the account?', '', '```', JSON.stringify(cal, null, 1), '```', '');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'results.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ at: new Date().toISOString(), horizonH: HORIZON_H, summary: s, calibration: cal, results }, null, 1));
console.log(lines.join('\n'));
