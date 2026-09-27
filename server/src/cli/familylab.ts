/**
 * Scripts as indicators, families as strategies.
 *
 *   STAGE=states   IDS=ids.txt MARKET=ETHUSD TFS=5m,15m,1h,4h npm run familylab   # run every script once, cache its reading
 *   STAGE=strategy MARKET=ETHUSD TFS=5m,15m,1h,4h OUT=rows.tsv PICKS=picks.json npm run familylab   # form families, backtest, halves
 *   STAGE=transfer MARKET=BTCUSD PICKS=picks.json OUT=rows.tsv npm run familylab   # the same families and k, on a market they never saw
 *
 * A Pine script is not read here for its signals but for its *state*: on every closed bar it says
 * "up" or "down" through the side of price against the lines it draws, the colour it paints them, the
 * sign of its oscillator, or the last direction it called. Each of those readings becomes a vote of
 * −1/0/+1 per bar, and the vote series — not the script's alerts — is what is judged.
 *
 * Stage `states` runs each script once per timeframe and caches its four readings and its entry
 * events. Stage `strategy` scores every reading on the FIRST half of history only (does the vote
 * agree with the next H bars?), keeps the informative ones, and builds a family by greedy diversity:
 * best first, then the next best whose votes are not already spoken for by a member. Two strategies
 * are then backtested one by one on the live exit rules and reported in halves:
 *
 *   consensus       — enter when the family's summed vote crosses ±k; no script is the trigger
 *   trigger+family  — each script's own entries, kept only when the family agrees by ≥ k
 *
 * Nothing about the second half is used to choose readings, members, k, or sign. Labels are not a
 * reading: their time is the pivot they point at, not the bar they were drawn on (decision 44).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DeltaRest } from '../delta/rest.ts';
import { PinePool } from '../pine/pool.ts';
import { ScannerRegistry } from '../scanners/registry.ts';
import { extractEvents, type ScanEvent, type Side } from '../scanners/extractor.ts';
import { applyRules, selectTrail, selectOscillator } from '../scanners/rules.ts';
import { runBacktest } from '../paper/backtest.ts';
import { ConfigStore, TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { WorkerPlot, WorkerResult } from '../pine/worker.ts';

const STAGE = process.env.STAGE ?? 'strategy';
const MARKET = process.env.MARKET ?? 'ETHUSD';
const TFS = (process.env.TFS ?? '5m,15m,1h,4h').split(',');
const CACHE = path.resolve(process.env.CACHE ?? 'data/cache/family');
const BARS: Record<string, number> = { '5m': 4000, '15m': 4000, '1h': 3000, '4h': 2000 };
const SUB: Record<string, string> = { '5m': '1m', '15m': '1m', '1h': '15m', '4h': '15m' };
/** Bars ahead a reading is scored against: about a day on 5m, a week on 4h — the hold of a trade. */
const HORIZON: Record<string, number> = { '5m': 24, '15m': 16, '1h': 12, '4h': 8 };

type Comp = 'trail' | 'osc' | 'color' | 'event' | 'vote';
const COMPS: Comp[] = ['trail', 'osc', 'color', 'event', 'vote'];
interface ScriptState { category: string; comps: Record<Comp, string>; entries: Array<[number, Side]> }
interface TfCache { market: string; tf: string; contractValue: number; tickSize: number; bars: Bar[]; sub: Bar[]; scripts: Record<string, ScriptState> }

