/**
 * Per-scanner derivation rules for scripts that publish market-structure information but
 * never phrase it as a trade call. Each rule turns the script's own events (alerts, labels)
 * into `entry` events; stop/target come from the script where it publishes them, otherwise
 * the paper engine's ATR fallback applies. Derived events are tagged `source: 'derived'`.
 *
 * Label-driven rules need care: a label's `time` is the bar it is anchored to (e.g. the
 * pivot), not the bar on which the script confirmed it. Live runs therefore fire on the bar
 * where a label FIRST APPEARS (`newLabelKeys`); backtests shift the anchor by `delayBars`.
 */
import type { WorkerAlert, WorkerLabel, WorkerPlot, WorkerShape } from '../pine/worker.ts';
import type { ScanEvent, Side } from './extractor.ts';
import type { Bar } from '../data/candleStore.ts';
import type { GenericRule } from '../config.ts';

export interface RuleContext {
  scannerId: string;
  alerts: WorkerAlert[];
  shapes: WorkerShape[];
  labels: WorkerLabel[];
  bars: Bar[];
  mode: 'live' | 'backtest';
  /** Labels not present in the previous run (live only). */
  newLabelKeys?: Set<string>;
  /** Plot series (needed by the generic rules; must cover the bars a backtest replays). */
  plots?: WorkerPlot[];
  /** Generic rule selected per scanner in config (`scanners.<id>.rule`); replaces the per-scanner rule. */
  rule?: GenericRule | null;
}

export type Rule = (ctx: RuleContext) => ScanEvent[];

export const labelKey = (l: WorkerLabel) => `${l.text}@${l.time}@${Math.round(l.y * 100)}`;

const NUMRE = /-?\d+(?:[.,]\d+)?/;
const numIn = (s: string) => { const m = s.match(NUMRE); return m ? Number(m[0].replace(/,/g, '')) : undefined; };

function mk(ctx: RuleContext, barTime: number, side: Side, label: string, message: string, extra: Partial<ScanEvent> = {}): ScanEvent {
  return { kind: 'entry', side, tp: [], label, message, source: 'derived', barTime, barIndex: -1, ...extra };
}

/** Bar time at which a label anchored at `time` is treated as confirmed. */
function confirmedBarTime(ctx: RuleContext, time: number, delayBars: number): number | null {
  const bars = ctx.bars;
  if (!bars.length) return null;
  let i = bars.findIndex(b => b.time >= time);
  if (i < 0) i = bars.length - 1;
  const j = Math.min(bars.length - 1, i + delayBars);
  return bars[j].time;
}

function closeAt(ctx: RuleContext, barTime: number): number | undefined {
  const b = ctx.bars.find(x => x.time === barTime);
  return b?.close;
}

/** Turn selected info alerts into entries by regex; `side` from a callback. */
function alertRule(opts: { match: RegExp; side: (msg: string) => Side | undefined; label: (msg: string) => string; tp?: (msg: string) => number[]; sl?: (msg: string) => number | undefined }): Rule {
  return (ctx) => {
    const out: ScanEvent[] = [];
    for (const a of ctx.alerts) {
      if (a.type !== 'alert' || !opts.match.test(a.message)) continue;
      const side = opts.side(a.message);
      if (!side) continue;
      const price = numIn((a.message.match(/Price:\s*(-?\d+(?:[.,]\d+)?)/i) ?? [])[1] ?? '') ?? closeAt(ctx, a.time);
      out.push(mk(ctx, a.time, side, opts.label(a.message), a.message.slice(0, 500), { price, tp: opts.tp?.(a.message) ?? [], sl: opts.sl?.(a.message) }));
    }
    return out;
  };
}

