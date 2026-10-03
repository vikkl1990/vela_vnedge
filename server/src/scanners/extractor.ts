/**
 * Turns raw PineTS output (alert messages, plotshape hits) into normalised trading events.
 *
 * WillyAlgoTrader scripts emit structured `alert()` messages such as
 *   "🟢 LONG | DELTA:BTCUSD | TF: 15 | Price: 78777.5 | SL: 78402 | TP1: 79152.2 | TP2: 79527 | TP3: 79901 | R:R: 1 | Score: 77"
 *   "🛑 SL HIT | DELTA:BTCUSD | Long | Entry: 78777.5 | SL: 78402"
 *   "SATS DELTA:BTCUSD 15 | buy LONG @ 77360.5 (Price band break)"
 * This module parses them without any per-script code.
 */
import type { WorkerAlert, WorkerShape } from '../pine/worker.ts';

export type Side = 'long' | 'short';
export type EventKind = 'entry' | 'exit' | 'info';
export type ExitType = 'tp1' | 'tp2' | 'tp3' | 'sl' | 'be' | 'flip' | 'close';

export interface ScanEvent {
  kind: EventKind;
  /** Plain-English description for the UI (derived, see describeEvent). */
  summary?: string;
  side?: Side;
  /** For exits: which leg was hit. */
  exitType?: ExitType;
  price?: number;
  sl?: number;
  tp: number[];
  score?: number;
  label: string;
  message: string;
  source: 'alert' | 'shape' | 'derived' | 'alertcondition';
  barTime: number;
  barIndex: number;
}

const NUM = String.raw`(-?\d+(?:[.,]\d+)?)`;

function num(re: RegExp, s: string): number | undefined {
  const m = s.match(re);
  if (!m) return undefined;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) ? v : undefined;
}

const LONG_WORDS = /\b(LONG|BUY|BULL(?:ISH)?(?:\s+(?:BREAKOUT|ABCD|SWEEP|ENTRY))?|BREAK\s*UP|SWEEP\s*BUY|RETEST\s*LONG|SWING\s*BULLISH)\b/i;
const SHORT_WORDS = /\b(SHORT|SELL|BEAR(?:ISH)?(?:\s+(?:BREAKOUT|ABCD|SWEEP|ENTRY))?|BREAK\s*DOWN|SWEEP\s*SELL|RETEST\s*SHORT|SWING\s*BEARISH)\b/i;
const EXIT_RE = /\b(TP\s?\d?[ _]?HIT|SL[ _]?HIT|BE[ _]?STOP(?:-OUT)?|BE[ _]?EXIT|BREAK-?EVEN|REVERSAL|FLIP[ _]?EXIT|TRADE[ _]?CLOSED|SL[ _]HIT|TP\d[ _]HIT|TRADE CLOSED|STOP(?:PED)? OUT|STOP HIT|TARGET REACHED|CLOSED)\b/i;
const INFO_ONLY = /\b(PATTERN DETECTED|ENTRY ZONE|SQUEEZE STARTED|RANGE LOCKED|VOLUME INFLOW|VOLUME OUTFLOW|FATIGUE|DIVERGENCE|ZERO (?:BULL|BEAR) CROSS|NAKED POC|VA BREAKOUT|80% RULE|CYCLE TURN|CHoCH|BOS\b|FVG|OTE Zone|Retest \||hypothesis|dismissed|EXIT OVERBOUGHT|EXIT OVERSOLD|Bull Cross|Bear Cross)\b/i;

/**
 * `{"schema":"sats.events.v2","events":[{"event":"buy","side":"long","fill_price":…,"sl":…,"tp1":…,"tp2":…,"tp3":…},…]}`
 * One alert can carry several events for the bar (a stop and a new entry); the first entry wins,
 * exits are all kept. Returns null when nothing in it is actionable.
 */