const cfg = new ConfigStore().get();
if (process.env.PAPER) Object.assign(cfg.paper, JSON.parse(fs.readFileSync(process.env.PAPER, 'utf8')));
const registry = new ScannerRegistry();
const rest = new DeltaRest();
const toBars = (c: any[]): Bar[] => c.slice(0, -1).map(x => ({ time: x.time * 1000, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
const cacheFile = (tf: string) => path.join(CACHE, `${MARKET}-${tf}.json`);
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const enc = (v: number[]) => v.map(x => (x > 0 ? '+' : x < 0 ? '-' : '0')).join('');
const dec = (s: string) => Array.from(s, ch => (ch === '+' ? 1 : ch === '-' ? -1 : 0));

// ---------------------------------------------------------------- readings

function alignPlot(p: WorkerPlot, bars: Bar[]): Array<number | null> {
  const at = new Map<number, number>();
  for (const d of p.data) if (d.value !== null) at.set(d.time, d.value);
  return bars.map(b => at.get(b.time) ?? null);
}

/** The side a plotted colour argues for: green-ish up, red-ish down, anything else silent. */
function colorSign(c: unknown): number {
  if (typeof c !== 'string' || !c) return 0;
  const s = c.toLowerCase();
  let m = s.match(/^#([0-9a-f]{6})/);
  let r = -1, g = -1, b = -1;
  if (m) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
  else if ((m = s.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/))) { r = +m[1]; g = +m[2]; b = +m[3]; }
  if (r >= 0) {
    if (g > r * 1.25 && g >= b * 0.8) return 1;
    if (r > g * 1.25 && r >= b * 0.8) return -1;
    return 0;
  }
  if (/green|lime|teal|aqua|olive/.test(s)) return 1;
  if (/red|maroon|orange|fuchsia|pink|crimson/.test(s)) return -1;
  return 0;
}

/** Four independent readings of one script run, each a −1/0/+1 per bar, plus their majority. */
function readings(res: WorkerResult, bars: Bar[]): Record<Comp, number[]> {
  const n = bars.length;
  const trail = new Array<number>(n).fill(0), osc = new Array<number>(n).fill(0), color = new Array<number>(n).fill(0), event = new Array<number>(n).fill(0);
  const sel = selectTrail(res.plots, bars);
  if (sel) for (let i = 0; i < n; i++) { const v = sel.values[i]; if (v !== null) trail[i] = sgn(bars[i].close - v); }
  else {
    // no trailing line: the side of price against every overlay line, by majority
    const lines = res.plots.filter(p => p.overlay && p.style !== 'histogram' && p.style !== 'columns').map(p => alignPlot(p, bars)).filter(v => v.filter(x => x !== null).length >= n * 0.3);
    for (let i = 0; i < n; i++) { let s = 0; for (const v of lines) if (v[i] !== null) s += sgn(bars[i].close - v[i]!); trail[i] = sgn(s); }
  }
  const o = selectOscillator(res.plots, bars);
  if (o) { const mid = o.mode === 'zero' ? 0 : (o.ob + o.os) / 2; for (let i = 0; i < n; i++) { const v = o.values[i]; if (v !== null) osc[i] = sgn(v - mid); } }
  const idx = new Map(bars.map((b, i) => [b.time, i]));
  for (const p of res.plots) for (const d of p.data) { const i = idx.get(d.time); if (i !== undefined) color[i] += colorSign(d.color); }
  for (let i = 0; i < n; i++) color[i] = sgn(color[i]);
  // the last direction the script called, held until it calls the other; alerts and shapes only
  const calls = extractEvents(res.alerts, res.shapes).filter(e => e.kind === 'entry' && e.side);
  let held = 0, ci = 0;
  calls.sort((a, b) => a.barTime - b.barTime);
  for (let i = 0; i < n; i++) { while (ci < calls.length && calls[ci].barTime <= bars[i].time) held = calls[ci++].side === 'long' ? 1 : -1; event[i] = held; }
  const vote = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) vote[i] = sgn(trail[i] + osc[i] + color[i] + event[i]);
  return { trail, osc, color, event, vote };
}

// ---------------------------------------------------------------- stage: states

async function stageStates() {
  const ids = fs.readFileSync(process.env.IDS!, 'utf8').split(/\s+/).filter(Boolean).filter(id => registry.get(id)?.status === 'ok');
  fs.mkdirSync(CACHE, { recursive: true });
  const p = await rest.product(MARKET);
  const contractValue = Number(p?.contract_value ?? 0.001), tickSize = Number(p?.tick_size ?? 0.5);
  const pool = new PinePool(Number(process.env.CONCURRENCY ?? 8), 120_000);
  for (const tf of TFS) {
    const bars = toBars(await rest.recentCandles(MARKET, tf, BARS[tf], TF_SECONDS[tf]));
    const need = Math.ceil((bars.length + 2) * TF_SECONDS[tf] / TF_SECONDS[SUB[tf]]);
    const sub = toBars(await rest.recentCandles(MARKET, SUB[tf], Math.min(need, 60_000), TF_SECONDS[SUB[tf]]));
    const out: TfCache = { market: MARKET, tf, contractValue, tickSize, bars, sub, scripts: {} };
    console.error(`${MARKET} ${tf}: ${bars.length} bars, ${sub.length} ${SUB[tf]} bars, ${ids.length} scripts`);
    let done = 0, failed = 0, next = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY ?? 8) }, async () => {
      for (;;) {
        const id = ids[next++]; if (id === undefined) return;
        const s = registry.get(id)!;
        const inputs = cfg.scanners[id]?.inputs;
        try {
          const res = await pool.run({ scannerId: id, source: s.patched, symbol: MARKET, tf, tickSize, bars, tailBars: 'all', plotTail: bars.length, inputs: inputs && Object.keys(inputs).length ? inputs : undefined, timezone: cfg.scanners[id]?.timezone });
          if (!res.ok) { failed++; }
          else {
            const r = readings(res, bars);
            const derived = applyRules({ scannerId: id, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: cfg.scanners[id]?.rule ?? null, bars, mode: 'backtest' });
            const idx = new Map(bars.map((b, i) => [b.time, i]));
            const entries: Array<[number, Side]> = [];
            for (const e of extractEvents(res.alerts, res.shapes, { derived })) { const i = idx.get(e.barTime); if (e.kind === 'entry' && e.side && i !== undefined) entries.push([i, e.side]); }
            out.scripts[id] = { category: s.category, comps: { trail: enc(r.trail), osc: enc(r.osc), color: enc(r.color), event: enc(r.event), vote: enc(r.vote) }, entries };
            done++;
          }
        } catch { failed++; }
        if ((done + failed) % 50 === 0) console.error(`  ${done + failed}/${ids.length} · ${failed} failed · ${((Date.now() - started) / 60000).toFixed(0)} min`);
      }
    }));
    fs.writeFileSync(cacheFile(tf), JSON.stringify(out));
    console.error(`  wrote ${cacheFile(tf)}: ${done} scripts, ${failed} failed, ${((Date.now() - started) / 60000).toFixed(0)} min`);
  }
  await pool.stop();
}

