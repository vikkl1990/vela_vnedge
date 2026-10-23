/**
 * Scanner test (decision 67): for every script × market × timeframe, not "does it pay" but "why
 * does it not, and what would fix it". Every variant below is judged from the same script run and
 * the same events, so the differences are the reading, the exit or the costs — never a different
 * signal set.
 *
 *   IDS=ids.txt TFS=15m,1h,4h MARKETS=BTCUSD,… PAPER=vm-paper.json OUT=diag.tsv MD=diag.md [BARS=15m=4000] npm run diagnose
 *
 * Variants per cell:
 *   base        the fleet's settings (the VM's paper config)
 *   gross       no fees, no slippage — the edge before costs
 *   stop1.5/2   a wider ATR stop (same targets)
 *   tp1         one target at 1R, no trail — do the moves it finds reach 1R at all
 *   levels      our levels, script exit events ignored; script: the script's own exits only — no bot target or trail, a disaster stop (decision 113)
 *   er0.25      the whipsaw gate (decision 66)
 *   lux-*       decision 178: the Vela library's exit models (sigmoid ATR, statistical L1/L2, market structure), replacing the trail or over it (+ours)
 *   inverted    every signal read the other way — a sign error in the reading shows up here
 *   long/short  one direction only
 * Plus the excursion profile (how many trades saw +0.5R / +1R / +2R before they ended, how many
 * were stopped inside the first bar) and the record per signal label. The verdict names the cause
 * the numbers support and the fix to try, in the script or in how it is read.
 */
import fs from 'node:fs';
import { DeltaRest, marketSpec } from '../delta/rest.ts';
import { PinePool, processWorker } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent } from '../scanners/extractor.ts';
import { applyRules } from '../scanners/rules.ts';
import { runBacktest, type BacktestInput } from '../paper/backtest.ts';
import { luxTrailModels } from '../paper/luxExits.ts';
import { compareRepaint, REPAINT_CUT } from '../scanners/repaint.ts';
import { ConfigStore, TF_SECONDS, type PaperConfig } from '../config.ts';
import { Db } from '../db.ts';
import type { Bar } from '../data/candleStore.ts';

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const ids = [...new Set(fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean))];
const TFS = (process.env.TFS ?? '15m,1h,4h').split(',');
const MARKETS = (process.env.MARKETS ?? 'BTCUSD,ETHUSD,SOLUSD').split(',');
const CONC = Number(process.env.CONCURRENCY ?? 4);
const BARS: Record<string, number> = { '5m': 4000, '15m': 8000, '1h': 4000, '4h': 2000 };
// BARS=15m=4000,1h=2000 shortens a history: a script whose drawings grow with the bar count can blow a
// memory cap at 8,000 bars that it never reaches in the nightly screen's 4,000 (Wyckoff Range Engine, 11 Oct)
for (const kv of (process.env.BARS ?? '').split(',').filter(Boolean)) { const [tf, n] = kv.split('='); if (tf && Number(n) > 0) BARS[tf] = Number(n); }
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };
const rest = new DeltaRest();
const registry = new ScannerRegistry();
// an id that is not in the manifest, or a script that does not run, is said so up front: a run that tests nothing is not a result
{
  const unknown = ids.filter(id => !registry.get(id)); const notOk = ids.filter(id => registry.get(id) && registry.get(id)!.status !== 'ok');
  for (const id of unknown) console.error(`unknown scanner id "${id}": ids are the "id" fields in scripts/manifest.json (the scanner page's URL in the dashboard)`);
  for (const id of notOk) console.error(`scanner "${id}" is ${registry.get(id)!.status} and cannot run`);
  if (unknown.length + notOk.length === ids.length) { console.error('nothing to test'); process.exit(2); }
}
const pool = new PinePool(CONC, 120_000, processWorker);
const out = fs.createWriteStream(process.env.OUT ?? '/tmp/diagnose.tsv');
out.write(['scanner', 'tf', 'symbol', 'variant', 'trades', 'avgR', 'sumR', 'win', 't1', 'r1', 't2', 'r2', 'both', 'mfe05', 'mfe1', 'mfe2', 'firstBarStops', 'note'].join('\t') + '\n');
const md: string[] = [];

const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const series = new Map<string, Bar[]>();
async function bars(symbol: string, tf: string, n: number): Promise<Bar[]> {
  const k = `${symbol}:${tf}`;
  if (!series.has(k)) series.set(k, toBars(await rest.recentCandles(symbol, tf, n, TF_SECONDS[tf])));
  return series.get(k)!;
}
const market = new Map<string, ReturnType<typeof marketSpec>>();
// the market gate's last reading of each book (round-trip cost in %), so the honest variants pay the spread the account pays
const bookCost = new Map<string, number>();
try { for (const m of (new Db().kvGet<{ markets: Array<{ symbol: string; bookCostPct: number | null }> }>('risk.marketsToday')?.markets ?? [])) if (m.bookCostPct != null) bookCost.set(m.symbol, m.bookCostPct); } catch { /* no gate reading: the spread variants then equal base */ }
for (const s of MARKETS) { const p = await rest.product(s); market.set(s, marketSpec(p)); }