function parseSatsPacket(msg: string, base: Pick<ScanEvent, 'message' | 'source' | 'barTime' | 'barIndex' | 'tp' | 'label'>): ScanEvent | null {
  let pkt: any;
  try { pkt = JSON.parse(msg); } catch { return null; }
  const events: any[] = Array.isArray(pkt?.events) ? pkt.events : [];
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  for (const e of events) {
    const side: Side | undefined = e.side === 'long' ? 'long' : e.side === 'short' ? 'short' : undefined;
    if (e.event === 'buy' || e.event === 'sell') {
      const tp = [n(e.tp1), n(e.tp2), n(e.tp3)].filter((v): v is number => v !== undefined);
      return { ...base, kind: 'entry', side: side ?? (e.event === 'buy' ? 'long' : 'short'), price: n(e.fill_price) ?? n(e.close_price), sl: n(e.sl), tp, label: `${(side ?? (e.event === 'buy' ? 'long' : 'short')).toUpperCase()} (SATS)`, message: `SATS ${e.event} ${e.reason ?? ''}`.trim().slice(0, 500) };
    }
  }
  for (const e of events) {
    const m = String(e.event ?? '').match(/^(tp[123])_hit$|^(sl)_hit$|^(flip)_exit$|^(timeout)_exit$|^trade_(closed)$/);
    if (!m) continue;
    const exitType: ExitType = (m[1] as ExitType) ?? (m[2] === 'sl' ? 'sl' : m[3] === 'flip' ? 'flip' : 'close');
    const side: Side | undefined = e.side === 'long' ? 'long' : e.side === 'short' ? 'short' : undefined;
    return { ...base, kind: 'exit', side, exitType, price: n(e.fill_price), label: `${exitType.toUpperCase()} (SATS)`, message: `SATS ${e.event} ${e.reason ?? ''}`.trim().slice(0, 500) };
  }
  return null;
}

/**
 * Fibonacci Structure Engine 2.1 (WillyAlgoTrader) structured alert: `{"schema_version":2,…,"events":[{type, direction,
 * entry, stop, target, trigger, state}, …]}`. `buy`/`sell` open a plan (stop and target from the script); `target`
 * and `invalidated` close it; `expired` closes it flat; `replaced` and anything else are information.
 */
function parseFsePacket(msg: string, base: Pick<ScanEvent, 'message' | 'source' | 'barTime' | 'barIndex' | 'tp' | 'label'>): ScanEvent | null {
  let pkt: any;
  try { pkt = JSON.parse(msg); } catch { return null; }
  const events: any[] = Array.isArray(pkt?.events) ? pkt.events : [];
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const sideOf = (e: any): Side | undefined => (e.direction === 1 ? 'long' : e.direction === -1 ? 'short' : undefined);
  for (const e of events) {
    if (e.type === 'buy' || e.type === 'sell') {
      const side = sideOf(e) ?? (e.type === 'buy' ? 'long' : 'short');
      const tp = [n(e.target)].filter((v): v is number => v !== undefined);
      return { ...base, kind: 'entry', side, price: n(e.entry) ?? n(e.level), sl: n(e.stop) ?? n(e.invalidation), tp, label: `${side.toUpperCase()} ${String(e.trigger ?? 'FSE')}`.slice(0, 60), message: `FSE ${e.type} ${e.trigger ?? ''} E ${e.entry ?? ''} SL ${e.stop ?? ''} TP ${e.target ?? ''}`.trim().slice(0, 500) };
    }
  }
  for (const e of events) {
    const exitType: ExitType | null = e.type === 'target' ? 'tp1' : e.type === 'invalidated' ? 'sl' : e.type === 'expired' ? 'close' : null;
    if (!exitType) continue;
    return { ...base, kind: 'exit', side: sideOf(e), exitType, price: n(e.level), label: `${exitType.toUpperCase()} (FSE)`, message: `FSE ${e.type} ${e.trigger ?? ''}`.trim().slice(0, 500) };
  }
  return null;
}

/** Leading direction cue: 🟢 = long, 🔴 = short. */
function emojiSide(msg: string): Side | undefined {
  const head = msg.slice(0, 6);
  if (head.includes('🟢')) return 'long';
  if (head.includes('🔴')) return 'short';
  return undefined;
}

