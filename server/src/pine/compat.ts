/**
 * Generic source rewrites for constructs PineTS cannot parse or run (decision 126). Each one is a
 * lowering that keeps the script's meaning: Pine's line continuations are joined, qualifiers PineTS does
 * not know are dropped, identifiers PineTS treats as keywords are renamed, Pine v4 is lifted to v5 by
 * the published migration table, and fundamentals requests that are `na` on crypto anyway become `na`.
 * Strings and comments are respected throughout. Nothing here changes a signal.
 */

/** Index of the first `//` outside a string, or -1. */
function commentStart(line: string): number {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}
/** Bracket depth change over a line, strings and comment ignored. */
function depthDelta(line: string): number {
  const cut = commentStart(line); const s = cut >= 0 ? line.slice(0, cut) : line;
  let q: string | null = null; let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return d;
}
const indentOf = (l: string) => l.match(/^[ \t]*/)![0].length;
const isBlank = (l: string) => l.trim() === '';
/** A comment-only line; the compiler annotations (`//@version`, `//@strategy_alert_message`, …) are not comments to PineTS and stay. */
const isComment = (l: string) => /^\s*\/\//.test(l) && !/^\s*\/\/\s*@/.test(l);
const CONTINUES = /^\s*(\+|-|\*|\/|%|\?|:|,|==|!=|<=|>=|<|>|and\b|or\b)/;

/**
 * Pine lets a statement continue on following lines (inside brackets, or a more-indented line that starts with
 * an operator); PineTS's indentation lexer does not. Continuations are joined onto their statement, trailing
 * comments dropped from joined lines, comment-only lines removed.
 */
export function joinContinuations(src: string): string {
  const lines = src.split('\n'); const out: string[] = []; let depth = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (depth > 0) {
      if (isBlank(line) || isComment(line)) continue;
      const prev = out.pop()!; const cut = commentStart(prev);
      out.push((cut >= 0 ? prev.slice(0, cut) : prev).replace(/\s+$/, '') + ' ' + line.trim());
      depth += depthDelta(line);
      continue;
    }
    const prev = out.length ? out[out.length - 1] : null;
    // Pine's rule: a continuation line is indented by an amount that is not a block step (a multiple of four);
    // `else if cond` followed by `        -1` is a block whose value is minus one, not a subtraction
    if (prev !== null && !isBlank(prev) && !isComment(prev) && CONTINUES.test(line) && indentOf(line) > indentOf(prev) && (indentOf(line) - indentOf(prev)) % 4 !== 0 && !/^\s*-\s*-/.test(line)) {
      const cut = commentStart(prev); out.pop();
      out.push((cut >= 0 ? prev.slice(0, cut) : prev).replace(/\s+$/, '') + ' ' + line.trim());
      depth += depthDelta(line);
      continue;
    }
    out.push(line);
    depth = Math.max(0, depth + depthDelta(line));
  }
  // PineTS lexes comments as tokens whose indentation counts, so a comment-only line at the wrong depth breaks the
  // block around it; comment-only lines are removed (a statement's trailing comment stays)
  return out.filter(l => !isComment(l)).join('\n');
}

/** `for int i = 0 to n` and `var series float x = …`: qualifiers PineTS does not accept. */
export function dropQualifiers(src: string): string {
  return src
    .replace(/\bfor\s+(?:int|float|bool|string|color)\s+(\w+|\[[^\]]+\])\s*(=|in\b)/g, 'for $1 $2')
    .replace(/^([ \t]*)((?:var|varip)\s+)?(?:series|simple|const|input)\s+(int|float|bool|string|color|line|label|box|table|linefill|polyline|array<[^>]+>|matrix<[^>]+>|map<[^>]+>)\s+(\w+)/gm, '$1$2$3 $4');
}

/** Replace identifier `name` outside strings and comments, with a guard on the whole line. */
function renameIdent(src: string, name: string, to: string, skipLine: (line: string) => boolean): string {
  const re = new RegExp(`(?<![\\w.])${name}(?![\\w])`, 'g');
  return src.split('\n').map(line => {
    if (skipLine(line)) return line;
    const cut = commentStart(line); const code = cut >= 0 ? line.slice(0, cut) : line; const rest = cut >= 0 ? line.slice(cut) : '';
    // replace only in the unquoted segments
    let out = ''; let q: string | null = null; let seg = '';
    const flush = () => { out += q ? seg : seg.replace(re, to); seg = ''; };
    for (let i = 0; i < code.length; i++) {
      const c = code[i];
      if (q) { seg += c; if (c === '\\' && i + 1 < code.length) { seg += code[++i]; } else if (c === q) { flush(); q = null; } continue; }
      if (c === '"' || c === "'") { flush(); q = c; seg = c; continue; }
      seg += c;
    }
    flush();
    return out + rest;
  }).join('\n');
}

