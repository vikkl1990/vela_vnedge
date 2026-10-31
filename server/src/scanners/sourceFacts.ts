/** Source inventory, not a claim that a script is causal, profitable, or fully reviewed. */
export interface SourceCall { name: string; line: number; condition: string; title: string; code: string }
export interface SourceFacts { lines: number; channels: string[]; inputs: number; calls: SourceCall[]; totalCalls: number; dependencies: string[]; cautions: string[]; strategy: boolean }

/** Replace comments (and optionally string contents) with spaces, preserving line numbers. */
function mask(source: string, strings: boolean): string {
  let out = '', quote = '', comment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (comment) { if (c === '\n') { comment = false; out += c; } else out += ' '; continue; }
    if (quote) {
      if (c === '\\') { out += strings ? '  ' : source.slice(i, i + 2); i++; continue; }
      if (c === quote) quote = '';
      out += strings && c !== '\n' ? ' ' : c; continue;
    }
    if (c === '/' && source[i + 1] === '/') { comment = true; out += ' '; continue; }
    if (c === '"' || c === "'") { quote = c; out += strings ? ' ' : c; } else out += c;
  }
  return out;
}
function argumentsOf(s: string): string[] {
  const parts: string[] = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(s.slice(start).trim()); return parts;
}
export function sourceFacts(source: string): SourceFacts {
  const code = mask(source, false), bare = mask(source, true), calls: SourceCall[] = [], channels = new Set<string>();
  const re = /\b(alertcondition|alert|plotshape|plotchar|plot|label\.new|strategy\.(?:entry|order|exit|close|close_all)|request\.(?:security|security_lower_tf|financial|economic|seed))\s*\(/g;
  const dependencies: string[] = [];
  for (const m of bare.matchAll(re)) {
    const start = m.index!, open = start + m[0].length - 1; let end = open + 1, depth = 1;
    for (; end < bare.length && depth; end++) { if (bare[end] === '(') depth++; else if (bare[end] === ')') depth--; }
    const args = argumentsOf(code.slice(open + 1, end - 1));
    const name = m[1], title = args.find(a => /^title\s*=/.test(a))?.replace(/^title\s*=\s*/, '') ?? (name === 'alertcondition' ? args[1] : /^(plot|plotshape|plotchar)$/.test(name) ? args[1] : name.startsWith('strategy.') ? args[0] : '');
    const condition = args.find(a => /^(condition|series)\s*=/.test(a))?.replace(/^(condition|series)\s*=\s*/, '') ?? args[0] ?? '';
    if (name.startsWith('request.')) dependencies.push(`${name}(${args.slice(0, 2).join(', ')})`.slice(0, 200));
    else {
      channels.add(name.startsWith('strategy.') ? 'strategy' : name === 'plotshape' || name === 'plotchar' ? 'shape' : name === 'label.new' ? 'label' : name);
      calls.push({ name, line: source.slice(0, start).split('\n').length, condition: condition.slice(0, 240), title: (title ?? '').slice(0, 160), code: code.slice(start, end).replace(/\s+/g, ' ').slice(0, 360) });
    }
  }
  const cautions: string[] = [];
  if (/\bbarmerge\.lookahead_on\b/.test(bare)) cautions.push('Uses lookahead_on: inspect offsets and prefix stability before relying on signals.');
  if (/\bta\.pivot(?:high|low)\s*\(/.test(bare)) cautions.push('Uses confirmed pivots: drawings may be anchored before the signal became knowable.');
  if (/\bbarstate\.is(?:last|realtime)\b/.test(bare)) cautions.push('Has last-bar or realtime branches: historical output may differ from live output.');
  if (dependencies.length) cautions.push('Requests additional data: verify symbol, timeframe and availability.');
  return { lines: source.split('\n').length, channels: [...channels], inputs: [...bare.matchAll(/\binput(?:\.\w+)?\s*\(/g)].length,
    calls: calls.slice(0, 60), totalCalls: calls.length, dependencies: [...new Set(dependencies)].slice(0, 20), cautions, strategy: /\bstrategy\s*\(/.test(bare) };
}