export function parseAlert(a: WorkerAlert): ScanEvent | null {
  const msg = a.message.replace(/\s+/g, ' ').trim();
  if (!msg) return null;
  const head = msg.split('|')[0].trim();
  const upper = msg.toUpperCase();
  const base: ScanEvent = { kind: 'info', tp: [], label: head.slice(0, 60), message: msg.slice(0, 500), source: 'alert', barTime: a.time, barIndex: a.barIndex };

  // ----- Self-Aware Trend System webhook packet: every event with the trade's own entry, stop and targets -----
  if (msg.startsWith('{') && msg.includes('"schema":"sats.events.v2"')) return parseSatsPacket(msg, base);
  if (msg.startsWith('{') && msg.includes('"schema_version":2') && msg.includes('"events":[')) return parseFsePacket(msg, base);
  // ----- JSON webhook payloads (STRAT Trap & VWAP Engine: {"ind":"STRAT","action":"trigger_bull",...}) -----
  if (msg.startsWith('{') && msg.endsWith('}')) {
    let j: any = null;
    try { j = JSON.parse(msg); } catch { j = null; }
    if (j && typeof j === 'object') {
      const action = String(j.action ?? '').toLowerCase();
      const dir: Side | undefined = /bull|long/.test(action) || j.dir === 'long' ? 'long' : /bear|short/.test(action) || j.dir === 'short' ? 'short' : undefined;
      const n = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const tpj = [n(j.tp1), n(j.tp2), n(j.tp3)].filter((v): v is number => v !== undefined);
      const label = `${String(j.ind ?? 'JSON')} ${action}`.slice(0, 60);
      // the script only attaches entry/sl when it actually opened a trade; bare triggers are informational
      if (/^(trigger|trap|entry)_/.test(action) && dir && n(j.entry) !== undefined && n(j.sl) !== undefined) {
        return { ...base, kind: 'entry', side: dir, price: n(j.entry) ?? n(j.price), sl: n(j.sl) ?? n(j.stop), tp: tpj, score: n(j.regime) ?? n(j.score), label };
      }
      const exitMap: Record<string, ExitType> = { tp1_hit: 'tp1', tp2_hit: 'tp2', tp3_hit: 'tp3', tp3_close: 'tp3', sl_hit: 'sl', be: 'be', be_stop: 'be', close: 'close', exit: 'close', flip: 'flip' };
      if (action in exitMap) return { ...base, kind: 'exit', exitType: exitMap[action], side: dir, price: n(j.level) ?? n(j.price) ?? n(j.sl), label };
      return { ...base, kind: 'info', side: dir, price: n(j.price), label };
    }
  }

  // ----- strategy() orders, as the worker reports them from the runtime's trade ledger -----
  const st = msg.match(new RegExp(String.raw`^STRATEGY (entry|exit) (long|short) @ ${NUM}`));
  if (st) {
    const side = st[2] as Side; const price = Number(st[3]);
    return st[1] === 'entry'
      ? { ...base, kind: 'entry', side, price, label: `${side.toUpperCase()} (strategy)` }
      : { ...base, kind: 'exit', side, exitType: 'close', price, label: `EXIT ${side.toUpperCase()} (strategy)` };
  }

  // ----- Self-Aware Trend System (SATS) machine format -----
  if (/^SATS\b/.test(msg)) {
    const parts = msg.split('|').map(s => s.trim());
    let ev: ScanEvent | null = null;
    for (const part of parts.slice(1)) {
      const m = part.match(new RegExp(String.raw`^(buy|sell|tp\d_hit|sl_hit|flip_exit|trade_closed)\s+(LONG|SHORT)\s+@\s+${NUM}`, 'i'));
      if (!m) continue;
      const verb = m[1].toLowerCase(); const side = m[2].toLowerCase() as Side; const price = Number(m[3]);
      if (verb === 'buy' || verb === 'sell') { ev = { ...base, kind: 'entry', side, price, label: `${side.toUpperCase()} (SATS)` }; }
      else if (!ev) {
        const exitType: ExitType = verb.startsWith('tp') ? (verb.slice(0, 3) as ExitType) : verb === 'sl_hit' ? 'sl' : verb === 'flip_exit' ? 'flip' : 'close';
        ev = { ...base, kind: 'exit', side, exitType, price, label: `${verb.toUpperCase()} ${side.toUpperCase()}` };
      }
    }
    return ev ?? { ...base, kind: 'info' };
  }

  const price = num(new RegExp(String.raw`(?:Price|Entry|Level|@)\s*:?\s*\$?\s*${NUM}`, 'i'), msg) ?? num(new RegExp(String.raw`\|\s*\$${NUM}`), msg);
  const sl = num(new RegExp(String.raw`\b(?:SL|Stop)\s*:?\s*\$?\s*${NUM}`, 'i'), msg);
  const tp: number[] = [];
  for (let i = 1; i <= 4; i++) { const v = num(new RegExp(String.raw`\bTP${i}\s*:?\s*\$?\s*${NUM}`, 'i'), msg); if (v !== undefined) tp[i - 1] = v; }
  const tpSingle = num(new RegExp(String.raw`\b(?:TP|Target)\s*:\s*\$?\s*${NUM}`, 'i'), msg);
  if (tp.length === 0 && tpSingle !== undefined) tp.push(tpSingle);
  const score = num(new RegExp(String.raw`\b(?:Score|Conf|Strength|ML|Quality)\s*:?\s*${NUM}`, 'i'), msg);
  const cleanTp = tp.filter((v): v is number => typeof v === 'number');

  // ----- exits -----
  if (EXIT_RE.test(upper) && !/BREAKOUT/.test(upper)) {
    let exitType: ExitType = 'close';
    const tpHit = upper.match(/TP\s?(\d)[ _]?HIT/);
    if (tpHit) exitType = (`tp${tpHit[1]}` as ExitType);
    else if (/SL[ _]?HIT|STOP(?:PED)? OUT|STOP HIT/.test(upper) && !/\bBE\b/.test(upper)) exitType = 'sl';
    else if (/TARGET REACHED/.test(upper)) exitType = 'tp1';
    else if (/BE[ _]?STOP|BE[ _]?EXIT/.test(upper)) exitType = 'be';
    else if (/REVERSAL|FLIP/.test(upper)) exitType = 'flip';
    else if (/BREAK-?EVEN/.test(upper)) {
      // "SL moved to entry" — informational for us (engine handles BE itself)
      return { ...base, kind: 'info', label: 'BREAK-EVEN', sl: sl ?? num(new RegExp(String.raw`moved to(?: entry)?:?\s*${NUM}`, 'i'), msg) };
    }
    const side: Side | undefined = /\bLONG\b/i.test(msg) ? 'long' : /\bSHORT\b/i.test(msg) ? 'short' : undefined;
    // "REVERSAL → LONG" means the previous (short) trade was closed
    const revSide: Side | undefined = exitType === 'flip' && side ? (side === 'long' ? 'short' : 'long') : side;
    const tpIdx = tpHit ? Number(tpHit[1]) - 1 : -1;
    // Entry is context in exit messages, never an execution price. Prefer the hit level.
    const quotedExit = num(new RegExp(String.raw`(?:Price|Level|@)\s*:?\s*\$?\s*${NUM}`, 'i'), msg) ?? num(new RegExp(String.raw`\|\s*\$${NUM}`), msg);
    const hitLevel = exitType === 'sl' || exitType === 'be' ? sl : tpIdx >= 0 ? tp[tpIdx] : exitType === 'tp1' ? tpSingle : undefined;
    const exitPrice = hitLevel ?? quotedExit;
    return { ...base, kind: 'exit', exitType, side: revSide, price: exitPrice, sl, tp: cleanTp, score };
  }

  // ----- entries -----
  const eSide = emojiSide(msg);
  const wordLong = LONG_WORDS.test(head) || /\bBUY\b|\bLONG\b/i.test(head);
  const wordShort = SHORT_WORDS.test(head) || /\bSELL\b|\bSHORT\b/i.test(head);
  let side: Side | undefined;
  if (wordLong && !wordShort) side = 'long';
  else if (wordShort && !wordLong) side = 'short';
  else if (eSide && /\bENTRY\b/i.test(head)) side = eSide; // e.g. "🟢 OTE Entry"
  else if (eSide === 'long' && /▲/.test(head)) side = 'long';    // e.g. "🟢 DIST ▲ UP (manip LOW)" — arrow-marked calls only
  else if (eSide === 'short' && /▼/.test(head)) side = 'short';
  if (side && !INFO_ONLY.test(head)) {
    return { ...base, kind: 'entry', side, price, sl, tp: cleanTp, score };
  }
  return { ...base, kind: 'info', side: eSide, price, sl, tp: cleanTp, score };
}