/** `type` and `method` are keywords to PineTS; a script that uses them as variable names has them renamed. */
export function renameReserved(src: string): string {
  let out = src;
  if (/^[ \t]*type\s*(:?=)[^=]/m.test(out)) out = renameIdent(out, 'type', 'type_', l => /^\s*type\s+[A-Za-z_]\w*\s*$/.test(l) || /^\s*(export\s+)?type\s+[A-Za-z_]\w*/.test(l));
  if (/^[ \t]*method\s*(:?=)[^=]/m.test(out)) out = renameIdent(out, 'method', 'method_', l => /^\s*(export\s+)?method\s+\w+\s*\(/.test(l));
  return out;
}

/** Replace every call `name(…)` with balanced parentheses by `repl(args)`. */
export function replaceCall(src: string, name: string, repl: (args: string) => string): string {
  const re = new RegExp(`(?<![\\w.])${name.replace(/\./g, '\\.')}\\s*\\(`, 'g');
  let out = ''; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index; let i = re.lastIndex; let d = 1; let q: string | null = null;
    for (; i < src.length && d > 0; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if (c === '(') d++; else if (c === ')') d--;
    }
    if (d !== 0) break;
    out += src.slice(last, start) + repl(src.slice(re.lastIndex, i - 1)); last = i; re.lastIndex = i;
  }
  return out + src.slice(last);
}

/** Fundamentals and footprint data do not exist for Delta's perpetuals: TradingView returns `na` there too. */
export function fundamentalsToNa(src: string): string {
  let out = src;
  for (const fn of ['request.financial', 'request.earnings', 'request.dividends', 'request.splits', 'request.footprint', 'request.economic', 'request.quandl']) out = replaceCall(out, fn, () => 'float(na)');
  return out;
}

/**
 * Decision 151: a `ta.*` window whose length is written as a division (`ta.wma(src, len / 2)`, the Hull average's
 * construction) is wrapped in `int(...)`. Pine v6 divides ints to a float; PineTS from 0.12.0 returns na for a
 * window that is not a whole number, where 0.10.0 truncated it, so the Hull family went silent.
 */
export function intWindowLengths(src: string): string {
  return src.replace(/(\bta\.(?:wma|sma|ema|rma|hma|vwma|swma|alma|linreg|stdev|dev|variance|highest|lowest|highestbars|lowestbars|change|mom|roc|rsi|cci|mfi|cmo|wpr|pivothigh|pivotlow|percentrank|median|range|rising|falling|correlation)\()([^()]*?,\s*)([A-Za-z_][A-Za-z0-9_.]*\s*\/\s*[0-9A-Za-z_.]+)(\s*\))/g, '$1$2int($3)$4');
}

const TA = ['sma', 'ema', 'rma', 'wma', 'vwma', 'hma', 'alma', 'swma', 'vwap', 'rsi', 'macd', 'stoch', 'cci', 'mfi', 'obv', 'atr', 'tr', 'sar', 'bb', 'bbw', 'kc', 'kcw', 'dmi', 'supertrend', 'cum', 'change', 'mom', 'roc', 'tsi', 'wpr', 'cog', 'correlation', 'percentrank', 'percentile_linear_interpolation', 'percentile_nearest_rank', 'linreg', 'variance', 'stdev', 'dev', 'median', 'mode', 'range', 'highest', 'lowest', 'highestbars', 'lowestbars', 'valuewhen', 'barssince', 'crossover', 'crossunder', 'cross', 'rising', 'falling', 'pivothigh', 'pivotlow', 'accdist', 'iii', 'nvi', 'pvi', 'pvt', 'wad', 'wvad'];
const MATH = ['abs', 'max', 'min', 'pow', 'sqrt', 'exp', 'log', 'log10', 'floor', 'ceil', 'round', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'avg', 'sum', 'random', 'round_to_mintick', 'todegrees', 'toradians'];
const INPUT_TYPES: Record<string, string> = { integer: 'int', float: 'float', bool: 'bool', string: 'string', symbol: 'symbol', resolution: 'timeframe', session: 'session', source: 'source', color: 'color', time: 'time' };

