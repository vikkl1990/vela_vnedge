/**
 * Static audit of one Pine source against the way the bot is told to read it.
 *
 * The reader (extractor.ts) decides at run time which of a script's markers become entries and on which side. This
 * module applies the same rules to the source text, so every script can be checked without running it, and compares
 * the result with what the script itself declares: how each marker is drawn, whether it has a mirror on the other
 * side, whether the script computes a stop or targets the bot never sees, and when a signal can be known.
 *
 * Every finding is a proposal for a person to confirm, not a change. A static read cannot tell a good entry from a
 * bad one, and it cannot follow a title built from a variable; those markers are reported as unread.
 */
import { conditionExit, directionalTitle, geometrySide, INFO_ONLY, shapeSide, type Side } from './extractor.ts';
import { argumentsOf, mask } from './sourceFacts.ts';

export interface Reading {
  sources?: string[]; labels?: string[]; sides?: Record<string, 'long' | 'short' | 'none'>;
  entryProtection?: string; inputs?: Record<string, unknown>;
  /** Decision 164: an older record that the geometry and extended-title rules are withheld from. */
  legacy?: boolean;
}
export interface AuditOptions { /** `paper.skipScriptStops`: the account takes only its own ATR stop. */ skipScriptStops?: boolean }

export interface Marker {
  channel: 'shape' | 'alertcondition'; line: number; title: string;
  /** False when the title is an expression: the static read cannot follow it. */
  literal: boolean; condition: string; style?: string; location?: string;
  /** The side the script draws: an up-pointing shape or one under the bar is a long. */
  drawn?: Side;
  /** What the bot's reader makes of it: a side (an entry), an exit, switched off by the contract, or not read. */
  reads: Side | 'exit' | 'none' | 'unread'; why?: string;
}
export type CorrectionCode = 'side-against-drawing' | 'side-dropped' | 'not-an-entry' | 'levels-not-exported' | 'levels-plotted-unread'
  | 'own-stop-discarded' | 'alerts-off-by-default' | 'late-pivot' | 'lookahead' | 'no-entry-read';
export interface Correction {
  code: CorrectionCode;
  /** `high`: the reading contradicts the source. `medium`: logic in the source is unused. `review`: needs a person. */
  severity: 'high' | 'medium' | 'review';
  line?: number; marker?: string; finding: string; proposal: string;
  /** The reading change that would apply the proposal, where one exists. */
  patch?: Partial<Pick<Reading, 'sides' | 'labels' | 'entryProtection' | 'inputs'>>;
}
export interface ScriptAudit {
  lines: number; strategy: boolean; alertCalls: number; markers: Marker[];
  /** Plots whose title names a stop or a target: levels the bot could read. */
  levelPlots: string[]; ownLevels: boolean; corrections: Correction[];
}

interface Call { name: string; line: number; args: string[] }