/**
 * An `alertcondition()` whose title says a stop was hit or a side was closed is an exit for that side:
 * "Long Stop Hit", "Short Stop-Out", "Exit Long", "Close Short". Never an entry.
 */
export function conditionExit(title: string): { side: Side; exitType: ExitType } | undefined {
  const t = title.trim();
  const long = /\blong\b|\bbuy\b/i.test(t), short = /\bshort\b|\bsell\b/i.test(t);
  if (long === short) return undefined;
  const side: Side = long ? 'long' : 'short';
  if (/\bstop(?:[- ]?loss)?[\s-]*(?:hit|out|triggered|reached)\b|\bstopped[\s-]*out\b/i.test(t)) return { side, exitType: 'sl' };
  if (/^(?:exit|close)\s+(?:long|short|buy|sell)\b|\b(?:long|short)\s+(?:exit|close|closed)\b/i.test(t)) return { side, exitType: 'close' };
  return undefined;
}

/** Plotshape titles that clearly denote an entry. */
export function shapeSide(title: string): Side | undefined {
  const t = title.trim();
  if (/^(buy|long|bull(ish)?( abcd| sweep)?|swing bullish|bull cross)( signal)?$/i.test(t)) return 'long';
  if (/^(sell|short|bear(ish)?( abcd| sweep)?|swing bearish|bear cross)( signal)?$/i.test(t)) return 'short';
  return directionalTitle(t);
}