/** Labels whose text matches → entries; live: only labels that just appeared; backtest: anchor + delay. */
function labelRule(opts: { match: RegExp; side: (text: string, l: WorkerLabel) => Side | undefined; delayBars: number; label: (text: string) => string; target?: (ctx: RuleContext, l: WorkerLabel, side: Side) => number[] }): Rule {
  return (ctx) => {
    const out: ScanEvent[] = [];
    const lastTime = ctx.bars.at(-1)?.time ?? 0;
    const tfMs = ctx.bars.length > 1 ? ctx.bars[1].time - ctx.bars[0].time : 900_000;
    for (const l of ctx.labels) {
      if (!opts.match.test(l.text)) continue;
      const side = opts.side(l.text, l);
      if (!side) continue;
      let barTime: number | null;
      if (ctx.mode === 'live') {
        if (!ctx.newLabelKeys?.has(labelKey(l))) continue;          // only labels that appeared on this run
        if (lastTime - l.time > tfMs * 40) continue;                 // ignore ancient labels on the first run
        barTime = lastTime;
      } else {
        barTime = confirmedBarTime(ctx, l.time, opts.delayBars);
      }
      if (barTime === null) continue;
      const tp = opts.target ? opts.target(ctx, l, side) : [];
      out.push(mk(ctx, barTime, side, opts.label(l.text), `label "${l.text.replace(/\n/g, ' ')}" at ${l.y}`, { price: closeAt(ctx, barTime), tp }));
    }
    return out;
  };
}

const arrowSide = (s: string): Side | undefined => (/↑|▲|\bUP\b|BULL/i.test(s) ? 'long' : /↓|▼|\bDOWN\b|BEAR/i.test(s) ? 'short' : undefined);

export const RULES: Record<string, Rule> = {
  // "🟢 CHoCH ↑ Reversal | … | Price: #" — change of character = structure reversal entry. BOS stays info.
  'adaptive-pivot-structure': alertRule({
    match: /CHoCH\s*[↑↓]\s*Reversal/i,
    side: (m) => arrowSide(m.split('|')[0]),
    label: (m) => (arrowSide(m.split('|')[0]) === 'long' ? 'CHoCH ↑ reversal' : 'CHoCH ↓ reversal'),
  }),

  // "🟡 SQUEEZE FIRED | … | Direction: BULLISH | Price: #"
  'adaptive-squeeze-momentum-pro': alertRule({
    match: /SQUEEZE FIRED/i,
    side: (m) => (/Direction:\s*BULL/i.test(m) ? 'long' : /Direction:\s*BEAR/i.test(m) ? 'short' : undefined),
    label: (m) => (/BULL/i.test(m) ? 'Squeeze fired ▲' : 'Squeeze fired ▼'),
  }),

  // "📐 80% RULE | … | Open below yVA, re-accepted inside → target yVAH #"
  'daily-volume-profile-pro': alertRule({
    match: /80% RULE/i,
    side: (m) => (/Open below/i.test(m) ? 'long' : /Open above/i.test(m) ? 'short' : undefined),
    label: (m) => (/Open below/i.test(m) ? '80% rule ▲ to yVAH' : '80% rule ▼ to yVAL'),
    tp: (m) => { const v = numIn((m.match(/target\s+yVA[HL]\s+(-?\d+(?:[.,]\d+)?)/i) ?? [])[1] ?? ''); return v ? [v] : []; },
  }),

  // "🟡 ENTRY ZONE | … | Price: #" — direction/targets from the script's TP1..TP4 labels.
  'automatic-fibonacci-levels': (ctx) => {
    // The worker exposes final drawing state, not historical TP snapshots.
    // Deriving old entries from those labels would leak future targets/direction.
    if (ctx.mode === 'backtest') return [];
    const tpLabels = ctx.labels.filter(l => /^TP\d$/i.test(l.text.trim())).map(l => l.y).filter(Number.isFinite);
    if (tpLabels.length < 2) return [];
    return alertRule({
      match: /ENTRY ZONE/i,
      side: (m) => { const p = numIn((m.match(/Price:\s*(-?\d+(?:[.,]\d+)?)/i) ?? [])[1] ?? ''); if (p === undefined) return undefined; const above = tpLabels.filter(t => t > p).length; const below = tpLabels.length - above; return above > below ? 'long' : below > above ? 'short' : undefined; },
      label: () => 'Fib entry zone',
      tp: (m) => { const p = numIn((m.match(/Price:\s*(-?\d+(?:[.,]\d+)?)/i) ?? [])[1] ?? '') ?? 0; const above = tpLabels.filter(t => t > p).sort((a, b) => a - b); const below = tpLabels.filter(t => t < p).sort((a, b) => b - a); return (above.length >= below.length ? above : below).slice(0, 3); },
    })(ctx);
  },

  // "Breakout ▲/▼" labels with a "🎯 <price>" target label.
  'auto-s-r-channels': labelRule({
    match: /^Breakout\s*[▲▼]/i,
    side: (t) => arrowSide(t),
    delayBars: 0,
    label: (t) => (arrowSide(t) === 'long' ? 'S/R breakout ▲' : 'S/R breakout ▼'),
    target: (ctx, l, side) => {
      const tgt = ctx.labels.filter(x => /^🎯/.test(x.text) && Math.abs(x.time - l.time) <= 4 * 3600_000 + 1).map(x => numIn(x.text)).filter((v): v is number => v !== undefined && (side === 'long' ? v > l.y : v < l.y));
      return tgt.slice(0, 1);
    },
  }),

  // Confirmed structure: HL (higher low) → long, LH (lower high) → short. Pivots confirm ~5 bars late.
  'structure-anchored-vwap': labelRule({
    match: /^(HL|LH)$/,
    side: (t) => (t === 'HL' ? 'long' : 'short'),
    delayBars: 5,
    label: (t) => (t === 'HL' ? 'Structure HL (higher low)' : 'Structure LH (lower high)'),
  }),

  // "1. CHoCH + projection" alertcondition; side + levels from the projection labels ("1.000 (x)" = invalidation, "-0.500/-0.618/-1.000 (x)" = targets).
  'elliott-impulse-engine': (ctx) => {
    if (ctx.mode !== 'live') return [];
    const lvl = (name: string) => { const l = ctx.labels.find(x => x.text.startsWith(name + ' (')); return l ? l.y : undefined; };
    const inval = lvl('1.000'); const t1 = lvl('-0.500'); const t2 = lvl('-0.618'); const t3 = lvl('-1.000');
    if (inval === undefined || t3 === undefined) return [];
    const lastTime = ctx.bars.at(-1)?.time ?? 0;
    const out: ScanEvent[] = [];
    for (const a of ctx.alerts) {
      if (a.type !== 'alertcondition' || !/CHoCH \+ projection/i.test(a.title ?? '') || a.time !== lastTime) continue;
      const price = closeAt(ctx, a.time) ?? 0;
      const side: Side | undefined = t3 < price && inval > price ? 'short' : t3 > price && inval < price ? 'long' : undefined;
      if (!side) continue;
      out.push(mk(ctx, a.time, side, `Elliott impulse ${side === 'long' ? '▲' : '▼'} projection`, a.message, { price, sl: inval, tp: [t1, t2, t3].filter((v): v is number => v !== undefined) }));
    }
    return out;
  },
};