// ---------------------------------------------------------------- stage: strategy

interface Reading { id: string; category: string; comp: Comp; sign: 1 | -1; t: number; n: number; votes: number[] }

/** How well a vote series anticipates the next H bars, on the bars before `split` only. */
function score(v: number[], bars: Bar[], H: number, split: number): { t: number; n: number; a: number } {
  let n = 0, s = 0;
  for (let i = 0; i + H < bars.length && bars[i + H].time < split; i++) {
    if (!v[i]) continue;
    n++; s += v[i] * sgn(bars[i + H].close - bars[i].close);
  }
  const a = n ? s / n : 0;
  return { t: a * Math.sqrt(n), n, a };
}

/** Agreement of two vote series where both speak: +1 identical, −1 opposite. */
function agreement(a: number[], b: number[]): number {
  let n = 0, s = 0;
  for (let i = 0; i < a.length; i++) if (a[i] && b[i]) { n++; s += a[i] * b[i]; }
  return n ? s / n : 0;
}

function mkEvent(bars: Bar[], i: number, side: Side, label: string): ScanEvent {
  return { kind: 'entry', side, tp: [], label, message: label, source: 'derived', barTime: bars[i].time, barIndex: i };
}

interface Row { strategy: string; tf: string; k: number; trades: number; avgR: number; totalR: number; t1: number; r1: number; t2: number; r2: number; longs: number; rLong: number; shorts: number; rShort: number; base?: Row }