/**
 * Direction of a free-form title such as "Bullish Internal OB Breakout", "Upward Breakout",
 * "Upper Break", "Lower Break", "Bearish CHoCH". Undefined when ambiguous or neutral.
 */
export function directionalTitle(title: string): Side | undefined {
  const t = title.trim();
  if (!t || /\b(exit|close|stop|target|tp\d?|take profit|equal|divergence|alert|any|bias|regime|interval|sampling|noise)\b/i.test(t)) return undefined;
  const up = /\b(bull(ish)?|upward|upper|up|long|buy|higher|rising|crossover|cross up|breakout up|break up|support)\b/i.test(t);
  const dn = /\b(bear(ish)?|downward|lower|down|short|sell|falling|crossunder|cross down|breakout down|break down|resistance)\b/i.test(t);
  if (up && !dn) return 'long';
  if (dn && !up) return 'short';
  return undefined;
}

export interface ExtractOptions {
  /** Only events on/after this bar time are returned (live: last closed bar). */
  sinceBarTime?: number;
  /** Extra events produced by per-scanner rules (see rules.ts); merged with alert/shape events. */
  derived?: ScanEvent[];
  /** Which channels may produce entries (unset: all). Exits and info from `alert()` always pass. */
  sources?: Array<'alert' | 'alertcondition' | 'shape' | 'derived'>;
  /**
   * Rising edge only: an `alertcondition()` or shape that is true on every bar of a state ("bullish")
   * becomes one entry on the first bar of the run, not one per bar (decision 57).
   */
  edge?: boolean;
  /**
   * Only entries whose label starts with one of these (case-insensitive) may open a trade (decision 67):
   * the scanner test showed one channel of a script paying while its siblings lose. Exits and info
   * always pass. Unset or empty: every label.
   */
  labels?: string[];
  /** Read every entry the other way (decision 67): for scripts whose signal names describe the move that just happened — a rejection at the upper band, an exhaustion — rather than the trade to take. */
  invert?: boolean;
  /** Filled with a count per reason for every output that did not become an event (the funnel, decision 77). */
  drops?: Record<string, number>;
}