export function applyRules(ctx: RuleContext): ScanEvent[] {
  const rule = ctx.rule ? GENERIC_RULES[ctx.rule] : RULES[ctx.scannerId];
  if (!rule) return [];
  try { return rule(ctx); } catch { return []; }
}

// ---------------------------------------------------------------------------------------------
// Generic rules for silent-but-tradeable scripts (enabled per scanner via `scanners.<id>.rule`)
// ---------------------------------------------------------------------------------------------

/** Value of a plot at every bar index (null where the plot is na or missing). */
function alignPlot(p: WorkerPlot, bars: Bar[]): Array<number | null> {
  const byTime = new Map<number, number | null>();
  for (const d of p.data) byTime.set(d.time, d.value);
  return bars.map(b => { const v = byTime.get(b.time); return v === undefined || v === null || !Number.isFinite(v) ? null : v; });
}

const isLine = (p: WorkerPlot) => !/^(shape|char|fill|bgcolor|barcolor|histogram|columns|areabr|area)$/i.test(p.style ?? 'line');
const TRAIL_TITLE = /trail|super\s*trend|supertrend|\bst\b|\bsar\b|chandelier|stop|kijun|trend\s*line|\bts\b|halftrend|ut bot|\bline\b/i;
const UP_TITLE = /\b(up|bull|bullish|long|buy|support|uptrend)\b/i;
const DOWN_TITLE = /\b(down|dn|bear|bearish|short|sell|resistance|downtrend)\b/i;