// ---- context series for the regime test (decision 102): the majors' bias, each market's funding, the top traders' ratio ----
const H = 3600_000;
const btc4h = toBars(await rest.recentCandles('BTCUSD', '4h', 2600, 14400));
const btcBias: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = []; const k = 2 / 51; let ema = btc4h[0]?.close ?? 0; const emas: number[] = [];
  btc4h.forEach((b, i) => { ema = i ? b.close * k + ema * (1 - k) : b.close; emas.push(ema); if (i >= 55) out.push([b.time + 14400_000, b.close > ema && ema > emas[i - 5] ? 1 : b.close < ema && ema < emas[i - 5] ? -1 : 0]); });
  return out;   // [time the bar closed, bias known from then on]
})();
const biasAt = (t: number): number | undefined => { let lo = 0, hi = btcBias.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (btcBias[mid][0] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; } return ans < 0 ? undefined : btcBias[ans][1]; };
const fundingSeries = new Map<string, Map<number, number>>();
const ratioSeries = new Map<string, Map<number, number>>();
for (const s of MARKETS) {
  try { const c = await rest.recentCandles(`FUNDING:${s}`, '1h', 4000, 3600); fundingSeries.set(s, new Map(c.map(x => [x.time * 1000, x.close]))); } catch { fundingSeries.set(s, new Map()); }
  const r = new Map<number, number>();
  try {
    let end = Date.now();
    for (let page = 0; page < 2; page++) {
      const d: any[] = await (await fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${s.replace(/USD$/, 'USDT')}&period=1h&limit=500&endTime=${end}`)).json();
      if (!Array.isArray(d) || !d.length) break;
      for (const x of d) r.set(Number(x.timestamp), Number(x.longShortRatio));
      end = Number(d[0].timestamp) - 1;
    }
  } catch { /* not listed on Binance, or blocked: the ratio variant then has no window here */ }
  ratioSeries.set(s, r);
}
console.error(`context: BTC bias from ${btcBias.length} 4h bars · funding ${[...fundingSeries.values()].filter(m => m.size).length} markets · ratio ${[...ratioSeries.values()].filter(m => m.size).length} markets`);
const lastHour = (t: number) => Math.floor(t / H) * H - H;   // the last fully closed hour before t
const FUND_BAND = 0.005;   // percent per interval: inside the band nobody is crowded
for (const s of MARKETS) for (const tf of TFS) { const b = await bars(s, tf, BARS[tf]); await bars(s, SUB[tf], Math.min(60_000, Math.ceil((b.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]]))); }
console.error('candles ready');

type Stat = { trades: number; avgR: number; sumR: number; win: number; t1: number; r1: number; t2: number; r2: number; both: boolean; mfe05: number; mfe1: number; mfe2: number; firstBar: number };
function stat(trades: any[], b: Bar[], tfMs: number): Stat {
  const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
  const split = b[Math.floor(b.length / 2)].time;
  const h1 = trades.filter(x => x.entryAt < split), h2 = trades.filter(x => x.entryAt >= split);
  const pk = (t: number) => (trades.length ? trades.filter(x => (x.peakR ?? 0) >= t).length / trades.length : 0);
  const fb = trades.filter(x => x.exitReason === 'sl' && x.exitAt - x.entryAt <= tfMs * 2).length;
  return { trades: trades.length, avgR: R(trades), sumR: R(trades) * trades.length, win: trades.length ? trades.filter(x => x.pnl > 0).length / trades.length : 0, t1: h1.length, r1: R(h1), t2: h2.length, r2: R(h2), both: h1.length >= 5 && h2.length >= 5 && R(h1) > 0 && R(h2) > 0, mfe05: pk(0.5), mfe1: pk(1), mfe2: pk(2), firstBar: trades.length ? fb / trades.length : 0 };
}
const row = (id: string, tf: string, sym: string, v: string, s: Stat, note = '') => out.write([id, tf, sym, v, s.trades, s.avgR.toFixed(3), s.sumR.toFixed(1), s.win.toFixed(2), s.t1, s.r1.toFixed(3), s.t2, s.r2.toFixed(3), s.both ? 1 : 0, s.mfe05.toFixed(2), s.mfe1.toFixed(2), s.mfe2.toFixed(2), s.firstBar.toFixed(2), note].join('\t') + '\n');

const flip = (evs: ScanEvent[]): ScanEvent[] => evs.map(e => (e.side ? { ...e, side: e.side === 'long' ? 'short' : 'long', sl: undefined, tp: [] } : e));
/**
 * One-bar confirmation (decision 81): an entry is taken at the close of the bar AFTER the signal bar, and
 * only if that bar closed in the trade's direction. The journal's stop exits were hit within the first bar
 * with no favourable excursion — late entries into a move that reversed — and this is the cheapest test of it.
 */
/** ATR(14) (Wilder) at bar i from the bars before it, like the engine's `lastAtr` on the closed bars. */
const atrAt = (bars: Bar[], i: number): number | undefined => {
  if (i < 15) return undefined;
  let a = 0; for (let j = i - 13; j <= i; j++) { const b = bars[j], p = bars[j - 1]; a += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)); }
  return a / 14;
};
/** Kaufman efficiency ratio over 20 closes ending at bar i. */
const erAt = (bars: Bar[], i: number): number => {
  if (i < 20) return 0;
  let path = 0; for (let j = i - 19; j <= i; j++) path += Math.abs(bars[j].close - bars[j - 1].close);
  return path > 0 ? Math.abs(bars[i].close - bars[i - 20].close) / path : 0;
};
/**
 * The stop study (decision 110): every entry keeps its signal, only the stop moves. `stopOf` returns the stop
 * price for the entry at bar i, or undefined to leave the signal's own; the distance is clamped to [lo, hi] ATR.
 */
const withStop = (evs: ScanEvent[], bars: Bar[], stopOf: (i: number, side: 'long' | 'short', atr: number) => number | undefined, lo = 1.0, hi = 2.5): ScanEvent[] => {
  const at = new Map<number, number>(); bars.forEach((b, i) => at.set(b.time, i));
  return evs.map(e => {
    if (e.kind !== 'entry' || !e.side) return e;
    const i = at.get(e.barTime); const atr = i !== undefined ? atrAt(bars, i) : undefined;
    if (i === undefined || !atr) return e;
    const entry = e.price && e.price > 0 ? e.price : bars[i].close;
    const raw = stopOf(i, e.side, atr); if (raw === undefined) return e;
    const dist = Math.min(hi * atr, Math.max(lo * atr, Math.abs(entry - raw)));
    return { ...e, sl: e.side === 'long' ? entry - dist : entry + dist };
  });
};

/**
 * The cost-floor stop (under test, 17 Oct): an entry whose own stop (the script's, or the 1.5×ATR fallback) sits
 * inside the cost rule's floor is not refused but widened to the floor, when it was already at least `frac` of the
 * way there; the position is sized to the wider stop, so the dollar risk is the same. Entries further inside the
 * floor are left as they are and the rule refuses them exactly as the account does.
 */
const withCostFloor = (evs: ScanEvent[], bars: Bar[], spreadPct: number, frac: number): ScanEvent[] => {
  const ratio = cfg.paper.minRiskFeeRatio ?? 0; if (!(ratio > 0)) return evs;
  const at = new Map<number, number>(); bars.forEach((b, i) => at.set(b.time, i));
  return evs.map(e => {
    if (e.kind !== 'entry' || !e.side) return e;
    const i = at.get(e.barTime); const atr = i !== undefined ? atrAt(bars, i) : undefined;
    if (i === undefined || !atr) return e;
    const entry = e.price && e.price > 0 ? e.price : bars[i].close;
    const own = e.sl && e.sl > 0 ? Math.abs(entry - e.sl) : cfg.paper.fallbackAtrSl * atr;
    const need = entry * ((cfg.paper.feeRatePct / 100) * (1 + (cfg.paper.feeTaxPct ?? 0) / 100) * 2 + Math.max(0, spreadPct) / 100) * ratio * 1.01;
    if (own >= need || own < frac * need) return e;
    return { ...e, sl: e.side === 'long' ? entry - need : entry + need };
  });
};

const confirm = (evs: ScanEvent[], bars: Bar[]): ScanEvent[] => {
  const at = new Map<number, number>(); bars.forEach((b, i) => at.set(b.time, i));
  const out: ScanEvent[] = [];
  for (const e of evs) {
    if (e.kind !== 'entry' || !e.side) { out.push(e); continue; }
    const i = at.get(e.barTime); const next = i !== undefined ? bars[i + 1] : undefined;
    if (i === undefined || !next) continue;
    const held = e.side === 'long' ? next.close > bars[i].close : next.close < bars[i].close;
    if (!held) continue;
    out.push({ ...e, barTime: next.time, barIndex: i + 1, price: undefined, label: `${e.label} (confirmed)` });
  }
  return out;
};

/**
 * Prefix honesty (decision 85): a script run on bars[0..n-CUT] must raise the same entries, on the same bars, as the
 * run on all n bars, for every bar before the cut. A script whose earlier entries move or vanish when later bars are
 * hidden is reading the future — the BTC 15m script that screened at +1.03R and traded −0.21R in the shadow book.
 */
const REPAINT_ONLY = process.env.REPAINT_ONLY === '1';
// VARIANTS=a,b runs only the named study variants (the base rows always run): a focused study costs a fraction of the full set.
const ONLY = process.env.VARIANTS ? new Set(process.env.VARIANTS.split(',').map(v => v.trim()).filter(Boolean)) : null;
const want = (k: string) => !ONLY || ONLY.has(k);
interface CellResult { id: string; tf: string; sym: string; variants: Record<string, Stat>; labels: Array<[string, Stat]>; verdict: string; fix: string; repaint?: { prefix: number; changed: number } }
async function cell(id: string, tf: string, sym: string): Promise<CellResult | null> {
  const s = registry.get(id); if (!s || s.status !== 'ok') return null;
  const b = await bars(sym, tf, BARS[tf]); const sub = series.get(`${sym}:${SUB[tf]}`); const m = market.get(sym)!;
  const sc = cfg.scanners[id] ?? {};
  const res = await pool.run({ scannerId: id, source: s.patched, symbol: sym, tf, tickSize: m.tickSize, bars: b, tailBars: 'all', plotTail: b.length, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone });
  if (!res.ok) { md.push(`- ${id} · ${sym} ${tf}: **did not run** — ${res.error}`); return null; }
  // the same script with the last REPAINT_CUT bars hidden: its view of the earlier bars must not change
  let repaint: { prefix: number; changed: number } | undefined;
  if (REPAINT_CUT > 0 && b.length > REPAINT_CUT + 200) {
    const bt = b.slice(0, b.length - REPAINT_CUT); const cutAt = bt[bt.length - 1].time;
    const r2 = await pool.run({ scannerId: id, source: s.patched, symbol: sym, tf, tickSize: m.tickSize, bars: bt, tailBars: 'all', plotTail: bt.length, inputs: sc.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined, timezone: sc.timezone });
    if (r2.ok) { const rc = compareRepaint(res, b, r2, bt, id, sc); repaint = { prefix: rc.prefix, changed: rc.changed }; }
  }
  if (REPAINT_ONLY) {
    const empty = stat([], b, TF_SECONDS[tf] * 1000);
    if (repaint) { const share = repaint.prefix ? repaint.changed / repaint.prefix : 0; row(id, tf, sym, 'repaint', { ...empty, trades: repaint.prefix }, `${repaint.changed} of ${repaint.prefix} earlier entries changed when the last ${REPAINT_CUT} bars were hidden (${(share * 100).toFixed(0)}%)`); }
    return { id, tf, sym, variants: { base: empty }, labels: [], verdict: repaint ? 'repaint checked' : 'repaint not checked', fix: '', repaint };
  }
  const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars: b, mode: 'backtest' });
  const events = extractEvents(res.alerts, res.shapes, { drawn: res.labels, scannerId: s.id, derived, sources: sc.sources, edge: sc.edge, labels: sc.labels, invert: sc.invert });
  const tfMs = TF_SECONDS[tf] * 1000;
  if (!events.some(e => e.kind === 'entry')) {
    // a zero-entry cell is a result, not a hole: say what came out of the run and where the funnel emptied
    const nAlert = res.alerts.filter(a => a.type === 'alert').length, nCond = res.alerts.filter(a => a.type === 'alertcondition').length;
    const nShape = res.shapes.reduce((a, s) => a + s.times.length, 0);
    const exits = events.filter(e => e.kind === 'exit').length, info = events.filter(e => e.kind === 'info').length;
    const why = !nAlert && !nCond && !nShape && !res.labels.length ? (res.plots.length ? 'NO SIGNAL CHANNEL: plots only (a feature source, not an entry system)' : 'SILENT: no alert, condition, shape, label or plot')
      : !nAlert && !nCond && !nShape ? `OUTPUT NOT MAPPED: ${res.labels.length} drawn labels, no alert/condition/shape`
      : exits && !info ? `EXITS ONLY: ${exits} exit events, no entry` : `NO ENTRY READ: ${nAlert} alert(), ${nCond} conditions, ${nShape} shape hits → ${info} info, ${exits} exits, 0 entries`;
    const empty = stat([], b, tfMs);
    row(id, tf, sym, 'base', empty, why);
    md.push(`- ${id} · ${sym} ${tf}: **no entries** — ${why}`);
    return { id, tf, sym, variants: { base: empty }, labels: [], verdict: why, fix: why.startsWith('NO ENTRY READ') ? 'name the entry channel/labels in the scanner config, or add a rule' : why.startsWith('EXITS') ? 'an exit tool: pair it with an entry system in the exit lab' : 'a feature adapter, not a scanner' };
  }
  const base: BacktestInput = { scannerId: id, scannerName: id, symbol: sym, tf, bars: b, events, cfg: cfg.paper, exitMode: sc.exitMode ?? 'both', trendGate: sc.trendGate, contractValue: m.contractValue, tickSize: m.tickSize, maintenanceMarginPct: m.maintenanceMarginPct, maxLeverage: m.maxLeverage, subBars: sub } as any;
  const run = (patch: Partial<BacktestInput>, paper: Partial<PaperConfig> = {}) => runBacktest({ ...base, ...patch, cfg: { ...cfg.paper, ...paper } }).trades as any[];
  const variants: Record<string, Stat> = {};
  variants.base = stat(run({}), b, tfMs);
  variants.gross = stat(run({}, { feeRatePct: 0, feeTaxPct: 0, slippageBps: 2 }), b, tfMs);
  if (want('stop1.5')) variants['stop1.5'] = stat(run({}, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 1.5 }), b, tfMs);
  variants.stop2 = stat(run({}, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 2 }), b, tfMs);
  variants.tp1 = stat(run({}, { scriptTargets: 'ignore', fallbackRR: [1, 1, 1], tpSplit: [1, 0, 0], trailAfterR: 99, floorAtR: 99 } as any), b, tfMs);
  variants.levels = stat(run({ exitMode: 'levels' }), b, tfMs);
  if (events.some(e => e.kind === 'exit') || events.some(e => e.kind === 'entry' && (e.sl || e.tp?.length))) variants.script = stat(run({ exitMode: 'script' }), b, tfMs);
  if (want('er0.25')) variants['er0.25'] = stat(run({ chopGate: { minEr: 0.25 } }), b, tfMs);
  variants.confirm1 = stat(run({ events: confirm(events, b) }), b, tfMs);
  if (want('er+stop1.5')) variants['er+stop1.5'] = stat(run({ chopGate: { minEr: 0.25 } }, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 1.5 }), b, tfMs);
  if (want('er+stop2')) variants['er+stop2'] = stat(run({ chopGate: { minEr: 0.25 } }, { fallbackAtrSl: cfg.paper.fallbackAtrSl * 2 }), b, tfMs);
  if (want('confirm1+er')) variants['confirm1+er'] = stat(run({ events: confirm(events, b), chopGate: { minEr: 0.25 } }), b, tfMs);
  // the entry model (decision 95): do not chase the signal bar; enter on a pullback as a maker, or not at all
  if (want('nochase1.5')) variants['nochase1.5'] = stat(run({ entry: { maxSignalBarAtr: 1.5 } }), b, tfMs);
  if (want('pull0.3')) variants['pull0.3'] = stat(run({ entry: { pullbackAtr: 0.3, pullbackBars: 3 } }), b, tfMs);
  if (want('pull0.5')) variants['pull0.5'] = stat(run({ entry: { pullbackAtr: 0.5, pullbackBars: 5 } }), b, tfMs);
  if (want('pull0.3+nochase')) variants['pull0.3+nochase'] = stat(run({ entry: { pullbackAtr: 0.3, pullbackBars: 3, maxSignalBarAtr: 1.5 } }), b, tfMs);
  // costs as the account pays them: every market leg crosses half the book; a limit at the signal price crosses nothing on entry and pays the maker fee
  const spreadPct = bookCost.get(sym) ?? 0;
  variants.spread = stat(run({ spreadPct }), b, tfMs);
  if (want('limit0')) variants['limit0'] = stat(run({ spreadPct, entry: { pullbackAtr: 0, pullbackBars: 2 } }), b, tfMs);
  if (want('limit0.1')) variants['limit0.1'] = stat(run({ spreadPct, entry: { pullbackAtr: 0.1, pullbackBars: 2 } }), b, tfMs);
  // the cost rule: with the real book paid, only take a trade whose stop is many times the round trip's cost
  // decision 178: the Vela library's exit models, replacing the account's trail (`lux-*`) or layered over it (`+ours`)
  if (['lux-sig', 'lux-sig+ours', 'lux-stat1', 'lux-stat2', 'lux-stat2+ours', 'lux-ms', 'lux-ms+ours'].some(want)) {
    const lux = luxTrailModels(b);
    const noTrail: Partial<PaperConfig> = { trailAfterR: 0, floorAtR: 0, trailSteps: [] };
    if (want('lux-sig')) variants['lux-sig'] = stat(run({ spreadPct, trailModel: lux.sigmoid }, noTrail), b, tfMs);
    if (want('lux-sig+ours')) variants['lux-sig+ours'] = stat(run({ spreadPct, trailModel: lux.sigmoid }), b, tfMs);
    if (want('lux-stat1')) variants['lux-stat1'] = stat(run({ spreadPct, trailModel: lux.stat1 }, noTrail), b, tfMs);
    if (want('lux-stat2')) variants['lux-stat2'] = stat(run({ spreadPct, trailModel: lux.stat2 }, noTrail), b, tfMs);
    if (want('lux-stat2+ours')) variants['lux-stat2+ours'] = stat(run({ spreadPct, trailModel: lux.stat2 }), b, tfMs);
    if (want('lux-ms')) variants['lux-ms'] = stat(run({ spreadPct, trailModel: lux.ms }, noTrail), b, tfMs);
    if (want('lux-ms+ours')) variants['lux-ms+ours'] = stat(run({ spreadPct, trailModel: lux.ms }), b, tfMs);
  }
  if (want('spread+ratio6')) variants['spread+ratio6'] = stat(run({ spreadPct, costRatio: 6 }), b, tfMs);
  if (want('spread+ratio10')) variants['spread+ratio10'] = stat(run({ spreadPct, costRatio: 10 }), b, tfMs);
  if (want('spread+er0.25')) variants['spread+er0.25'] = stat(run({ spreadPct, chopGate: { minEr: 0.25 } }), b, tfMs);
  // decision 155: the fair benchmark (LuxAlgo's "random-entry baseline"). The scanner's own entries with the bot's exits
  // and the ATR stop (the script's stops, targets and exit events dropped, as the account trades since decision 146),
  // against the same number of entries with the same sides on random bars, 20 seeded draws, same exits and costs.
  if (want('sig-atr') || want('rand')) {
    const own = events.filter(e => e.kind === 'entry' && e.side).map(e => ({ ...e, sl: undefined, tp: [] as number[] }));
    if (want('sig-atr')) {
      variants['sig-atr'] = stat(run({ spreadPct, events: own }), b, tfMs);
      variants['sig-long'] = stat(run({ spreadPct, events: own.filter(e => e.side === 'long') }), b, tfMs);
      variants['sig-short'] = stat(run({ spreadPct, events: own.filter(e => e.side === 'short') }), b, tfMs);
      // the market's own move over the same bars, as percent, in the trades column's place (0 trades marks it)
      variants['drift'] = { ...stat([], b, tfMs), sumR: (b[b.length - 1].close / b[0].close - 1) * 100, avgR: 0 } as Stat;
    }
    if (want('rand') && own.length) {
      let h = 2166136261; for (const ch of `${id}|${sym}|${tf}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      const lo = Math.min(60, Math.floor(b.length / 10)), hi = b.length - 2;
      for (let k = 1; k <= 20; k++) {
        let x = (h ^ (k * 0x9e3779b9)) >>> 0;
        const rnd = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const used = new Set<number>(); const sides = own.map(e => e.side!);
        for (let i = sides.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sides[i], sides[j]] = [sides[j], sides[i]]; }
        const evs: ScanEvent[] = [];
        for (const side of sides) {
          let i = lo + Math.floor(rnd() * Math.max(1, hi - lo)); let guard = 0;
          while (used.has(i) && guard++ < 50) i = lo + Math.floor(rnd() * Math.max(1, hi - lo));
          used.add(i);
          evs.push({ ...own[0], side, barTime: b[i].time, barIndex: i, price: undefined, sl: undefined, tp: [], score: undefined, label: 'random', message: 'random entry' });
        }
        evs.sort((p, q) => p.barTime - q.barTime);
        variants[`rand-${k}`] = stat(run({ spreadPct, events: evs }), b, tfMs);
      }
    }
  }
  // decision 147: the live whipsaw floor against looser ones, under the current exits and costs
  for (const m of [0.1, 0.15, 0.2]) if (want(`spread+er${m}`)) variants[`spread+er${m}`] = stat(run({ spreadPct, chopGate: { minEr: m } }), b, tfMs);
  if (want('spread+er+ratio10')) variants['spread+er+ratio10'] = stat(run({ spreadPct, costRatio: 10, chopGate: { minEr: 0.25 } }), b, tfMs);
  // decision 175: the trail's width. Today the account's winners average +0.5R against −1R stops (the trail gives back
  // only 10% of the peak from +0.5R), so it needs 65% winners; these widen the give-back, keep the floor alone, or
  // switch the reversal rule off, all with the spread paid.
  for (const g of [20, 30, 40]) if (want(`spread+give${g}`)) variants[`spread+give${g}`] = stat(run({ spreadPct }, { trailGiveBackPct: g, trailSteps: [] } as any), b, tfMs);
  if (want('spread+floor')) variants['spread+floor'] = stat(run({ spreadPct }, { trailAfterR: 99 } as any), b, tfMs);
  if (want('spread+trail1')) variants['spread+trail1'] = stat(run({ spreadPct }, { trailAfterR: 1, trailGiveBackPct: 20, trailSteps: [] } as any), b, tfMs);
  if (want('spread+norev')) variants['spread+norev'] = stat(run({ spreadPct }, { allowReversal: false } as any), b, tfMs);
  // the stop study (decision 110), every variant paying the real book: where else could the stop go
  const slAt = (mult: number) => ({ fallbackAtrSl: mult, widenStopToFee: false } as Partial<PaperConfig>);
  const lows = (i: number, n: number) => Math.min(...b.slice(Math.max(0, i - n + 1), i + 1).map(x => x.low));
  const highs = (i: number, n: number) => Math.max(...b.slice(Math.max(0, i - n + 1), i + 1).map(x => x.high));
  if (want('s-atr1.0')) variants['s-atr1.0'] = stat(run({ spreadPct }, slAt(1.0)), b, tfMs);
  if (want('s-atr1.25')) variants['s-atr1.25'] = stat(run({ spreadPct }, slAt(1.25)), b, tfMs);
  if (want('s-atr2.0')) variants['s-atr2.0'] = stat(run({ spreadPct }, slAt(2.0)), b, tfMs);
  // beyond the signal bar's own extreme: a first-bar reversal cannot tag it
  if (want('s-wick')) variants['s-wick'] = stat(run({ spreadPct, events: withStop(events, b, (i, side, atr) => (side === 'long' ? b[i].low - 0.25 * atr : b[i].high + 0.25 * atr)) }), b, tfMs);
  // beyond the last 10 bars' swing
  if (want('s-swing10')) variants['s-swing10'] = stat(run({ spreadPct, events: withStop(events, b, (i, side, atr) => (side === 'long' ? lows(i, 10) - 0.1 * atr : highs(i, 10) + 0.1 * atr), 1.0, 3.0) }), b, tfMs);
  // scaled by the regime: tight when the market moves efficiently, wide when it chops
  if (want('s-erscaled')) variants['s-erscaled'] = stat(run({ spreadPct, events: withStop(events, b, (i, side, atr) => { const er = erAt(b, i); const m = er >= 0.35 ? 1.25 : er < 0.25 ? 2.0 : 1.5; return side === 'long' ? b[i].close - m * atr : b[i].close + m * atr; }, 1.0, 2.5) }), b, tfMs);
  // the stop moves: to the entry once the trade has +0.5R or +1R, or keeps a fifth of the gain
  if (want('s-be0.5')) variants['s-be0.5'] = stat(run({ spreadPct }, { floorAtR: 0.5, floorKeepR: 0 }), b, tfMs);
  if (want('s-be1')) variants['s-be1'] = stat(run({ spreadPct }, { floorAtR: 1, floorKeepR: 0 }), b, tfMs);
  if (want('s-floor0.5k0.2')) variants['s-floor0.5k0.2'] = stat(run({ spreadPct }, { floorAtR: 0.5, floorKeepR: 0.2 }), b, tfMs);
  // the exit study (17 Oct): the same entries, the account's costs, only the trail, the floor and the first target move.
  // The account keeps half of its winners' peak (trail +0.51R on a 0.91R peak); these ask what keeping more of it costs.
  if (want('x-gb25')) variants['x-gb25'] = stat(run({ spreadPct }, { trailGiveBackPct: 25, trailSteps: [[2, 20], [4, 15]] }), b, tfMs);
  if (want('x-gb15')) variants['x-gb15'] = stat(run({ spreadPct }, { trailGiveBackPct: 15, trailSteps: [[2, 12], [4, 10]] }), b, tfMs);
  if (want('x-gb60')) variants['x-gb60'] = stat(run({ spreadPct }, { trailGiveBackPct: 60, trailSteps: [[2, 40], [4, 25]] }), b, tfMs);
  if (want('x-after1')) variants['x-after1'] = stat(run({ spreadPct }, { trailAfterR: 1.0 }), b, tfMs);
  if (want('x-after1gb25')) variants['x-after1gb25'] = stat(run({ spreadPct }, { trailAfterR: 1.0, trailGiveBackPct: 25, trailSteps: [[2, 20], [4, 15]] }), b, tfMs);
  if (want('x-floor1k0.5')) variants['x-floor1k0.5'] = stat(run({ spreadPct }, { floorAtR: 1.0, floorKeepR: 0.5 }), b, tfMs);
  if (want('x-half1R')) variants['x-half1R'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [1, 4, 6], tpSplit: [0.5, 0, 0.5] }), b, tfMs);
  if (want('x-all2R')) variants['x-all2R'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [2, 4, 6], tpSplit: [1, 0, 0] }), b, tfMs);
  if (want('x-nostall')) variants['x-nostall'] = stat(run({ spreadPct }, { trailStall: { minutes: 0, factor: 1 } }), b, tfMs);
  // second pass: where is the knee, and is it the early trail or the runner steps that pay
  if (want('x-gb10')) variants['x-gb10'] = stat(run({ spreadPct }, { trailGiveBackPct: 10, trailSteps: [[2, 8], [4, 6]] }), b, tfMs);
  if (want('x-gb5')) variants['x-gb5'] = stat(run({ spreadPct }, { trailGiveBackPct: 5, trailSteps: [[2, 5], [4, 5]] }), b, tfMs);
  if (want('x-gb15s')) variants['x-gb15s'] = stat(run({ spreadPct }, { trailGiveBackPct: 15 }), b, tfMs);
  if (want('x-gb15after0.3')) variants['x-gb15after0.3'] = stat(run({ spreadPct }, { trailAfterR: 0.3, trailGiveBackPct: 15, trailSteps: [[2, 12], [4, 10]] }), b, tfMs);
  // the early adverse cut (decision 128): the stop-outs are known early; cut them before the full stop
  if (want('x-cut0.5@30')) variants['x-cut0.5@30'] = stat(run({ spreadPct }, { earlyCut: { r: -0.5, minutes: 30 } }), b, tfMs);
  if (want('x-cut0.5@60')) variants['x-cut0.5@60'] = stat(run({ spreadPct }, { earlyCut: { r: -0.5, minutes: 60 } }), b, tfMs);
  if (want('x-cut0.5@120')) variants['x-cut0.5@120'] = stat(run({ spreadPct }, { earlyCut: { r: -0.5, minutes: 120 } }), b, tfMs);
  if (want('x-cut0.4@60')) variants['x-cut0.4@60'] = stat(run({ spreadPct }, { earlyCut: { r: -0.4, minutes: 60 } }), b, tfMs);
  if (want('x-cut0.6@90')) variants['x-cut0.6@90'] = stat(run({ spreadPct }, { earlyCut: { r: -0.6, minutes: 90 } }), b, tfMs);
  if (want('x-cut0.7@240')) variants['x-cut0.7@240'] = stat(run({ spreadPct }, { earlyCut: { r: -0.7, minutes: 240 } }), b, tfMs);
  // today's journal (19 Oct): no armed trade stopped out; every stop-out came from a trade that never reached +0.5R.
  // Two answers, measured: a stop to break even once the trade shows +0.25R, and a time stop that closes a trade the
  // trail has not armed after N bars of its own timeframe.
  if (want('t-be0.25')) variants['t-be0.25'] = stat(run({ spreadPct }, { floorAtR: 0.25, floorKeepR: 0 }), b, tfMs);
  if (want('t-be0.25k0.06')) variants['t-be0.25k0.06'] = stat(run({ spreadPct }, { floorAtR: 0.25, floorKeepR: 0.06 }), b, tfMs);
  if (want('t-be0.35')) variants['t-be0.35'] = stat(run({ spreadPct }, { floorAtR: 0.35, floorKeepR: 0 }), b, tfMs);
  for (const n of [2, 3, 4, 6, 8]) if (want(`t-stale${n}`)) variants[`t-stale${n}`] = stat(run({ spreadPct }, { staleBars: n, staleMinR: 0.5 }), b, tfMs);
  if (want('t-stale4m0.25')) variants['t-stale4m0.25'] = stat(run({ spreadPct }, { staleBars: 4, staleMinR: 0.25 }), b, tfMs);
  // the target study (decision 129): the reviewer's "smarter TPs" as variants: an earlier floor, the script's own targets
  // against the fleet ladder, and tighter ladders that take profit in legs
  if (want('x-floor0.3k0.15')) variants['x-floor0.3k0.15'] = stat(run({ spreadPct }, { floorAtR: 0.3, floorKeepR: 0.15 }), b, tfMs);
  if (want('x-floor0.4k0.2')) variants['x-floor0.4k0.2'] = stat(run({ spreadPct }, { floorAtR: 0.4, floorKeepR: 0.2 }), b, tfMs);
  if (want('x-floor0.3k0.1@0.3')) variants['x-floor0.3k0.1@0.3'] = stat(run({ spreadPct }, { floorAtR: 0.3, floorKeepR: 0.1, trailAfterR: 0.3 }), b, tfMs);
  if (want('x-st-ignore')) variants['x-st-ignore'] = stat(run({ spreadPct }, { scriptTargets: 'ignore' }), b, tfMs);
  if (want('x-st-widen')) variants['x-st-widen'] = stat(run({ spreadPct }, { scriptTargets: 'widen' }), b, tfMs);
  if (want('x-ladder1.5-3-6')) variants['x-ladder1.5-3-6'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [1.5, 3, 6], tpSplit: [0.3, 0.3, 0.4] }), b, tfMs);
  if (want('x-ladder1-2-4')) variants['x-ladder1-2-4'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [1, 2, 4], tpSplit: [0.4, 0.3, 0.3] }), b, tfMs);
  if (want('x-ladder2-4-6split')) variants['x-ladder2-4-6split'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [2, 4, 6], tpSplit: [0.5, 0.25, 0.25] }), b, tfMs);
  if (want('x-tp1R')) variants['x-tp1R'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [1, 1, 1], tpSplit: [1, 0, 0] }), b, tfMs);
  if (want('x-tp1.5R')) variants['x-tp1.5R'] = stat(run({ spreadPct }, { scriptTargets: 'ignore', fallbackRR: [1.5, 1.5, 1.5], tpSplit: [1, 0, 0] }), b, tfMs);
  // the hybrid entry (decision 133): the signal on this timeframe, the fill on the first lower bar that continues beyond the signal bar
  if (want('h-break0')) variants['h-break0'] = stat(run({ spreadPct, entry: { breakAtr: 0, breakBars: 4 } }), b, tfMs);
  if (want('h-break0.25')) variants['h-break0.25'] = stat(run({ spreadPct, entry: { breakAtr: 0.25, breakBars: 4 } }), b, tfMs);
  if (want('h-break0@8')) variants['h-break0@8'] = stat(run({ spreadPct, entry: { breakAtr: 0, breakBars: 8 } }), b, tfMs);
  if (want('h-break0+er')) variants['h-break0+er'] = stat(run({ spreadPct, chopGate: { minEr: 0.25 }, entry: { breakAtr: 0, breakBars: 4 } }), b, tfMs);
  // the reversal study (decision 135): an opposite signal closes and flips the position; never, or only once the trade is ahead
  if (want('r-none')) variants['r-none'] = stat(run({ spreadPct }, { allowReversal: false }), b, tfMs);
  if (want('r-min0.5')) variants['r-min0.5'] = stat(run({ spreadPct }, { reversalMinR: 0.5 }), b, tfMs);
  if (want('r-min1')) variants['r-min1'] = stat(run({ spreadPct }, { reversalMinR: 1 }), b, tfMs);
  if (want('r-min0')) variants['r-min0'] = stat(run({ spreadPct }, { reversalMinR: 0.0001 }), b, tfMs);
  // the cost-floor stop: the near-miss refusals taken at the floor instead (compare with `spread`, the same costs and refusals as the account)
  if (want('cf75')) variants['cf75'] = stat(run({ spreadPct, events: withCostFloor(events, b, spreadPct, 0.75) }), b, tfMs);
  if (want('cf50')) variants['cf50'] = stat(run({ spreadPct, events: withCostFloor(events, b, spreadPct, 0.5) }), b, tfMs);
  if (want('cf0')) variants['cf0'] = stat(run({ spreadPct, events: withCostFloor(events, b, spreadPct, 0) }), b, tfMs);
  // the same stops under the whipsaw gate the account runs (minEr 0.25): the live baseline is spread+er0.25
  const er = { chopGate: { minEr: 0.25 } };
  if (want('e-atr1.25')) variants['e-atr1.25'] = stat(run({ spreadPct, ...er }, slAt(1.25)), b, tfMs);
  if (want('e-atr2.0')) variants['e-atr2.0'] = stat(run({ spreadPct, ...er }, slAt(2.0)), b, tfMs);
  if (want('e-wick')) variants['e-wick'] = stat(run({ spreadPct, ...er, events: withStop(events, b, (i, side, atr) => (side === 'long' ? b[i].low - 0.25 * atr : b[i].high + 0.25 * atr)) }), b, tfMs);
  if (want('e-wick2.0')) variants['e-wick2.0'] = stat(run({ spreadPct, ...er, events: withStop(events, b, (i, side, atr) => (side === 'long' ? b[i].low - 0.25 * atr : b[i].high + 0.25 * atr), 2.0, 3.0) }), b, tfMs);
  if (want('e-swing10')) variants['e-swing10'] = stat(run({ spreadPct, ...er, events: withStop(events, b, (i, side, atr) => (side === 'long' ? lows(i, 10) - 0.1 * atr : highs(i, 10) + 0.1 * atr), 1.0, 3.0) }), b, tfMs);
  // the regime test (decision 102), every variant paying the real book
  const fund = fundingSeries.get(sym) ?? new Map<number, number>(), rat = ratioSeries.get(sym) ?? new Map<number, number>();
  const gBias = (t: number, side: 'long' | 'short') => { const bb = biasAt(t); return bb === undefined ? 'unknown' as const : bb === 0 ? 'allow' as const : (side === 'long') === (bb > 0) ? 'allow' as const : 'block' as const; };
  const gFund = (t: number, side: 'long' | 'short') => { const f = fund.get(lastHour(t)); return f === undefined ? 'unknown' as const : Math.abs(f) < FUND_BAND ? 'allow' as const : (side === 'long' ? f < 0 : f > 0) ? 'allow' as const : 'block' as const; };
  const gRatio = (t: number, side: 'long' | 'short') => { const r = rat.get(lastHour(t)); return r === undefined ? 'unknown' as const : (side === 'long' ? r >= 1 : r <= 1) ? 'allow' as const : 'block' as const; };
  const gWindow = (t: number) => (rat.get(lastHour(t)) === undefined ? 'unknown' as const : 'allow' as const);
  if (want('ctx-bias')) variants['ctx-bias'] = stat(run({ spreadPct, contextGate: gBias }), b, tfMs);
  if (want('ctx-funding')) variants['ctx-funding'] = stat(run({ spreadPct, contextGate: gFund }), b, tfMs);
  if (want('ctx-bias+fund')) variants['ctx-bias+fund'] = stat(run({ spreadPct, contextGate: (t, side) => (gBias(t, side) === 'block' || gFund(t, side) === 'block' ? 'block' : 'allow') }), b, tfMs);
  if (rat.size) {
    variants['base30d'] = stat(run({ spreadPct, contextGate: gWindow, unknownIs: 'block' }), b, tfMs);
    variants['ctx-ratio30d'] = stat(run({ spreadPct, contextGate: gRatio, unknownIs: 'block' }), b, tfMs);
  }
  variants.inverted = stat(run({ events: flip(events) }), b, tfMs);
  variants.long = stat(run({ events: events.filter(e => e.kind !== 'entry' || e.side === 'long') }), b, tfMs);
  variants.short = stat(run({ events: events.filter(e => e.kind !== 'entry' || e.side === 'short') }), b, tfMs);
  // per label: the base run's trades mapped back to the signal that opened them
  const byLabel = new Map<string, any[]>();
  // a script that publishes a score (decision 131) has its labels split by score band, so the record per label is also the record per score
  const band = (sc: number | undefined) => (sc == null ? '' : sc >= 80 ? ' score 80+' : sc >= 50 ? ' score 50-79' : sc > 0 ? ' score 1-49' : ' score 0');
  const sig = new Map<string, string>(); for (const e of events) if (e.kind === 'entry') sig.set(`${e.barTime}:${e.side}`, `${e.source}:${(e.label ?? '').slice(0, 30)}${band(e.score)}`);
  for (const t of run({})) { const k = sig.get(`${t.entryAt}:${t.side}`) ?? 'unknown'; byLabel.set(k, [...(byLabel.get(k) ?? []), t]); }
  const labels: Array<[string, Stat]> = [...byLabel].filter(([, ts]) => ts.length >= 10).map(([k, ts]) => [k, stat(ts, b, tfMs)] as [string, Stat]).sort((a, c) => c[1].sumR - a[1].sumR);
  for (const [v, st] of Object.entries(variants)) row(id, tf, sym, v, st);
  for (const [k, st] of labels) row(id, tf, sym, `label:${k}`, st);
  let { verdict, fix } = diagnose(variants, labels);
  if (repaint) {
    const share = repaint.prefix ? repaint.changed / repaint.prefix : 0;
    row(id, tf, sym, 'repaint', { ...variants.base, trades: repaint.prefix }, `${repaint.changed} of ${repaint.prefix} earlier entries changed when the last ${REPAINT_CUT} bars were hidden (${(share * 100).toFixed(0)}%)`);
    if (share > 0.10 && repaint.prefix >= 5) { verdict = `REPAINTS: ${(share * 100).toFixed(0)}% of earlier entries move or vanish when later bars are hidden`; fix = 'do not screen or trade it: its history is not what a live run would have seen'; }
  }
  row(id, tf, sym, 'verdict', variants.base, `${verdict} → ${fix}`);
  return { id, tf, sym, variants, labels, verdict, fix, repaint };
}