/** Merge alert-derived and shape-derived events per bar; alerts win over shapes on the same bar/side. */
export function extractEvents(alerts: WorkerAlert[], shapes: WorkerShape[], opts: ExtractOptions = {}): ScanEvent[] {
  const allow = (src: 'alert' | 'alertcondition' | 'shape' | 'derived') => !opts.sources || opts.sources.includes(src);
  const events: ScanEvent[] = [];
  const seenEntry = new Set<string>();
  const alertBars = new Set<number>();
  // the allow-list is applied as entries are read, before same-bar deduplication: a generic label
  // ("Bullish BOS") must never consume the specific one the operator asked for ("MSS Sweeps:") on the same bar
  const allowLabels = (opts.labels ?? []).map(l => l.trim().toLowerCase()).filter(Boolean);
  const labelOk = (label: string | undefined) => !allowLabels.length || allowLabels.some(a => String(label ?? '').toLowerCase().startsWith(a));
  const drop = (why: string) => { if (opts.drops) opts.drops[why] = (opts.drops[why] ?? 0) + 1; };
  for (const a of alerts) {
    if (opts.sinceBarTime !== undefined && a.time < opts.sinceBarTime) continue;
    if (a.type === 'alertcondition') continue; // handled below, at lower priority than alert()
    const ev = parseAlert(a);
    if (!ev) continue;
    if (ev.kind === 'entry' && !allow('alert')) { drop('alert(): channel excluded'); continue; }
    if (ev.kind === 'entry' && !labelOk(ev.label)) { drop('alert(): label not in allow-list'); continue; }
    // an alert() entry that is actually kept owns its bar (its alertcondition twin would be a duplicate);
    // an informational, excluded or filtered alert() does not silence an independent condition on the same bar
    if (a.type === 'alert' && ev.kind === 'entry') alertBars.add(a.time);
    const key = `${ev.kind}:${ev.side ?? ''}:${ev.barTime}:${ev.exitType ?? ''}`;
    if (ev.kind !== 'info' && seenEntry.has(key)) { drop('alert(): same-bar duplicate'); continue; }
    seenEntry.add(key);
    events.push(ev);
  }
  // alertcondition() titles (LuxAlgo style: "Bullish Internal OB Breakout", "Upward Breakout") — only when no alert() fired that bar
  const lastCondBar = new Map<string, number>();
  for (const a of alerts) {
    if (!allow('alertcondition')) { drop('condition: channel excluded'); break; }
    if (a.type !== 'alertcondition') continue;
    if (alertBars.has(a.time)) { drop('condition: an alert() entry owned the bar'); continue; }
    // PineTS can hand back a non-string title (e.g. a Series or number) — coerce before parsing
    const title = String(a.title ?? a.message ?? '').trim();
    const exit = conditionExit(title);
    if (exit) {
      if (opts.sinceBarTime !== undefined && a.time < opts.sinceBarTime) continue;
      const key = `exit:${exit.side}:${a.time}:${exit.exitType}`;
      if (seenEntry.has(key)) continue;
      seenEntry.add(key);
      events.push({ kind: 'exit', side: exit.side, exitType: exit.exitType, tp: [], label: title.slice(0, 60), message: `alertcondition "${title}"`.slice(0, 500), source: 'alertcondition', barTime: a.time, barIndex: a.barIndex });
      continue;
    }
    const side = directionalTitle(title);
    if (!side) { drop('condition: no direction in title'); continue; }
    // the same word means the same thing on every channel: a BOS or CHoCH condition is context, like a BOS alert() —
    // unless the operator's allow-list names it, which is the explicit opt-in
    if (INFO_ONLY.test(title) && !(allowLabels.length && labelOk(title))) { drop('condition: context title (BOS, CHoCH, divergence…)'); continue; }
    if (!labelOk(title)) { drop('condition: label not in allow-list'); continue; }
    if (opts.edge) {
      // consecutive bars of the same condition are one signal: keep the first bar of the run
      const k = `${title}|${side}`, prev = lastCondBar.get(k);
      lastCondBar.set(k, a.barIndex);
      if (prev !== undefined && a.barIndex - prev <= 1) { drop('condition: same state as the previous bar'); continue; }
    }
    if (opts.sinceBarTime !== undefined && a.time < opts.sinceBarTime) continue;
    const key = `entry:${side}:${a.time}:`;
    if (seenEntry.has(key)) { drop('condition: same-bar duplicate'); continue; }
    seenEntry.add(key);
    events.push({ kind: 'entry', side, tp: [], label: title.slice(0, 60), message: `alertcondition "${title}"${a.message && a.message !== title ? `: ${a.message}` : ''}`.slice(0, 500), source: 'alertcondition', barTime: a.time, barIndex: a.barIndex });
  }
  for (const d of opts.derived ?? []) {
    if (!allow('derived')) break;
    if (opts.sinceBarTime !== undefined && d.barTime < opts.sinceBarTime) continue;
    if (d.kind === 'entry' && !labelOk(d.label)) { drop('rule: label not in allow-list'); continue; }
    const key = `${d.kind}:${d.side ?? ''}:${d.barTime}:`;
    if (seenEntry.has(key)) { drop('rule: same-bar duplicate'); continue; }
    seenEntry.add(key);
    events.push(d);
  }
  for (const s of shapes) {
    if (!allow('shape')) break;
    const side = shapeSide(s.title);
    if (!side) { drop('shape: no direction in title'); continue; }
    // a shape drawn on every bar of a state is one signal per run: the bar spacing is the smallest
    // gap between its own prints, and a print one spacing after the previous one continues the run
    const times = [...s.times].sort((a, b) => a - b);
    let step = Infinity;
    for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > 0 && g < step) step = g; }
    let prevT = -Infinity;
    for (const t of times) {
      const continues = opts.edge && Number.isFinite(step) && t - prevT <= step * 1.5;
      prevT = t;
      if (continues) { drop('shape: continuing state'); continue; }
      if (opts.sinceBarTime !== undefined && t < opts.sinceBarTime) continue;
      if (!labelOk(s.title)) { drop('shape: label not in allow-list'); continue; }
      const key = `entry:${side}:${t}:`;
      if (seenEntry.has(key)) { drop('shape: same-bar duplicate'); continue; }
      seenEntry.add(key);
      events.push({ kind: 'entry', side, tp: [], label: s.title, message: `plotshape ${s.title}`, source: 'shape', barTime: t, barIndex: -1 });
    }
  }
  const kept = events;
  const read = opts.invert ? kept.map(e => (e.kind === 'entry' && e.side ? { ...e, side: e.side === 'long' ? 'short' as const : 'long' as const, sl: undefined, tp: [], label: `${e.label ?? ''} (inverted)`.trim() } : e)) : kept;
  read.sort((a, b) => a.barTime - b.barTime || (a.kind === 'exit' ? -1 : 1));
  return read;
}

