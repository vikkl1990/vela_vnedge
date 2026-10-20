/**
 * Source-level compatibility patches applied to Pine scripts before they are handed to
 * PineTS. Each rule is conservative: it only rewrites constructs PineTS cannot execute
 * (verified against pinets 0.9.x) and never changes signal logic.
 *
 * The same patched source is served to the dashboard so the Vela chart runs the exact
 * code the scanner executed.
 */
import { dropQualifiers, dropStatementCommas, fundamentalsToNa, intWindowLengths, joinContinuations, liftV4, renameReserved } from './compat.ts';

export interface PatchRule {
  id: string;
  description: string;
  /** Optional file-name filter (script slug prefix). */
  only?: string[];
  apply: (src: string) => string;
}

/** TradingView's `ta` library (v12): the exports that are not built-in `ta.*` functions (decision 163). */
const TA_LIBRARY_OWN = ['ao', 'aroon', 'atr2', 'cagr', 'chandelier', 'chandelier2', 'changePercent', 'coppock', 'dema', 'dema2', 'dm', 'donchian', 'ema2', 'eom', 'er', 'frama', 'ft', 'highestSince', 'ht', 'ichimoku', 'ift', 'kama', 'kvo', 'lowestSince', 'macd2', 'pmo', 'ppo', 'ppo2', 'pzo', 'relativeVolume', 'requestUpAndDownVolume', 'requestVolumeDelta', 'rma2', 'rms', 'rwi', 'specialK', 'stc', 'stochFull', 'stochRsi', 'supertrend2', 'szo', 't3', 't3Alt', 'tema', 'tema2', 'trima', 'trix', 'ulcerIndex', 'uo', 'vStop', 'vStop2', 'vhf', 'vi', 'vzo', 'williamsFractal', 'wpo'];

