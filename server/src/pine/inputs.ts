/**
 * Parses `input.*(...)` declarations out of a Pine source without transpiling it, so the API
 * can list a script's tunable parameters (name, title, type, default, min/max/step, options)
 * and validate per-scanner overrides (`scanners.<id>.inputs`) before they reach PineTS.
 *
 * The worker applies overrides through PineTS's `Indicator.input[...]` proxy (keyed by the
 * variable name or the title), which validates again at run time.
 */

export type PineInputType = 'int' | 'float' | 'bool' | 'string' | 'source' | 'color' | 'timeframe' | 'session' | 'symbol' | 'text_area' | 'price' | 'time' | 'enum' | 'unknown';
export type InputValue = number | string | boolean;

export interface PineInputDecl {
  /** Variable the input is assigned to (`len = input.int(...)`); synthesized when the call is inline. */
  name: string;
  title: string;
  type: PineInputType;
  default: InputValue | null;
  min?: number;
  max?: number;
  step?: number;
  options?: InputValue[];
  group?: string;
  tooltip?: string;
  /** 1-based source line. */
  line: number;
}

const POSITIONAL: Record<string, string[]> = {
  int: ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm'],
  float: ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm'],
  bool: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm'],
  string: ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm'],
  source: ['defval', 'title', 'tooltip', 'inline', 'group'],
  color: ['defval', 'title', 'tooltip', 'inline', 'group'],
  timeframe: ['defval', 'title', 'options', 'tooltip', 'inline', 'group'],
  session: ['defval', 'title', 'options', 'tooltip', 'inline', 'group'],
  symbol: ['defval', 'title', 'tooltip', 'inline', 'group'],
  text_area: ['defval', 'title', 'tooltip', 'group'],
  price: ['defval', 'title', 'tooltip', 'inline', 'group'],
  time: ['defval', 'title', 'tooltip', 'inline', 'group'],
  enum: ['defval', 'title', 'options', 'tooltip', 'inline', 'group'],
  '': ['defval', 'title', 'tooltip', 'inline', 'group'],
};

/** Split a call's argument text on top-level commas (respects strings, nested parens/brackets). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of the `)` matching the `(` at `open`; -1 when unbalanced. */
function matchParen(src: string, open: number): number {
  let depth = 0, q: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    else if (ch === '\n' && depth === 0) return -1;
  }
  return -1;
}

function literal(raw: string): InputValue | null {
  const t = raw.trim();
  if (/^(true|false)$/.test(t)) return t === 'true';
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^"((?:[^"\\]|\\.)*)"$/) ?? t.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (m) return m[1].replace(/\\(.)/g, '$1');
  if (t === 'na') return null;
  return t; // identifier such as close, color.red, timeframe.period
}

function typeOf(fn: string, def: InputValue | null): PineInputType {
  if (fn) return (fn in POSITIONAL ? fn : 'unknown') as PineInputType;
  if (typeof def === 'boolean') return 'bool';
  if (typeof def === 'number') return Number.isInteger(def) ? 'int' : 'float';
  return 'string';
}

/** Every `input.*(...)` / `input(...)` declaration in source order. */
export function parseInputs(source: string): PineInputDecl[] {
  const out: PineInputDecl[] = [];
  const re = /\binput(?:\.(\w+))?\s*\(/g;
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(source, open);
    if (close < 0) continue;
    // skip comments
    const lineStart = source.lastIndexOf('\n', m.index) + 1;
    const before = source.slice(lineStart, m.index);
    if (before.includes('//')) continue;
    const fn = (m[1] ?? '').toLowerCase();
    if (!(fn in POSITIONAL)) continue;
    const args = splitArgs(source.slice(open + 1, close));
    const kv: Record<string, string> = {};
    const order = POSITIONAL[fn];
    let pos = 0;
    for (const a of args) {
      const km = a.match(/^([a-zA-Z_]\w*)\s*=(?!=)\s*([\s\S]*)$/);
      if (km) kv[km[1]] = km[2].trim();
      else if (pos < order.length) kv[order[pos++]] = a;
    }
    const def = kv.defval !== undefined ? literal(kv.defval) : null;
    const title = kv.title !== undefined ? String(literal(kv.title) ?? '') : '';
    let name = (before.match(/(?:^|[\s(,])(?:(?:var|varip)\s+)?(?:(?:int|float|bool|string|color|series|simple|input)\s+)*([a-zA-Z_]\w*)\s*(?::?=)\s*$/) ?? [])[1] ?? '';
    if (!name) name = (title || `input_${out.length + 1}`).replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || `input_${out.length + 1}`;
    let uniq = name, k = 2; while (used.has(uniq)) uniq = `${name}_${k++}`; used.add(uniq);
    const num = (s?: string) => { if (s === undefined) return undefined; const v = literal(s); return typeof v === 'number' ? v : undefined; };
    const decl: PineInputDecl = { name: uniq, title: title || uniq, type: typeOf(fn, def), default: def, line: source.slice(0, m.index).split('\n').length };
    const mn = num(kv.minval), mx = num(kv.maxval), st = num(kv.step);
    if (mn !== undefined) decl.min = mn; if (mx !== undefined) decl.max = mx; if (st !== undefined) decl.step = st;
    if (kv.options) { const o = kv.options.trim(); if (o.startsWith('[') && o.endsWith(']')) decl.options = splitArgs(o.slice(1, -1)).map(literal).filter((v): v is InputValue => v !== null); }
    if (kv.group) decl.group = String(literal(kv.group) ?? '');
    if (kv.tooltip) decl.tooltip = String(literal(kv.tooltip) ?? '').slice(0, 200);
    out.push(decl);
  }
  return out;
}

/**
 * Check overrides against the declarations: unknown names, wrong types and out-of-range
 * numbers are reported; accepted values are returned coerced (ints rounded, "12" → 12).
 */
export function validateInputOverrides(decls: PineInputDecl[], overrides: Record<string, unknown>): { values: Record<string, InputValue>; errors: string[] } {
  const values: Record<string, InputValue> = {};
  const errors: string[] = [];
  const byKey = new Map<string, PineInputDecl>();
  for (const d of decls) { byKey.set(d.name, d); if (!byKey.has(d.title)) byKey.set(d.title, d); }
  for (const [k, raw] of Object.entries(overrides ?? {})) {
    const d = byKey.get(k);
    if (!d) { errors.push(`unknown input "${k}"`); continue; }
    let v: unknown = raw;
    if (d.type === 'int' || d.type === 'float') {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${k}: expected a number`); continue; }
      let n = v as number;
      if (d.type === 'int') n = Math.round(n);
      if (d.min !== undefined && n < d.min) { errors.push(`${k}: ${n} is below minval ${d.min}`); continue; }
      if (d.max !== undefined && n > d.max) { errors.push(`${k}: ${n} is above maxval ${d.max}`); continue; }
      v = n;
    } else if (d.type === 'bool') {
      if (v === 'true' || v === 'false') v = v === 'true';
      if (typeof v !== 'boolean') { errors.push(`${k}: expected true/false`); continue; }
    } else {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { errors.push(`${k}: expected a string`); continue; }
      if (d.options?.length && !d.options.some(o => String(o) === String(v))) { errors.push(`${k}: "${v}" is not one of ${d.options.map(String).join(', ')}`); continue; }
    }
    values[d.name] = v as InputValue;
  }
  return { values, errors };
}
