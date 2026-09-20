/**
 * Source-level compatibility patches applied to Pine scripts before they are handed to
 * PineTS. Each rule is conservative: it only rewrites constructs PineTS cannot execute
 * (verified against pinets 0.9.x) and never changes signal logic.
 *
 * The same patched source is served to the dashboard so the Vela chart runs the exact
 * code the scanner executed.
 */
export interface PatchRule {
  id: string;
  description: string;
  /** Optional file-name filter (script slug prefix). */
  only?: string[];
  apply: (src: string) => string;
}

export const PATCH_RULES: PatchRule[] = [
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