export interface TrailSelection { title: string; values: Array<number | null>; flips: number; merged: boolean }

/** Count how often the close changes side relative to a series. */
function countFlips(values: Array<number | null>, bars: Bar[]): number {
  let prev: Side | null = null, flips = 0;
  for (let i = 0; i < bars.length; i++) {
    const v = values[i]; if (v === null) continue;
    const side: Side = bars[i].close >= v ? 'long' : 'short';
    if (prev && side !== prev) flips++;
    prev = side;
  }
  return flips;
}

/**
 * Pick the overlay series that behaves like a trailing stop: a title hint wins, otherwise the
 * candidate the close crosses least often (but at least once). Complementary up/down plots
 * (e.g. `plot(up ? st : na)` / `plot(dn ? st : na)`) are merged into one series first.
 */
export function selectTrail(plots: WorkerPlot[] | undefined, bars: Bar[]): TrailSelection | null {
  if (!plots?.length || bars.length < 20) return null;
  const overlay = plots.filter(p => p.overlay && isLine(p));
  const cands: TrailSelection[] = [];
  for (const p of overlay) {
    const values = alignPlot(p, bars);
    const filled = values.filter(v => v !== null).length;
    if (filled < bars.length * 0.3) continue;
    cands.push({ title: p.title, values, flips: countFlips(values, bars), merged: false });
  }
  const ups = overlay.filter(p => UP_TITLE.test(p.title) && !DOWN_TITLE.test(p.title));
  const downs = overlay.filter(p => DOWN_TITLE.test(p.title) && !UP_TITLE.test(p.title));
  if (ups.length && downs.length) {
    const u = alignPlot(ups[0], bars), d = alignPlot(downs[0], bars);
    const overlap = u.filter((v, i) => v !== null && d[i] !== null).length;
    const values = u.map((v, i) => v ?? d[i]);
    const filled = values.filter(v => v !== null).length;
    if (filled >= bars.length * 0.3 && overlap < filled * 0.5) cands.push({ title: `${ups[0].title} / ${downs[0].title}`, values, flips: countFlips(values, bars), merged: true });
  }
  const usable = cands.filter(c => c.flips >= 1 && c.flips <= bars.length / 4);
  if (!usable.length) return null;
  const hinted = usable.filter(c => c.merged || TRAIL_TITLE.test(c.title));
  const pool = hinted.length ? hinted : usable;
  return pool.sort((a, b) => a.flips - b.flips)[0];
}

/** Trailing-stop / SuperTrend rule: entry when the close flips to the other side of the trail; the trail is the stop. */
export const trailingRule: Rule = (ctx) => {
  const sel = selectTrail(ctx.plots, ctx.bars);
  if (!sel) return [];
  const out: ScanEvent[] = [];
  let prev: Side | null = null;
  for (let i = 0; i < ctx.bars.length; i++) {
    const v = sel.values[i]; if (v === null) continue;
    const b = ctx.bars[i];
    const side: Side = b.close > v ? 'long' : b.close < v ? 'short' : prev ?? 'long';
    if (prev && side !== prev) {
      const sl = side === 'long' ? (v < b.close ? v : undefined) : (v > b.close ? v : undefined);
      out.push(mk(ctx, b.time, side, `Trail flip ${side === 'long' ? '▲' : '▼'} (${sel.title})`, `close ${b.close} crossed ${sel.title} ${v}`, { price: b.close, sl }));
    }
    prev = side;
  }
  return out;
};

const OSC_TITLE = /rsi|stoch|cci|macd|osc|moment|\bmom\b|hist|wave|signal|\broc\b|cmf|mfi|williams|%r|rvi|tsi|\bao\b|\bdmi\b|adx|trix|fisher|squeeze|value|main|\bline\b/i;
const OSC_EXCLUDE = /zero|level|band|overbought|oversold|\bob\b|\bos\b|upper|lower|mid|threshold|limit|\bfill\b/i;

