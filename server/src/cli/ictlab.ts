/**
 * Research: the multi-timeframe ICT confluence scanner (FVG + order blocks + liquidity sweeps, scored 0–5), ported from
 * a Python/Polygon script to Delta candles and run bar by bar without lookahead, then backtested with the account's
 * exits, the spread paid, against the random-entry baseline (decision 155).
 *
 *   [SYMBOLS=BTCUSD,ETHUSD] [TFS=15m,1h,4h] [BARS=4000] [MIN=3] npm run ictlab
 *
 * The original scores bullish and bearish features into one number; a trade needs a side, so the port scores each side
 * and signals the dominant one when it reaches MIN (3). The original's mitigation checks start at the zone's own bar
 * (`df.loc[time:]`), which mitigates every FVG and order block the moment it forms; the port checks from the next bar. — long on bullish FVG/OB proximity and a sell-side sweep, short
 * on the mirror — at most once per 10 bars per side.
 */
import { DeltaRest } from '../delta/rest.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';

const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSD,ETHUSD').split(',');
const TFS = (process.env.TFS ?? '15m,1h,4h').split(',');
const BARS = Number(process.env.BARS ?? 4000);
const MIN = Number(process.env.MIN ?? 3);
const WINDOW = 300;
const cfg = new ConfigStore().get();
const rest = new DeltaRest();

type Fvg = { type: 'bullish' | 'bearish'; i: number; top: number; bottom: number };
type Ob = { type: 'bullish' | 'bearish'; i: number; high: number; low: number };
type Sweep = { type: 'sellside' | 'buyside'; i: number };

function detect(w: Bar[]) {
  const n = w.length;
  const fvgs: Fvg[] = [];
  for (let i = 2; i < n; i++) {
    if (w[i].low > w[i - 2].high) { const gap = (w[i].low - w[i - 2].high) / w[i - 2].high * 100; if (gap >= 0.04) fvgs.push({ type: 'bullish', i, top: w[i].low, bottom: w[i - 2].high }); }
    else if (w[i].high < w[i - 2].low) { const gap = (w[i - 2].low - w[i].high) / w[i - 2].low * 100; if (gap >= 0.04) fvgs.push({ type: 'bearish', i, top: w[i - 2].low, bottom: w[i].high }); }
  }
  const unmit = fvgs.filter(f => { for (let k = f.i + 1; k < n; k++) { if (f.type === 'bullish' ? w[k].low <= f.top : w[k].high >= f.bottom) return false; } return true; }).filter(f => f.i > n - 50);
  const obs: Ob[] = [];
  for (let i = 10; i < n - 5; i++) {
    const c = w[i]; const body = Math.abs(c.close - c.open), rng = c.high - c.low; if (rng === 0) continue;
    const fut = w.slice(i + 1, i + 7);
    if (c.close < c.open && body / rng >= 0.55 && fut.length && Math.max(...fut.map(x => x.close)) > c.high * 1.0008 && !w.slice(i + 1).some(x => x.low <= c.low)) obs.push({ type: 'bullish', i, high: c.high, low: c.low });
    if (c.close > c.open && body / rng >= 0.55 && fut.length && Math.min(...fut.map(x => x.close)) < c.low * 0.9992 && !w.slice(i + 1).some(x => x.high >= c.high)) obs.push({ type: 'bearish', i, high: c.high, low: c.low });
  }
  const sweeps: Sweep[] = [];
  for (let i = 25; i < n; i++) {
    let rh = -Infinity, rl = Infinity; for (let k = i - 25; k < i; k++) { rh = Math.max(rh, w[k].high); rl = Math.min(rl, w[k].low); }
    if (w[i].low < rl && w[i].close > rl) sweeps.push({ type: 'sellside', i });
    if (w[i].high > rh && w[i].close < rh) sweeps.push({ type: 'buyside', i });
  }
  return { fvgs: unmit, obs: obs.slice(-6), sweeps: sweeps.slice(-5) };
}

function score(price: number, d: ReturnType<typeof detect>) {
  let bull = 0, bear = 0; const why: string[] = [];
  for (const f of d.fvgs.slice(-3)) { const dist = Math.abs(price - (f.top + f.bottom) / 2) / price; const pts = dist < 0.003 ? 2 : dist < 0.006 ? 1 : 0; if (!pts) continue; if (f.type === 'bullish') bull += pts; else bear += pts; why.push(`${pts === 2 ? 'near' : 'approaching'} ${f.type} FVG`); }
  for (const o of d.obs.slice(-3)) { const pts = o.low <= price && price <= o.high ? 2 : Math.abs(price - (o.high + o.low) / 2) / price < 0.005 ? 1 : 0; if (!pts) continue; if (o.type === 'bullish') bull += pts; else bear += pts; why.push(`${pts === 2 ? 'inside' : 'near'} ${o.type} OB`); }
  const s = d.sweeps.at(-1); if (s) { if (s.type === 'sellside') bull += 1; else bear += 1; why.push(`recent ${s.type} sweep`); }
  return { bull: Math.min(5, bull), bear: Math.min(5, bear), why };
}