/** The cause the numbers support, in order of what would be the cheapest real fix. */
function diagnose(v: Record<string, Stat>, labels: Array<[string, Stat]>): { verdict: string; fix: string } {
  const b = v.base;
  if (b.trades < 20) return { verdict: 'too few trades to say', fix: 'more history or a faster timeframe before judging' };
  if (b.both) return { verdict: 'pays as read', fix: 'nothing to fix; measure in shadow' };
  if (v.inverted.both && v.inverted.avgR > 0.1) return { verdict: 'READING: direction inverted', fix: 'the signals mean the opposite of how they are read (a warning read as an entry, a state read as a flip); invert or restrict the source' };
  const bad = labels.filter(([, s]) => s.avgR < -0.15 && s.trades >= 20), good = labels.filter(([, s]) => s.both);
  if (bad.length && good.length) return { verdict: `READING: label mix (${bad.map(([k]) => k).join(', ')} lose; ${good.map(([k]) => k).join(', ')} pay)`, fix: 'read only the paying channel/label (sources or a label allow-list in the scanner config)' };
  if (v.long.both && !v.short.both && v.short.avgR < -0.1) return { verdict: 'READING: shorts lose, longs pay', fix: 'long-only on this market (the script\'s short logic does not transfer)' };
  if (v.short.both && !v.long.both && v.long.avgR < -0.1) return { verdict: 'READING: longs lose, shorts pay', fix: 'short-only on this market' };
  if (v.script && v.script.both && !b.both) return { verdict: "EXIT: the script's own exits pay, ours do not", fix: 'exitMode script for this scanner (its stop/target logic is the strategy)' };
  if (v.levels.both && !b.both) return { verdict: 'EXIT: the script\'s exits hurt; our levels alone pay', fix: 'exitMode levels (ignore the script\'s exit/flip signals)' };
  if (v.tp1.both && b.mfe1 >= 0.35) return { verdict: 'EXIT: moves reach 1R but the trail gives it back', fix: 'take 1R (or part) instead of trailing from 0.5R on this scanner' };
  if ((v['stop1.5'].both || v.stop2.both) && b.firstBar >= 0.3) return { verdict: 'STOP: too tight for this market\'s bar size (first-bar stops)', fix: `fallbackAtrSl ${v.stop2.both ? '2' : '1.5'}× for this scanner` };
  if (v.gross.both && !b.both) return { verdict: 'COSTS: positive before fees, negative after', fix: 'a slower timeframe or a wider stop/target so each trade pays the round trip several times over' };
  if (v['er0.25'].both) return { verdict: 'WHIPSAW: pays only when the market is moving efficiently', fix: 'efficiency-ratio gate ≥ 0.25 on this timeframe' };
  if (b.mfe05 < 0.35) return { verdict: 'ENTRY: most trades never see +0.5R', fix: 'the signal is late or the stop sits inside the noise; try the slower timeframe or the script\'s confirmation inputs' };
  if (v['pull0.3']?.both || v['pull0.5']?.both) return { verdict: 'CHASED: pays when entered on a pullback instead of the signal close', fix: 'pullback entry (limit a fraction of an ATR back, maker fee)' };
  if (v['nochase1.5']?.both) return { verdict: 'CHASED: pays once spent signal bars are skipped', fix: 'skip signal bars that already ran 1.5 ATR' };
  return { verdict: 'no variant pays in both halves', fix: 'not a reading, exit or cost problem on this cell; re-time or retire the pair' };
}