/** Every call to one of `names`, with its full argument list. Comments are ignored; strings are kept. */
function callsOf(source: string, names: string): Call[] {
  const code = mask(source, false), bare = mask(source, true), out: Call[] = [];
  for (const m of bare.matchAll(new RegExp(String.raw`(?<![\w.])(${names})\s*\(`, 'g'))) {
    const open = m.index! + m[0].length - 1; let end = open + 1, depth = 1;
    for (; end < bare.length && depth; end++) { if (bare[end] === '(') depth++; else if (bare[end] === ')') depth--; }
    out.push({ name: m[1], line: bare.slice(0, m.index!).split('\n').length, args: argumentsOf(code.slice(open + 1, end - 1)) });
  }
  return out;
}
/** A named argument, else the positional one at `pos` (positional arguments stop at the first named one). */
function arg(args: string[], name: string, pos: number): string | undefined {
  const named = args.find(a => new RegExp(String.raw`^${name}\s*=(?!=)`).test(a));
  if (named) return named.replace(/^[\w.]+\s*=\s*/, '').trim();
  const firstNamed = args.findIndex(a => /^[A-Za-z_]\w*\s*=(?!=)/.test(a));
  return pos < (firstNamed < 0 ? args.length : firstNamed) ? args[pos]?.trim() : undefined;
}
const literal = (s: string | undefined): string | undefined => { const m = /^(["'])([\s\S]*)\1$/.exec(s?.trim() ?? ''); return m ? m[2] : undefined; };

const POSITION_WORDS = /\b(upper|lower|above|below|top|bottom|high|low|support|resistance|up|down|dn)\b/gi;
/** A title whose only direction words say where the marker sits, not which way to trade. */
const positionalOnly = (title: string) => !directionalTitle(title.replace(POSITION_WORDS, ' '), true);

const SWAPS: Array<[string, string]> = [['bullish', 'bearish'], ['bull', 'bear'], ['long', 'short'], ['buy', 'sell'], ['upper', 'lower'], ['above', 'below'],
  ['up', 'down'], ['up', 'dn'], ['top', 'bottom'], ['high', 'low'], ['positive', 'negative'], ['rising', 'falling'], ['upward', 'downward']];
/** The title with every direction word swapped for its opposite; undefined when it has none. */
export function mirrorTitle(title: string): string | undefined {
  const words = new Map<string, string>();
  for (const [a, b] of SWAPS) { if (!words.has(a)) words.set(a, b); if (!words.has(b)) words.set(b, a); }
  let swapped = false;
  const out = title.toLowerCase().replace(/[a-z]+/g, w => { const o = words.get(w); if (o) swapped = true; return o ?? w; });
  return swapped ? out.replace(/\bdn\b/g, 'down').replace(/\s+/g, ' ').trim() : undefined;
}
const norm = (t: string) => t.toLowerCase().replace(/\bdn\b/g, 'down').replace(/\s+/g, ' ').trim();

/** Titles that describe a state change or a piece of information. Some are real entries; a person decides. */
const NOT_AN_ENTRY = /\b(flip|turned|background|regime|state|step|spike|zero cross|cross(?:ed)? (?:above|below)|trend (?:up|down)|histogram)\b/i;
const LEVEL_PLOT = /\bstop\b|\bsl\b|stop[\s-]?loss|take[\s-]?profit|\btp\s?\d?\b|\btarget/i;
const LEVEL_VAR = /^[ \t]*(?:var\s+)?(?:float\s+)?(sl|stop|stoploss|stop_loss|slprice|sl_price|sllevel|sl_level|stopprice|stop_price|tp\d?|tp_?\d|takeprofit|take_profit|tpprice|tp_price|target\d?)\s*:?=(?!=)/im;

function drawnSide(style: string | undefined, location: string | undefined): { side?: Side; strong: boolean } {
  const st = /^shape\.(\w+)$/.exec(style ?? '')?.[1]?.toLowerCase(), loc = /^location\.(\w+)$/.exec(location ?? '')?.[1]?.toLowerCase();
  const byStyle: Side | undefined = st && /(triangle|arrow|label)up$/.test(st) ? 'long' : st && /(triangle|arrow|label)down$/.test(st) ? 'short' : undefined;
  const byLoc: Side | undefined = loc === 'belowbar' ? 'long' : loc === 'abovebar' ? 'short' : undefined;
  if (byStyle && byLoc) return byStyle === byLoc ? { side: byStyle, strong: true } : { strong: false };
  return { side: byStyle ?? byLoc, strong: false };
}

/** What extractEvents() would make of this marker, from its title alone. */
function readMarker(m: Pick<Marker, 'channel' | 'title' | 'literal' | 'style' | 'location'>, r: Reading): Pick<Marker, 'reads' | 'why'> {
  if (!m.literal) return { reads: 'unread', why: 'the title is an expression' };
  const allow = (src: string) => !r.sources || r.sources.includes(src);
  const allowLabels = (r.labels ?? []).map(l => l.trim().toLowerCase()).filter(Boolean);
  const labelOk = !allowLabels.length || allowLabels.some(a => m.title.toLowerCase().startsWith(a));
  const named = Object.entries(r.sides ?? {}).find(([k]) => k.trim().toLowerCase() === m.title.trim().toLowerCase())?.[1];
  if (m.channel === 'alertcondition') {
    if (conditionExit(m.title)) return { reads: 'exit' };
    if (!allow('alertcondition')) return { reads: 'unread', why: 'the channel is excluded' };
    if (named === 'none') return { reads: 'none', why: 'the reading switches it off' };
    const side = named ?? directionalTitle(m.title, !r.legacy);
    if (!side) return { reads: 'unread', why: 'no direction in the title' };
    if (!named && INFO_ONLY.test(m.title) && !(allowLabels.length && labelOk)) return { reads: 'unread', why: 'a context title' };
    return labelOk ? { reads: side } : { reads: 'none', why: 'not in the allow-list' };
  }
  if (!allow('shape')) return { reads: 'unread', why: 'the channel is excluded' };
  if (named === 'none') return { reads: 'none', why: 'the reading switches it off' };
  const style = m.style?.replace(/^shape\./, ''), location = m.location?.replace(/^location\./, '');
  const side = named ?? shapeSide(m.title) ?? (r.legacy ? undefined : geometrySide({ title: m.title, shape: style, location }));
  if (!side) return { reads: 'unread', why: 'no direction in the title' };
  return labelOk ? { reads: side } : { reads: 'none', why: 'not in the allow-list' };
}

export function auditScript(source: string, reading: Reading = {}, opts: AuditOptions = {}): ScriptAudit {
  const bare = mask(source, true), strategy = /^\s*strategy\s*\(/m.test(bare);
  const markers: Marker[] = [];
  for (const c of callsOf(source, 'plotshape|plotchar')) {
    const raw = arg(c.args, 'title', 1), title = literal(raw);
    const style = c.name === 'plotshape' ? arg(c.args, 'style', 2) : undefined, location = arg(c.args, 'location', 3);
    const m = { channel: 'shape' as const, line: c.line, title: title ?? raw ?? '', literal: title !== undefined, condition: (arg(c.args, 'series', 0) ?? '').slice(0, 200), style, location };
    markers.push({ ...m, drawn: drawnSide(style, location).side, ...readMarker(m, reading) });
  }
  for (const c of callsOf(source, 'alertcondition')) {
    const raw = arg(c.args, 'title', 1), title = literal(raw);
    const m = { channel: 'alertcondition' as const, line: c.line, title: title ?? raw ?? '', literal: title !== undefined, condition: (arg(c.args, 'condition', 0) ?? '').slice(0, 200) };
    markers.push({ ...m, ...readMarker(m, reading) });
  }
  const alerts = callsOf(source, 'alert');
  const levelPlots = [...new Set(callsOf(source, 'plot').map(c => literal(arg(c.args, 'title', 1))).filter((t): t is string => !!t && LEVEL_PLOT.test(t)))];
  const exits = callsOf(source, 'strategy\\.exit');
  const ownLevels = LEVEL_VAR.test(bare) || exits.some(c => c.args.some(a => /^(stop|limit|loss|profit|trail_\w+)\s*=/.test(a)));
  const alertCarriesLevels = alerts.some(c => /\b(SL|TP\d?|Stop|Target)\b\s*:/.test(c.args.join(',')));
  const corrections: Correction[] = [];
  const traded = (m: Marker): m is Marker & { reads: Side } => m.reads === 'long' || m.reads === 'short';

  // 1. a shape traded on the side opposite to the one it is drawn on
  for (const m of markers) {
    // only a drawing that says it twice (an up shape under the bar, a down shape over it) is evidence of a side
    if (m.channel !== 'shape' || !traded(m) || !m.drawn || m.drawn === m.reads || !drawnSide(m.style, m.location).strong) continue;
    corrections.push({ code: 'side-against-drawing', severity: positionalOnly(m.title) ? 'high' : 'review', line: m.line, marker: m.title,
      finding: `"${m.title}" is drawn as a ${m.drawn} (${[m.style, m.location].filter(Boolean).join(', ')}) and read as a ${m.reads}.`,
      proposal: `Read "${m.title}" as a ${m.drawn}, or record why the opposite reading is intended.`, patch: { sides: { [m.title.toLowerCase()]: m.drawn } } });
  }
  // 2. one side of a mirrored pair is traded and the other is not
  for (const m of markers) {
    if (!m.literal || traded(m) || m.reads === 'exit') continue;
    const mirror = mirrorTitle(m.title); if (!mirror) continue;
    const twin = markers.find(o => o.channel === m.channel && traded(o) && norm(o.title) === mirror);
    if (!twin || !traded(twin)) continue;
    const side: Side = twin.reads === 'long' ? 'short' : 'long';
    if (corrections.some(c => c.code === 'side-dropped' && c.marker === m.title)) continue;
    corrections.push({ code: 'side-dropped', severity: 'medium', line: m.line, marker: m.title,
      finding: `"${twin.title}" is traded as a ${twin.reads}; its mirror "${m.title}" is not (${m.why ?? 'not read'}).`,
      proposal: `Trade "${m.title}" as a ${side}, so the script is read on both sides.`,
      patch: { sides: { [m.title.toLowerCase()]: side }, ...(reading.labels?.length ? { labels: [...reading.labels, m.title] } : {}) } });
  }
  // 2b. the allow-list names one alert() text and the source also sends its mirror
  const alertTexts = alerts.flatMap(c => [...(c.args[0] ?? '').matchAll(/(["'])((?:(?!\1).)+)\1/g)].map(m => m[2].trim())).filter(t => t.length > 3);
  for (const allowed of reading.labels ?? []) {
    const mirror = mirrorTitle(allowed); if (!mirror) continue;
    const twin = alertTexts.find(t => norm(t).startsWith(mirror));
    if (!twin || (reading.labels ?? []).some(l => norm(twin).startsWith(norm(l)))) continue;
    corrections.push({ code: 'side-dropped', severity: 'medium', marker: twin,
      finding: `The allow-list trades the alert "${allowed}"; the script also sends "${twin}", which is not traded.`,
      proposal: `Add "${twin}" to the allow-list, so the script is read on both sides.`, patch: { labels: [...(reading.labels ?? []), twin] } });
  }
  // 3. a traded title that reads like a state change or information
  for (const m of markers) {
    if (!traded(m) || !NOT_AN_ENTRY.test(m.title)) continue;
    corrections.push({ code: 'not-an-entry', severity: 'review', line: m.line, marker: m.title,
      finding: `"${m.title}" is traded as a ${m.reads} entry, but the title describes a state change or information.`,
      proposal: `Confirm it is the author's entry; otherwise switch it off and use it as context or as an exit.`, patch: { sides: { [m.title.toLowerCase()]: 'none' } } });
  }
  // 4. the script's own stop and targets
  if (ownLevels && alertCarriesLevels) {
    if (opts.skipScriptStops && reading.entryProtection !== 'native') corrections.push({ code: 'own-stop-discarded', severity: 'medium',
      finding: 'The script sends its own stop and targets with each entry, and the account discards the stop for its ATR stop.',
      proposal: 'Trade it on its own stop in a shadow variant and compare.', patch: { entryProtection: 'native' } });
  } else if (ownLevels && levelPlots.length) {
    corrections.push({ code: 'levels-plotted-unread', severity: 'medium', finding: `The script computes its own stop or targets and plots them (${levelPlots.slice(0, 6).map(t => `"${t}"`).join(', ')}); no entry carries them.`,
      proposal: 'Read those plots as the stop and targets of the entry.' });
  } else if (ownLevels) {
    corrections.push({ code: 'levels-not-exported', severity: 'medium', finding: 'The script computes its own stop or targets, but only in variables or drawings the bot cannot read.',
      proposal: 'Add plot() exports for those levels in the patch layer, then read them.' });
  }
  // 5. alerts the author leaves switched off
  const off = callsOf(source, 'input\\.bool|input').filter(c => /^false$/.test(arg(c.args, 'defval', 0) ?? '') && /alert|notif/i.test(literal(arg(c.args, 'title', 1)) ?? ''));
  if (off.length && alerts.length) corrections.push({ code: 'alerts-off-by-default', severity: 'medium', line: off[0].line,
    finding: `${off.length} alert switch${off.length > 1 ? 'es default' : ' defaults'} to off: ${off.slice(0, 5).map(c => `"${literal(arg(c.args, 'title', 1))}"`).join(', ')}.`,
    proposal: 'Turn them on in the scanner inputs if the bot should hear those events (targets, break-even, exits).',
    patch: { inputs: Object.fromEntries(off.map(c => [literal(arg(c.args, 'title', 1))!, true])) } });
  // 6. pivots that confirm many bars late
  const defaults = new Map<string, number>();
  for (const m of bare.matchAll(/^[ \t]*(?:int\s+)?(\w+)\s*=\s*input(?:\.int)?\s*\(\s*(\d+)/gm)) defaults.set(m[1], Number(m[2]));
  let late = 0, lateLine = 0;
  for (const c of callsOf(source, 'ta\\.pivothigh|ta\\.pivotlow')) {
    const right = c.args[c.args.length - 1]?.trim() ?? '', n = /^\d+$/.test(right) ? Number(right) : defaults.get(right);
    if (n !== undefined && n > late) { late = n; lateLine = c.line; }
  }
  if (late >= 10) corrections.push({ code: 'late-pivot', severity: 'review', line: lateLine,
    finding: `A pivot is confirmed ${late} bars after it happens: ${(late / 4).toFixed(1)} h on 15m, ${late} h on 1h, ${late * 4} h on 4h.`,
    proposal: 'Check that signals built on it are still timely on each timeframe; shorten the pivot length where the author suggests it.' });
  // 7. higher-timeframe data that can look ahead
  for (const c of callsOf(source, 'request\\.security')) {
    if (!c.args.some(a => /lookahead\s*=\s*barmerge\.lookahead_on/.test(a))) continue;
    const expr = arg(c.args, 'expression', 2) ?? '';
    if (/\[\s*[1-9]\d*\s*\]/.test(expr)) continue;
    // a plain series is certain to look ahead; a function or tuple may apply its own offset inside
    corrections.push({ code: 'lookahead', severity: /^[\w.]+$/.test(expr) ? 'high' : 'review', line: c.line, finding: `request.security reads "${expr.slice(0, 60)}" with lookahead on and no history offset: on a closed bar it can see the unfinished higher-timeframe bar.`,
      proposal: 'Do not trade signals that depend on it until a prefix-stability check passes.' });
  }
  // 8. nothing the bot can read as an entry
  if (!strategy && !alerts.length && !markers.some(traded)) corrections.push({ code: 'no-entry-read', severity: 'review',
    finding: markers.length ? 'None of the script\'s markers reads as an entry.' : 'The script has no alerts and no markers.',
    proposal: 'Treat it as context only, or name its entry markers in a reading.' });
  // a script that declares the same marker twice (two sizes of one shape) is one finding
  const seen = new Set<string>();
  const unique = corrections.filter(c => { const k = `${c.code}|${c.marker ?? c.line ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { lines: source.split('\n').length, strategy, alertCalls: alerts.length, markers, levelPlots, ownLevels, corrections: unique };
}