/** Pine v4 (and the v3/v2 subset that shares its names) lifted to v5 by the migration table. */
export function liftV4(src: string): string {
  if (!/^\s*\/\/@version=[234]\s*$/m.test(src)) return src;
  let out = src.replace(/^\s*\/\/@version=[234]\s*$/m, '//@version=5');
  out = out.replace(/(?<![\w.])study\s*\(/g, 'indicator(').replace(/(?<![\w.])security\s*\(/g, 'request.security(');
  out = out.replace(/\bresolution\s*=/g, 'timeframe =').replace(/\binput\.resolution\b/g, 'input.timeframe');
  for (const f of TA) out = out.replace(new RegExp(`(?<![\\w.])${f}\\s*\\(`, 'g'), `ta.${f}(`);
  for (const f of MATH) out = out.replace(new RegExp(`(?<![\\w.])${f}\\s*\\(`, 'g'), `math.${f}(`);
  out = out.replace(/(?<![\w.])tostring\s*\(/g, 'str.tostring(').replace(/(?<![\w.])tonumber\s*\(/g, 'str.tonumber(');
  // typed inputs: input(…, type=input.integer, …) → input.int(…); the type argument goes
  out = replaceCall(out, 'input', args => {
    const m = /,?\s*type\s*=\s*(?:input\.)?(\w+)\s*/.exec(args);
    if (!m) {
      // v5's untyped input() takes neither `options` nor `minval`, and PineTS cannot read a colour or a series from it:
      // the type comes from the default value; a default it cannot classify is left alone
      const parts = splitTop(args); const first = parts.find(p => /^defval\s*=/.test(p)) ?? parts[0] ?? ''; const defval = first.replace(/^defval\s*=\s*/, '');
      const kind = /^['"]/.test(defval) ? 'string' : /^(true|false)$/.test(defval) ? 'bool' : /^-?\d+$/.test(defval) ? 'int' : /^-?(\d+\.\d*|\.\d+|\d+)(e-?\d+)?$/.test(defval) ? 'float'
        : /^(#[0-9a-fA-F]{6,8}|color\.\w+)$/.test(defval) ? 'color' : /^(open|high|low|close|hl2|hlc3|ohlc4|hlcc4|volume)$/.test(defval) ? 'source' : /^timestamp\(/.test(defval) ? 'time' : null;
      return kind ? `input.${kind}(${args})` : `input(${args})`;
    }
    if (!INPUT_TYPES[m[1]]) return `input(${args})`;
    const rest = args.replace(m[0], m[0].startsWith(',') ? '' : '').replace(/\(\s*,/, '(').replace(/,\s*,/g, ',').replace(/,\s*$/, '');
    return `input.${INPUT_TYPES[m[1]]}(${rest})`;
  });
  // `transp=` is gone in v5; it only affects drawing
  out = out.replace(/,\s*transp\s*=\s*[^,)]+/g, '');
  // iff(c, a, b) → (c ? a : b)
  out = replaceCall(out, 'iff', args => { const p = splitTop(args); return p.length === 3 ? `(${p[0]} ? ${p[1]} : ${p[2]})` : `iff(${args})`; });
  return out;
}

/** Split call arguments on top-level commas. */
function splitTop(args: string): string[] {
  const out: string[] = []; let d = 0; let q: string | null = null; let cur = '';
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (q) { cur += c; if (c === '\\' && i + 1 < args.length) cur += args[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c; else if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
    if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Decision 163: Pine lets a comma end a statement (`a := 1, b := 2,`); PineTS's lexer and the continuation joiner read
 * a trailing comma as "the statement goes on". A comma that ends a line with every bracket closed, followed by a line
 * that starts a statement (indented by a multiple of four, no deeper than this one), is that separator and is dropped.
 * A following line wrapped at any other indentation continues the statement, and its comma stays. Strings and comments
 * are skipped when counting brackets.
 */
export function dropStatementCommas(src: string): string {
  const lines = src.split('\n');
  const indent = (l: string) => l.length - l.trimStart().length;
  const isCode = (l: string) => l.trim() !== '' && !l.trim().startsWith('//');
  let depth = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let inStr: string | null = null, end = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '/' && line[i + 1] === '/') { end = i; break; }
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;
    const code = line.slice(0, end), m = code.match(/,\s*$/);
    if (!m) continue;
    let k = n + 1; while (k < lines.length && !isCode(lines[k])) k++;
    const next = k < lines.length ? indent(lines[k]) : 0;
    if (next % 4 === 0 && next <= indent(line)) lines[n] = code.slice(0, m.index) + line.slice(end);
  }
  return lines.join('\n');
}

/** Top-level arguments of a call's argument text (commas inside brackets or strings do not split). */
function topLevelArgs(args: string): string[] {
  const out: string[] = []; let d = 0, q: string | null = null, cur = '';
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (q) { cur += c; if (c === '\\') { cur += args[++i] ?? ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
    if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Decision 172: every `label.new(...)` gets `tooltip = "vn:" + str.tostring(bar_index)` at creation, so the worker can read
 * the bar a label appeared on, whatever bar it points at. A call that sets its own tooltip, or passes eleven or more
 * positional arguments (the tooltip among them), is left alone and that label carries no stamp.
 */
export function stampLabels(src: string): string {
  return replaceCall(src, 'label.new', (args) => {
    const top = topLevelArgs(args);
    if (top.some(a => /^\s*tooltip\s*=/.test(a)) || top.length >= 11) return `label.new(${args})`;
    return `label.new(${args}, tooltip = "vn:" + str.tostring(bar_index))`;
  });
}