const results: CellResult[] = [];
const tasks = ids.flatMap(id => TFS.flatMap(tf => MARKETS.map(sym => ({ id, tf, sym }))));
let done = 0; const started = Date.now();
async function worker() { for (;;) { const t = tasks.shift(); if (!t) return; try { const r = await cell(t.id, t.tf, t.sym); if (r) results.push(r); } catch (e: any) { md.push(`- ${t.id} · ${t.sym} ${t.tf}: error ${e?.message ?? e}`); } done++; if (done % 20 === 0) console.error(`${done}/${ids.length * TFS.length * MARKETS.length} cells · ${((Date.now() - started) / 60000).toFixed(1)} min`); } }
await Promise.all(Array.from({ length: CONC }, worker));
await pool.stop();
out.end();

// per-script summary: the cells, the verdict distribution, the best fixable cell
const lines: string[] = ['# Scanner test — ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', '', `Scripts ${ids.length} · timeframes ${TFS.join(', ')} · markets ${MARKETS.join(', ')} · ${results.length} cells with trades.`, ''];
for (const id of ids) {
  const cells = results.filter(r => r.id === id); if (!cells.length) { lines.push(`## ${id}`, '', 'no cell produced 20+ trades (silent, broken, or too slow a signal on this history)', ''); continue; }
  const verdicts = new Map<string, number>(); for (const c of cells) verdicts.set(c.verdict.split(':')[0], (verdicts.get(c.verdict.split(':')[0]) ?? 0) + 1);
  lines.push(`## ${id}`, '', `cells ${cells.length} · ${[...verdicts].map(([k, n]) => `${k} ${n}`).join(' · ')}`, '', '| market | tf | trades | E[R] | halves | +1R seen | first-bar stops | verdict | fix |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of cells.sort((a, b) => b.variants.base.sumR - a.variants.base.sumR)) { const b = c.variants.base; lines.push(`| ${c.sym} | ${c.tf} | ${b.trades} | ${b.avgR >= 0 ? '+' : ''}${b.avgR.toFixed(3)} | ${b.r1 >= 0 ? '+' : ''}${b.r1.toFixed(2)} / ${b.r2 >= 0 ? '+' : ''}${b.r2.toFixed(2)} | ${(b.mfe1 * 100).toFixed(0)}% | ${(b.firstBar * 100).toFixed(0)}% | ${c.verdict} | ${c.fix} |`); }
  lines.push('');
}
lines.push('## Notes', ...md);
fs.writeFileSync(process.env.MD ?? '/tmp/diagnose.md', lines.join('\n'));
console.error(`done: ${results.length} cells with trades · ${process.env.OUT ?? '/tmp/diagnose.tsv'} · ${process.env.MD ?? '/tmp/diagnose.md'}`);
// the row stream must reach the disk before the process goes (half the files of the 16 Oct run were cut mid-write)
out.end(() => process.exit(0));