const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
const stat = (trades: any[], b: Bar[]) => { const split = b[Math.floor(b.length / 2)].time; const h1 = trades.filter(x => x.entryAt < split), h2 = trades.filter(x => x.entryAt >= split); return { n: trades.length, avgR: R(trades), sumR: R(trades) * trades.length, win: trades.length ? trades.filter(x => x.pnl > 0).length / trades.length : 0, h1: R(h1) * h1.length, h2: R(h2) * h2.length, stops: trades.filter(x => x.exitReason === 'sl').length }; };
const fmt = (s: ReturnType<typeof stat>) => `n=${String(s.n).padStart(4)} R/t=${s.avgR.toFixed(3).padStart(7)} sum=${s.sumR.toFixed(1).padStart(7)} win=${Math.round(s.win * 100)}% halves=${s.h1.toFixed(1)}/${s.h2.toFixed(1)} stops=${s.stops}`;

console.log(`ICT confluence scanner on Delta · ${SYMBOLS.join(', ')} · ${TFS.join(', ')} · ${BARS} bars · signal at ${MIN}/5 · the account's exits, 0.12% round trip paid`);
for (const symbol of SYMBOLS) {
  const product = await rest.product(symbol);
  for (const tf of TFS) {
    const raw = await rest.recentCandles(symbol, tf, BARS, TF_SECONDS[tf]);
    const b: Bar[] = raw.slice(0, -1).map(c => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
    const events: ScanEvent[] = []; let lastLong = -99, lastShort = -99; let scored = 0; const reasons = new Map<string, number>();
    for (let i = 60; i < b.length; i++) {
      const w = b.slice(Math.max(0, i - WINDOW + 1), i + 1);
      const sc = score(b[i].close, detect(w));
      if (sc.bull >= MIN && sc.bull > sc.bear && i - lastLong >= 10) { lastLong = i; events.push({ kind: 'entry', side: 'long', tp: [], label: `ict ${sc.bull}/5`, message: sc.why.join(', '), source: 'derived', barTime: b[i].time, barIndex: i }); scored++; for (const r of sc.why) reasons.set(r, (reasons.get(r) ?? 0) + 1); }
      else if (sc.bear >= MIN && sc.bear > sc.bull && i - lastShort >= 10) { lastShort = i; events.push({ kind: 'entry', side: 'short', tp: [], label: `ict ${sc.bear}/5`, message: sc.why.join(', '), source: 'derived', barTime: b[i].time, barIndex: i }); scored++; for (const r of sc.why) reasons.set(r, (reasons.get(r) ?? 0) + 1); }
    }
    const base = { scannerId: 'ict-confluence', scannerName: 'ICT confluence', symbol, tf, bars: b, events, cfg: cfg.paper, exitMode: 'levels' as const, contractValue: Number(product?.contract_value ?? 1), tickSize: Number(product?.tick_size ?? 0.5), spreadPct: 0.12 };
    const run = (patch: Record<string, unknown> = {}) => runBacktest({ ...base, ...patch } as any);
    const spread = run(); const gross = run({ spreadPct: 0, cfg: { ...cfg.paper, feeRatePct: 0, feeTaxPct: 0, slippageBps: 0 } }); const er = run({ chopGate: { minEr: 0.1 } });
    // the random-entry baseline: the same number of entries with the same sides on random bars, 20 seeded draws
    const sides = events.map(e => e.side!); let randSum = 0, randN = 0; let x = 12345 + symbol.length * 7 + tf.length;
    const rnd = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let k = 0; k < 20; k++) { const evs: ScanEvent[] = sides.map(side => { const i = 60 + Math.floor(rnd() * (b.length - 62)); return { kind: 'entry' as const, side, tp: [], label: 'random', message: '', source: 'derived' as const, barTime: b[i].time, barIndex: i }; }).sort((a, c) => a.barIndex - c.barIndex); const r = run({ events: evs }); randSum += R(r.trades) * r.trades.length; randN += r.trades.length; }
    const days = (b.at(-1)!.time - b[0].time) / 86400_000;
    console.log(`\n${symbol} ${tf} · ${b.length} bars (${days.toFixed(0)} days) · ${scored} signals (${events.filter(e => e.side === 'long').length} long / ${events.filter(e => e.side === 'short').length} short) · refused: ${JSON.stringify(spread.rejected)}`);
    console.log(`  spread paid   ${fmt(stat(spread.trades, b))}`);
    console.log(`  gross         ${fmt(stat(gross.trades, b))}`);
    console.log(`  spread+er0.1  ${fmt(stat(er.trades, b))}`);
    console.log(`  random entry  n=${String(Math.round(randN / 20)).padStart(4)} R/t=${(randN ? randSum / randN : 0).toFixed(3).padStart(7)} sum=${(randSum / 20).toFixed(1).padStart(7)}  (same count and sides, 20 draws)`);
    console.log(`  top reasons: ${[...reasons].sort((a, c) => c[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
  }
}
process.exit(0);