const fmtN = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(v.toFixed(4))));

/** Turn a raw script message into a sentence a trader can read at a glance. */
export function describeEvent(ev: ScanEvent): string {
  const side = ev.side ? ev.side.toUpperCase() : '';
  const price = fmtN(ev.price);
  const parts: string[] = [];
  if (ev.kind === 'entry') {
    parts.push(`${side} entry${price ? ` at ${price}` : ''}`);
    if (ev.sl !== undefined) parts.push(`stop ${fmtN(ev.sl)}`);
    if (ev.tp.length) parts.push(`targets ${ev.tp.map(fmtN).join(' / ')}`);
    if (ev.score !== undefined) parts.push(`score ${fmtN(ev.score)}`);
    if (ev.source === 'shape') parts.push(`(${ev.label} marker drawn by the script; stop/targets from ATR)`);
    else if (ev.source === 'alertcondition') parts.push(`(script condition "${ev.label}"; stop/targets from ATR)`);
    else if (ev.source === 'derived') parts.push(`(derived from ${ev.label}${ev.sl === undefined ? '; stop from ATR' : ''})`);
    else if (ev.sl === undefined) parts.push('(no stop published; ATR fallback)');
    return parts.join(' · ');
  }
  if (ev.kind === 'exit') {
    const what: Record<string, string> = { tp1: 'Take-profit 1 hit', tp2: 'Take-profit 2 hit', tp3: 'Take-profit 3 hit', sl: 'Stop-loss hit', be: 'Stopped out at break-even', flip: 'Trend flipped — trade closed', close: 'Trade closed by script' };
    parts.push(`${what[ev.exitType ?? 'close']}${side ? ` on ${side}` : ''}${price ? ` at ${price}` : ''}`);
    return parts.join(' · ');
  }
  // info: JSON payloads
  const m = ev.message.trim();
  if (m.startsWith('{')) {
    try {
      const j: any = JSON.parse(m);
      const action = String(j.action ?? '').replace(/_/g, ' ');
      const bits = [`${String(j.ind ?? 'Script')}: ${action}`];
      if (j.pattern) bits.push(`pattern ${j.pattern}`);
      if (j.price !== undefined) bits.push(`price ${fmtN(Number(j.price))}`);
      if (j.trig !== undefined) bits.push(`trigger ${fmtN(Number(j.trig))}`);
      if (j.stop !== undefined) bits.push(`stop ${fmtN(Number(j.stop))}`);
      if (j.level !== undefined) bits.push(`level ${fmtN(Number(j.level))}`);
      if (j.ftc) bits.push(`HTF continuity ${j.ftc}`);
      return bits.join(' · ');
    } catch { /* fall through */ }
  }
  // info: strip the "DELTA:SYMBOL | TF: 15" boilerplate the scripts add for webhooks
  const cleaned = m.split('|').map(x => x.trim()).filter(x => x && !/^DELTA:/i.test(x) && !/^TF:\s*\S+$/i.test(x) && !/^ID:\s*\d+$/i.test(x));
  const head = cleaned.shift() ?? ev.label;
  const rest = cleaned.map(x => x.replace(/^Price:\s*/i, 'price ').replace(/^Score:\s*/i, 'score ').replace(/^Level:\s*/i, 'level ').replace(/^Entry:\s*/i, 'entry '));
  return [head.replace(/^[^\w(]+/, '').trim(), ...rest].join(' · ');
}