function stageStrategy() {
  // collected and written at the end: a stream would still be flushing when the process exits
  const lines: string[] = [];
  const out = { write: (l: string) => lines.push(l), end: () => fs.writeFileSync(process.env.OUT ?? '/tmp/familylab.tsv', lines.join('')) };
  out.write(['strategy', 'tf', 'k', 'trades', 'avgR', 'totalR', 'trades1', 'avgR1', 'trades2', 'avgR2', 'baseTrades2', 'baseAvgR2', 'longs', 'avgRlong', 'shorts', 'avgRshort'].join('\t') + '\n');
  const MIN_T = Number(process.env.MIN_T ?? 3);
  const MAX_AGREE = Number(process.env.MAX_AGREE ?? 0.5);
  const SIZES = (process.env.SIZES ?? '3,5,7').split(',').map(Number);
  const MIN_ENTRIES = Number(process.env.MIN_ENTRIES ?? 15);
  const picks: Pick[] = [];

  for (const tf of TFS) {
    if (!fs.existsSync(cacheFile(tf))) { console.error(`no cache for ${tf}; run STAGE=states first`); continue; }
    const c: TfCache = JSON.parse(fs.readFileSync(cacheFile(tf), 'utf8'));
    const { bars, sub } = c;
    const split = bars[Math.floor(bars.length / 2)].time;
    const H = HORIZON[tf] ?? 12;
    const bt = (events: ScanEvent[], id: string) => runBacktest({ scannerId: id, scannerName: id, symbol: MARKET, tf, bars, events, cfg: cfg.paper, exitMode: 'both', contractValue: c.contractValue, tickSize: c.tickSize, subBars: sub }).trades as any[];
    const row = (strategy: string, k: number, trades: any[]): Row => {
      const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
      const h1 = trades.filter(x => x.entryAt < split), h2 = trades.filter(x => x.entryAt >= split);
      const L = trades.filter(x => x.side === 'long'), Sh = trades.filter(x => x.side === 'short');
      return { strategy, tf, k, trades: trades.length, avgR: R(trades), totalR: R(trades) * trades.length, t1: h1.length, r1: R(h1), t2: h2.length, r2: R(h2), longs: L.length, rLong: R(L), shorts: Sh.length, rShort: R(Sh) };
    };
    const emit = (r: Row) => {
      out.write([r.strategy, r.tf, r.k, r.trades, r.avgR.toFixed(3), r.totalR.toFixed(1), r.t1, r.r1.toFixed(3), r.t2, r.r2.toFixed(3), r.base?.t2 ?? '', r.base ? r.base.r2.toFixed(3) : '', r.longs, r.rLong.toFixed(3), r.shorts, r.rShort.toFixed(3)].join('\t') + '\n');
    };

    // 1. every reading of every script, scored on the first half; the best reading per script kept
    // a reading has to be an indicator, not a bias: it must change its mind, and spend real time on
    // both sides. A constant "up" scores well in any rising half and says nothing about the next one.
    const MIN_FLIPS = Math.max(20, Math.floor(bars.length / 100)), MIN_SIDE = Number(process.env.MIN_SIDE ?? 0.15);
    const isIndicator = (v: number[]) => {
      let flips = 0, up = 0, dn = 0, prev = 0;
      for (const x of v) { if (!x) continue; if (prev && x !== prev) flips++; prev = x; if (x > 0) up++; else dn++; }
      const nz = up + dn;
      return flips >= MIN_FLIPS && nz > 0 && up / nz >= MIN_SIDE && dn / nz >= MIN_SIDE;
    };
    const best: Reading[] = [];
    let considered = 0;
    for (const [id, s] of Object.entries(c.scripts)) {
      let top: Reading | null = null;
      for (const comp of COMPS) {
        const v = dec(s.comps[comp]);
        if (!isIndicator(v)) continue;
        considered++;
        const sc = score(v, bars, H, split);
        if (sc.n < 200) continue;
        if (!top || Math.abs(sc.t) > Math.abs(top.t)) top = { id, category: s.category, comp, sign: sc.t >= 0 ? 1 : -1, t: sc.t, n: sc.n, votes: v };
      }
      if (top) best.push(top);
    }
    const informative = best.filter(r => Math.abs(r.t) >= MIN_T).sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
    // signed votes: a reading that anticipates the move backwards is used inverted
    for (const r of informative) if (r.sign < 0) r.votes = r.votes.map(x => -x);
    const byComp = COMPS.map(k => `${k} ${informative.filter(r => r.comp === k).length}`).join(' ');
    console.error(`\n${MARKET} ${tf}: ${considered} readings behave like indicators (≥${MIN_FLIPS} flips, ≥${MIN_SIDE * 100}% each side) from ${best.length} scripts; ${informative.length} informative at |t|≥${MIN_T} on the first half (H=${H}) — ${byComp}`);
    console.error(`  top readings: ` + informative.slice(0, 12).map(r => `${r.id}[${r.comp}${r.sign < 0 ? '⁻' : ''} t=${r.t.toFixed(1)}]`).join('  '));

    // 2. the family: best first, then the next best that does not just repeat a member
    for (const N of SIZES) {
      const fam: Reading[] = [];
      for (const r of informative) {
        if (fam.length >= N) break;
        if (fam.some(m => Math.abs(agreement(m.votes, r.votes)) > MAX_AGREE)) continue;
        if (fam.filter(m => m.category === r.category).length >= Math.max(2, Math.ceil(N / 3))) continue;
        fam.push(r);
      }
      if (fam.length < 3) { console.error(`  family of ${N}: only ${fam.length} diverse readings, skipped`); continue; }
      console.error(`  family of ${N}: ` + fam.map(r => `${r.id}[${r.comp}${r.sign < 0 ? '⁻' : ''} ${r.category} t=${r.t.toFixed(1)}]`).join('  '));
      const S = bars.map((_, i) => fam.reduce((a, r) => a + r.votes[i], 0));
      const famPick: Pick = { tf, N, members: fam.map(r => ({ id: r.id, comp: r.comp, sign: r.sign })), triggers: [] };
      picks.push(famPick);

      // 2a. consensus: the family alone, entering when its sum crosses ±k
      for (let k = Math.ceil(fam.length / 2); k <= fam.length; k++) {
        const events: ScanEvent[] = [];
        for (let i = 1; i < bars.length; i++) {
          if (S[i] >= k && S[i - 1] < k) events.push(mkEvent(bars, i, 'long', `family${N} consensus ≥${k}`));
          if (S[i] <= -k && S[i - 1] > -k) events.push(mkEvent(bars, i, 'short', `family${N} consensus ≤-${k}`));
        }
        const r = row(`consensus/family${N}`, k, bt(events, `family${N}`));
        emit(r);
        console.error(`    consensus k=${k}: ${r.trades} trades ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(3)}R (${r.totalR.toFixed(0)}R) · halves ${r.t1}/${r.r1.toFixed(3)} ${r.t2}/${r.r2.toFixed(3)} · long ${r.longs}/${r.rLong.toFixed(2)} short ${r.shorts}/${r.rShort.toFixed(2)}`);
      }

      // 2b. each script as the trigger, its entries kept only when the family agrees; k is chosen
      //     on the first half and the second half is the verdict
      const triggers = Object.entries(c.scripts).filter(([, s]) => s.entries.filter(([i]) => bars[i].time < split).length >= MIN_ENTRIES && s.entries.filter(([i]) => bars[i].time >= split).length >= MIN_ENTRIES);
      const results: Row[] = [];
      for (const [id, s] of triggers) {
        const all = s.entries.map(([i, side]) => mkEvent(bars, i, side, id));
        const base = row(`${id}/base`, 0, bt(all, id));
        // a trigger that sits in the family must not confirm itself
        const self = fam.find(r => r.id === id);
        const Sx = self ? S.map((v, i) => v - self.votes[i]) : S;
        let pick: Row | null = null;
        for (let k = 1; k <= fam.length - (self ? 1 : 0); k++) {
          const kept = s.entries.filter(([i, side]) => (side === 'long' ? Sx[i] : -Sx[i]) >= k).map(([i, side]) => mkEvent(bars, i, side, id));
          if (kept.length < MIN_ENTRIES) break;
          const r = row(`${id}/family${N}`, k, bt(kept, id));
          r.base = base;
          if (!pick || r.r1 * r.t1 > pick.r1 * pick.t1) pick = r;
        }
        if (pick) { results.push(pick); emit(pick); }
        if (pick) picks.at(-1)!.triggers.push({ id, k: pick.k });
      }
      results.sort((a, b) => b.r2 * b.t2 - a.r2 * a.t2);
      console.error(`    trigger+family${N}: ${results.length} triggers · second-half total R, filtered vs unfiltered:`);
      for (const r of results.slice(0, 10)) console.error(`      ${r.strategy.padEnd(58)} k=${r.k} ${String(r.t2).padStart(4)} trades ${(r.r2 * r.t2).toFixed(1).padStart(7)}R  vs base ${String(r.base!.t2).padStart(4)} trades ${(r.base!.r2 * r.base!.t2).toFixed(1).padStart(7)}R   (first half ${(r.r1 * r.t1).toFixed(1)}R vs ${(r.base!.r1 * r.base!.t1).toFixed(1)}R)`);
      const better = results.filter(r => r.r2 * r.t2 > r.base!.r2 * r.base!.t2).length;
      console.error(`    filter beat its own baseline in the second half on ${better}/${results.length} triggers`);
    }
  }
  out.end();
  fs.writeFileSync(process.env.PICKS ?? '/tmp/familylab-picks.json', JSON.stringify(picks, null, 1));
}