export const PATCH_RULES: PatchRule[] = [
  // decision 126: generic lowerings for what the PineTS parser and runtime cannot take, applied before the specific rules
  { id: 'v4-to-v5', description: 'Pine v4 (v3, v2) lifted to v5 by the published migration table: study → indicator, security → request.security, ta.* and math.* prefixes, typed inputs, str.*; transp and iff lowered.', apply: liftV4 },
  { id: 'statement-comma', description: "A comma that ends a statement with every bracket closed (Pine's statement separator) is dropped; PineTS and the continuation joiner read it as a continuation (decision 163).", apply: dropStatementCommas },
  { id: 'line-continuation', description: "Pine's continuation lines (inside brackets, or a more-indented line starting with an operator) are joined onto their statement and comment-only lines are removed; PineTS's indentation lexer rejects the first and tokenises the second at a depth that can break the block around it.", apply: joinContinuations },
  { id: 'drop-qualifiers', description: '`for int i = …` loop types and `series` / `simple` / `const` declaration qualifiers are dropped; PineTS does not parse them and they carry no runtime meaning.', apply: dropQualifiers },
  { id: 'reserved-identifier', description: 'A script that uses `type` or `method` as a variable name has it renamed; PineTS lexes both as keywords.', apply: renameReserved },
  { id: 'int-window-length', description: 'A ta.* window length written as a division is wrapped in int(); PineTS 0.12 returns na for a fractional window where TradingView and PineTS 0.10 truncate (decision 151).', apply: intWindowLengths },
  {
    id: 'htf-guard',
    description: "A one-line `runtime.error` guard that the chosen timeframe is above the chart's is removed; PineTS evaluates request.security by re-running the script on that timeframe, where the guard compares the timeframe with itself and stops the script. The guard only checks the input, so removing it changes no signal.",
    apply: (src) => src.replace(/^if (?:barstate\.isfirst and )?timeframe\.in_seconds\(\w+\)\s*<=\s*timeframe\.in_seconds\(timeframe\.period\)[ \t]*\n[ \t]+runtime\.error\([^\n]*\)[ \t]*\n(?![ \t])/gm, ''),
  },
  {
    id: 'unused-ta-import',
    description: "An `import TradingView/ta/N` whose own functions the script never calls is removed; PineTS loads no TradingView library, and without that library's functions the import only names the built-in `ta` namespace the script already uses (decision 163).",
    apply: (src) => {
      const m = src.match(/^import\s+TradingView\/ta\/\d+(?:\s+as\s+(\w+))?[ \t]*\r?$/m);
      if (!m) return src;
      const alias = m[1] ?? 'ta';
      return TA_LIBRARY_OWN.some(f => new RegExp(`\\b${alias}\\.${f}\\s*\\(`).test(src)) ? src : src.replace(m[0], '');
    },
  },
  { id: 'fundamentals-na', description: 'request.financial / earnings / dividends / splits / footprint / economic return na on a crypto perpetual on TradingView too; lowered to na so the script runs.', apply: fundamentalsToNa },
  {
    id: 'label.all-size',
    description: "PineTS returns a plain JS array for `label.all` / `line.all` / `box.all`, so `array.size(x.all)` throws. These calls only guard drawing-object housekeeping; the branch is disabled.",
    apply: (src) => src.replace(/array\.size\(\s*(label|line|box|table|linefill|polyline)\.all\s*\)/g, '0'),
  },
  {
    id: 'timeframe.in_seconds-noarg',
    description: 'PineTS `timeframe.in_seconds()` without an argument returns a non-numeric value; pass the chart period explicitly.',
    apply: (src) => src.replace(/timeframe\.in_seconds\(\s*\)/g, 'timeframe.in_seconds(timeframe.period)'),
  },
  {
    id: 'ltm-short-circuit',
    description: 'PineTS evaluates both sides of `and`; clamp the neighbour index in the local-extreme test so the guarded `array.get` never goes out of bounds.',
    only: ['cdnBBG0A-Liquidity-Trail-Matrix'],
    apply: (src) => src
      .replace(/array\.get\(vols, i \+ 1\)/g, 'array.get(vols, math.min(i + 1, profRowsInput - 1))')
      .replace(/array\.get\(vols, i - 1\)/g, 'array.get(vols, math.max(i - 1, 0))'),
  },
  {
    id: 'if-array-get-field',
    description: 'PineTS loses the binding of a global array when a field is read straight off `array.get(arr, i).field` in an `if` test ("arr is not defined"); the element is read into a local first (same value, same order).',
    apply: (src) => src.replace(/^([ \t]*)(if|else if)([ \t]+)(.*?)array\.get\((\w+),[ \t]*([^()\n]+)\)\.(\w+)/gm, (_m, ind, kw, sp, pre, arr, idx, field, offset: number, whole: string) => {
      const n = (whole.slice(0, offset).match(/__vnedge_el_/g) ?? []).length;
      return `${ind}__vnedge_el_${n} = array.get(${arr}, ${idx})\n${ind}${kw}${sp}${pre}__vnedge_el_${n}.${field}`;
    }),
  },
  {
    id: 'synapse-htf-string',
    description: 'PineTS `timeframe.in_seconds()` / `request.security()` need a string timeframe; the auto-HTF helper can yield a non-string, so coerce it.',
    only: ['RjkDXQnZ-Synapse-Trail-Pro'],
    apply: (src) => src
      .replace(/timeframe\.in_seconds\(htfRes\)/g, 'timeframe.in_seconds(str.tostring(htfRes))')
      .replace(/request\.security\(syminfo\.tickerid, htfRes,/g, 'request.security(syminfo.tickerid, str.tostring(htfRes),'),
  },
  {
    id: 'strat-inline-security',
    description: 'PineTS cannot return a higher-timeframe tuple from `request.security()` wrapped in a user function; inline the calls.',
    only: ['ngb1s23R-STRAT-Trap-VWAP-Engine'],
    apply: (src) => src.replace(/=\s*htf\("(\w+)"\)/g, '= request.security(syminfo.tickerid, "$1", [open, close, high, low, high[1], low[1]])'),
  },
  {
    id: 'amd-enum-to-strings',
    description: 'PineTS does not transpile Pine v6 `enum` declarations; the FSM enum is lowered to string constants (semantics preserved).',
    only: ['hkKioUnL-AMD-Po3'],
    apply: (src) => src
      .replace(/^enum Phase\n(?:[ \t]+\w+[^\n]*\n)+/m, '// enum Phase lowered to strings by VNEdge patch\n')
      .replace(/\bvar Phase state\b/g, 'var string state')
      .replace(/\bPhase\.(\w+)/g, '"$1"'),
  },
];

export interface PatchResult { source: string; applied: string[] }

export function applyPatches(source: string, fileName: string): PatchResult {
  let out = source;
  const applied: string[] = [];
  for (const rule of PATCH_RULES) {
    if (rule.only && !rule.only.some(p => fileName.startsWith(p))) continue;
    const next = rule.apply(out);
    if (next !== out) { applied.push(rule.id); out = next; }
  }
  return { source: out, applied };
}