export type OscMode = 'zero' | 'obos';
export interface OscSelection { title: string; values: Array<number | null>; mode: OscMode; ob: number; os: number; crosses: number }

/** Pick the pane oscillator and decide between zero-line and overbought/oversold crossings from its range. */
export function selectOscillator(plots: WorkerPlot[] | undefined, bars: Bar[]): OscSelection | null {
  if (!plots?.length || bars.length < 20) return null;
  const cands: OscSelection[] = [];
  for (const p of plots.filter(p => !p.overlay)) {
    if (OSC_EXCLUDE.test(p.title) && !OSC_TITLE.test(p.title)) continue;
    const values = alignPlot(p, bars);
    const nn = values.filter((v): v is number => v !== null);
    if (nn.length < bars.length * 0.3) continue;
    const min = Math.min(...nn), max = Math.max(...nn);
    if (!(max > min)) continue;
    let mode: OscMode, ob: number, os: number;
    if (min >= -0.5 && max <= 100.5 && max > 50) { mode = 'obos'; ob = 70; os = 30; }
    else if (min >= -100.5 && max <= 0.5 && min < -50) { mode = 'obos'; ob = -20; os = -80; }
    else if (min >= -0.01 && max <= 1.01 && max > 0.5) { mode = 'obos'; ob = 0.8; os = 0.2; }
    else if (min < 0 && max > 0) { mode = 'zero'; ob = 0; os = 0; }
    else continue;
    const crosses = mode === 'zero' ? countZero(values) : countObOs(values, ob, os);
    if (crosses < 1) continue;
    cands.push({ title: p.title, values, mode, ob, os, crosses });
  }
  if (!cands.length) return null;
  const hinted = cands.filter(c => OSC_TITLE.test(c.title));
  const pool = hinted.length ? hinted : cands;
  // prefer the series with the most activity that is still not noise (≤ one cross per 5 bars)
  return pool.filter(c => c.crosses <= bars.length / 5).sort((a, b) => b.crosses - a.crosses)[0] ?? pool.sort((a, b) => a.crosses - b.crosses)[0];
}

function countZero(values: Array<number | null>): number {
  let prev: number | null = null, n = 0;
  for (const v of values) { if (v === null) continue; if (prev !== null && ((prev <= 0 && v > 0) || (prev >= 0 && v < 0))) n++; prev = v; }
  return n;
}
function countObOs(values: Array<number | null>, ob: number, os: number): number {
  let prev: number | null = null, n = 0;
  for (const v of values) { if (v === null) continue; if (prev !== null && ((prev < os && v >= os) || (prev > ob && v <= ob))) n++; prev = v; }
  return n;
}

/** Oscillator rule: zero-line crosses, or leaving oversold (long) / overbought (short); stops/targets from ATR. */
export const oscillatorRule: Rule = (ctx) => {
  const sel = selectOscillator(ctx.plots, ctx.bars);
  if (!sel) return [];
  const out: ScanEvent[] = [];
  let prev: number | null = null;
  for (let i = 0; i < ctx.bars.length; i++) {
    const v = sel.values[i]; if (v === null) continue;
    const b = ctx.bars[i];
    if (prev !== null) {
      let side: Side | undefined;
      if (sel.mode === 'zero') side = prev <= 0 && v > 0 ? 'long' : prev >= 0 && v < 0 ? 'short' : undefined;
      else side = prev < sel.os && v >= sel.os ? 'long' : prev > sel.ob && v <= sel.ob ? 'short' : undefined;
      if (side) {
        const what = sel.mode === 'zero' ? `zero-line cross ${side === 'long' ? '▲' : '▼'}` : side === 'long' ? `left oversold (${sel.os})` : `left overbought (${sel.ob})`;
        out.push(mk(ctx, b.time, side, `Oscillator ${what} (${sel.title})`, `${sel.title} ${prev.toFixed(3)} → ${v.toFixed(3)}`, { price: b.close }));
      }
    }
    prev = v;
  }
  return out;
};

export const GENERIC_RULES: Record<GenericRule, Rule> = { trailing: trailingRule, oscillator: oscillatorRule };
