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
  side?: Side;
  /** For exits: which leg was hit. */
  exitType?: ExitType;
  price?: number;
  sl?: number;
  tp: number[];
  score?: number;
  label: string;
  message: string;
  source: 'alert' | 'shape';
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
const EXIT_RE = /\b(TP\s?\d?[ _]?HIT|SL[ _]?HIT|BE[ _]?STOP(?:-OUT)?|BE[ _]?EXIT|BREAK-?EVEN|REVERSAL|FLIP[ _]?EXIT|TRADE[ _]?CLOSED|SL[ _]HIT|TP\d[ _]HIT|TRADE CLOSED|STOP(?:PED)? OUT|CLOSED)\b/i;
const INFO_ONLY = /\b(PATTERN DETECTED|ENTRY ZONE|SQUEEZE STARTED|RANGE LOCKED|VOLUME INFLOW|VOLUME OUTFLOW|FATIGUE|DIVERGENCE|ZERO (?:BULL|BEAR) CROSS|NAKED POC|VA BREAKOUT|80% RULE|CYCLE TURN|CHoCH|BOS\b|FVG|OTE Zone|Retest \||hypothesis|dismissed|EXIT OVERBOUGHT|EXIT OVERSOLD|Bull Cross|Bear Cross)\b/i;

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
  const sl = num(new RegExp(String.raw`\bSL\s*:?\s*\$?\s*${NUM}`, 'i'), msg);
  const tp: number[] = [];
  for (let i = 1; i <= 4; i++) { const v = num(new RegExp(String.raw`\bTP${i}\s*:?\s*\$?\s*${NUM}`, 'i'), msg); if (v !== undefined) tp[i - 1] = v; }
  const tpSingle = num(new RegExp(String.raw`\bTP\s*:\s*\$?\s*${NUM}`, 'i'), msg);
  if (tp.length === 0 && tpSingle !== undefined) tp.push(tpSingle);
  const score = num(new RegExp(String.raw`\b(?:Score|Conf|Strength|ML|Quality)\s*:?\s*${NUM}`, 'i'), msg);
  const cleanTp = tp.filter((v): v is number => typeof v === 'number');

  // ----- exits -----
  if (EXIT_RE.test(upper) && !/BREAKOUT/.test(upper)) {
    let exitType: ExitType = 'close';
    const tpHit = upper.match(/TP\s?(\d)[ _]?HIT/);
    if (tpHit) exitType = (`tp${tpHit[1]}` as ExitType);
    else if (/SL[ _]?HIT|STOP(?:PED)? OUT/.test(upper) && !/\bBE\b/.test(upper)) exitType = 'sl';
    else if (/BE[ _]?STOP|BE[ _]?EXIT/.test(upper)) exitType = 'be';
    else if (/REVERSAL|FLIP/.test(upper)) exitType = 'flip';
    else if (/BREAK-?EVEN/.test(upper)) {
      // "SL moved to entry" — informational for us (engine handles BE itself)
      return { ...base, kind: 'info', label: 'BREAK-EVEN', sl: sl ?? num(new RegExp(String.raw`moved to(?: entry)?:?\s*${NUM}`, 'i'), msg) };
    }
    const side: Side | undefined = /\bLONG\b/i.test(msg) ? 'long' : /\bSHORT\b/i.test(msg) ? 'short' : undefined;
    // "REVERSAL → LONG" means the previous (short) trade was closed
    const revSide: Side | undefined = exitType === 'flip' && side ? (side === 'long' ? 'short' : 'long') : side;
    return { ...base, kind: 'exit', exitType, side: revSide, price, sl, tp: cleanTp, score };
  }

  // ----- entries -----
  const eSide = emojiSide(msg);
  const wordLong = LONG_WORDS.test(head) || /\bBUY\b|\bLONG\b/i.test(head);
  const wordShort = SHORT_WORDS.test(head) || /\bSELL\b|\bSHORT\b/i.test(head);
  let side: Side | undefined;
  if (wordLong && !wordShort) side = 'long';
  else if (wordShort && !wordLong) side = 'short';
  else if (eSide && /\bENTRY\b/i.test(head)) side = eSide; // e.g. "🟢 OTE Entry"
  if (side && !INFO_ONLY.test(head)) {
    return { ...base, kind: 'entry', side, price, sl, tp: cleanTp, score };
  }
  return { ...base, kind: 'info', side: eSide, price, sl, tp: cleanTp, score };
}

/** Plotshape titles that clearly denote an entry. */
export function shapeSide(title: string): Side | undefined {
  const t = title.trim();
  if (/^(buy|long|bull(ish)?( abcd| sweep)?|swing bullish|bull cross)( signal)?$/i.test(t)) return 'long';
  if (/^(sell|short|bear(ish)?( abcd| sweep)?|swing bearish|bear cross)( signal)?$/i.test(t)) return 'short';
  return undefined;
}

export interface ExtractOptions {
  /** Only events on/after this bar time are returned (live: last closed bar). */
  sinceBarTime?: number;
}

/** Merge alert-derived and shape-derived events per bar; alerts win over shapes on the same bar/side. */
export function extractEvents(alerts: WorkerAlert[], shapes: WorkerShape[], opts: ExtractOptions = {}): ScanEvent[] {
  const events: ScanEvent[] = [];
  const seenEntry = new Set<string>();
  for (const a of alerts) {
    if (opts.sinceBarTime !== undefined && a.time < opts.sinceBarTime) continue;
    if (a.type === 'alertcondition') continue; // alertcondition() carries no prices; the paired alert() does
    const ev = parseAlert(a);
    if (!ev) continue;
    const key = `${ev.kind}:${ev.side ?? ''}:${ev.barTime}:${ev.exitType ?? ''}`;
    if (ev.kind !== 'info' && seenEntry.has(key)) continue;
    seenEntry.add(key);
    events.push(ev);
  }
  for (const s of shapes) {
    const side = shapeSide(s.title);
    if (!side) continue;
    for (const t of s.times) {
      if (opts.sinceBarTime !== undefined && t < opts.sinceBarTime) continue;
      const key = `entry:${side}:${t}:`;
      if (seenEntry.has(key)) continue;
      seenEntry.add(key);
      events.push({ kind: 'entry', side, tp: [], label: s.title, message: `plotshape ${s.title}`, source: 'shape', barTime: t, barIndex: -1 });
    }
  }
  events.sort((a, b) => a.barTime - b.barTime || (a.kind === 'exit' ? -1 : 1));
  return events;
}