interface Pick { tf: string; N: number; members: Array<{ id: string; comp: Comp; sign: 1 | -1 }>; triggers: Array<{ id: string; k: number }> }

/**
 * The families and thresholds chosen on one market, applied unchanged to another. Nothing here is
 * fitted: every bar of this market is out of sample, and the halves are only reported for symmetry.
 */
function stageTransfer() {
  const picks: Pick[] = JSON.parse(fs.readFileSync(process.env.PICKS ?? '/tmp/familylab-picks.json', 'utf8'));
  const lines: string[] = [];
  lines.push(['strategy', 'tf', 'k', 'trades', 'avgR', 'totalR', 'trades1', 'avgR1', 'trades2', 'avgR2', 'baseTrades', 'baseAvgR', 'longs', 'avgRlong', 'shorts', 'avgRshort'].join('\t') + '\n');
  for (const tf of TFS) {
    if (!fs.existsSync(cacheFile(tf))) { console.error(`no cache for ${MARKET} ${tf}`); continue; }
    const c: TfCache = JSON.parse(fs.readFileSync(cacheFile(tf), 'utf8'));
    const { bars, sub } = c;
    const split = bars[Math.floor(bars.length / 2)].time;
    const bt = (events: ScanEvent[], id: string) => runBacktest({ scannerId: id, scannerName: id, symbol: MARKET, tf, bars, events, cfg: cfg.paper, exitMode: 'both', contractValue: c.contractValue, tickSize: c.tickSize, subBars: sub }).trades as any[];
    const R = (xs: any[]) => (xs.length ? xs.reduce((a, x) => a + (x.rMultiple ?? 0), 0) / xs.length : 0);
    const stat = (t: any[]) => { const h1 = t.filter(x => x.entryAt < split), h2 = t.filter(x => x.entryAt >= split), L = t.filter(x => x.side === 'long'), Sh = t.filter(x => x.side === 'short'); return { n: t.length, r: R(t), n1: h1.length, r1: R(h1), n2: h2.length, r2: R(h2), nl: L.length, rl: R(L), ns: Sh.length, rs: R(Sh) }; };
    const emit = (name: string, k: number, t: any[], base?: any[]) => {
      const s = stat(t), b = base ? stat(base) : null;
      lines.push([name, tf, k, s.n, s.r.toFixed(3), (s.r * s.n).toFixed(1), s.n1, s.r1.toFixed(3), s.n2, s.r2.toFixed(3), b?.n ?? '', b ? b.r.toFixed(3) : '', s.nl, s.rl.toFixed(3), s.ns, s.rs.toFixed(3)].join('\t') + '\n');
      return s;
    };
    for (const p of picks.filter(p => p.tf === tf)) {
      const members = p.members.map(m => ({ ...m, votes: c.scripts[m.id] ? dec(c.scripts[m.id].comps[m.comp]).map(x => x * m.sign) : null }));
      const present = members.filter(m => m.votes);
      if (present.length < 3) { console.error(`${MARKET} ${tf} family${p.N}: only ${present.length} members readable here, skipped`); continue; }
      const S = bars.map((_, i) => present.reduce((a, m) => a + m.votes![i], 0));
      console.error(`\n${MARKET} ${tf} family${p.N}: ${present.length}/${p.members.length} members readable`);
      for (let k = Math.ceil(present.length / 2); k <= present.length; k++) {
        const events: ScanEvent[] = [];
        for (let i = 1; i < bars.length; i++) {
          if (S[i] >= k && S[i - 1] < k) events.push(mkEvent(bars, i, 'long', `family${p.N} consensus ≥${k}`));
          if (S[i] <= -k && S[i - 1] > -k) events.push(mkEvent(bars, i, 'short', `family${p.N} consensus ≤-${k}`));
        }
        const s = emit(`consensus/family${p.N}`, k, bt(events, `family${p.N}`));
        console.error(`    consensus k=${k}: ${s.n} trades ${s.r >= 0 ? '+' : ''}${s.r.toFixed(3)}R (${(s.r * s.n).toFixed(0)}R) · halves ${s.n1}/${s.r1.toFixed(3)} ${s.n2}/${s.r2.toFixed(3)} · long ${s.nl}/${s.rl.toFixed(2)} short ${s.ns}/${s.rs.toFixed(2)}`);
      }
      let n = 0, up = 0, pos = 0, basePos = 0, sumBase = 0, sumFilt = 0;
      for (const t of p.triggers) {
        const sc = c.scripts[t.id];
        if (!sc || sc.entries.length < 10) continue;
        const self = present.find(m => m.id === t.id);
        const Sx = self ? S.map((v, i) => v - self.votes![i]) : S;
        const k = Math.min(t.k, present.length - (self ? 1 : 0));
        if (k < 1) continue;
        const all = sc.entries.map(([i, side]) => mkEvent(bars, i, side, t.id));
        const kept = sc.entries.filter(([i, side]) => (side === 'long' ? Sx[i] : -Sx[i]) >= k).map(([i, side]) => mkEvent(bars, i, side, t.id));
        const base = bt(all, t.id), filt = bt(kept, t.id);
        const s = emit(`${t.id}/family${p.N}`, k, filt, base);
        const b = stat(base);
        n++; if (s.r > b.r) up++; if (s.r * s.n > 0) pos++; if (b.r * b.n > 0) basePos++; sumBase += b.r * b.n; sumFilt += s.r * s.n;
      }
      console.error(`    ${n} triggers carried over: R/trade up on ${up}, total R > 0 on ${pos} (unfiltered ${basePos}); sum unfiltered ${sumBase.toFixed(0)}R, filtered ${sumFilt.toFixed(0)}R`);
    }
  }
  fs.writeFileSync(process.env.OUT ?? '/tmp/familylab-transfer.tsv', lines.join(''));
}

if (STAGE === 'states') await stageStates(); else if (STAGE === 'transfer') stageTransfer(); else stageStrategy();
process.exit(0);
