/**
 * Read every Pine source in scripts/pine against the bot's reading of it and propose corrections.
 * Reads files only: no market data, no database, no script is run.
 *
 *   npm run script-audit                         # every usable script, with the readings in scripts/specs.json
 *   CONFIG=/path/config.json npm run script-audit   # also apply a config's scanner readings and mark enabled scanners
 *   IDS=ids.txt OUT=audit.json MD=audit.md npm run script-audit
 *
 * A static read proposes; it does not decide. Each finding names the source line so a person can confirm it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SCRIPTS_DIR } from '../config.ts';
import { readingLegacy } from '../scanners/legacy.ts';
import { auditScript, type Correction, type Reading, type ScriptAudit } from '../scanners/scriptAudit.ts';

interface ManifestEntry { id: string; name: string; file: string; status: string }
const json = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const manifest: ManifestEntry[] = json(path.join(SCRIPTS_DIR, 'manifest.json'));
const specs: Record<string, unknown> = json(path.join(SCRIPTS_DIR, 'specs.json'));
const variants: Array<{ id: string; base: string; name: string }> = fs.existsSync(path.join(SCRIPTS_DIR, 'variants.json')) ? json(path.join(SCRIPTS_DIR, 'variants.json')) : [];
const config = process.env.CONFIG ? json(process.env.CONFIG) : null;
const only = process.env.IDS ? new Set(fs.readFileSync(process.env.IDS, 'utf8').split(/\s+/).filter(Boolean)) : null;
const legacy = readingLegacy();
const skipScriptStops = Boolean(config?.paper?.skipScriptStops);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
function readingFor(id: string): { reading: Reading; specified: boolean; enabled: boolean } {
  const spec = obj(specs[id]), live = obj(config?.scanners?.[id]);
  const merged = { ...spec, ...live } as Reading;
  return { reading: { sources: merged.sources, labels: merged.labels, sides: merged.sides, entryProtection: merged.entryProtection, inputs: merged.inputs, legacy: legacy.has(id) },
    specified: Object.keys(spec).length > 0, enabled: live.enabled === true };
}

interface Row extends ScriptAudit { id: string; name: string; file: string; specified: boolean; enabled: boolean }
const byId = new Map(manifest.map(e => [e.id, e]));
const targets = [...manifest.filter(e => e.status === 'ok').map(e => ({ id: e.id, name: e.name, file: e.file })),
  ...variants.map(v => ({ id: v.id, name: v.name, file: byId.get(v.base)?.file ?? '' }))].filter(t => t.file && (!only || only.has(t.id)));
const rows: Row[] = [];
let unreadable = 0;
for (const t of targets) {
  let source: string;
  try { source = fs.readFileSync(path.join(SCRIPTS_DIR, 'pine', t.file), 'utf8'); } catch { unreadable++; continue; }
  const { reading, specified, enabled } = readingFor(t.id);
  rows.push({ id: t.id, name: t.name, file: t.file, specified, enabled, ...auditScript(source, reading, { skipScriptStops }) });
}

const out = process.env.OUT ?? path.join(DATA_DIR, 'research', 'script-audit.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), scripts: rows.length, unreadable, skipScriptStops, rows }));

const LABEL: Record<Correction['code'], string> = {
  'side-against-drawing': 'A marker is traded on the side opposite to its drawing', 'side-dropped': 'One side of a mirrored pair is not traded',
  'not-an-entry': 'A traded title reads like a state change or information', 'own-stop-discarded': "The script's own stop is sent and discarded",
  'levels-plotted-unread': 'Own stop or targets are plotted and unread', 'levels-not-exported': 'Own stop or targets exist only in variables or drawings',
  'alerts-off-by-default': 'Alert switches default to off', 'late-pivot': 'Pivots confirm ten or more bars late', 'lookahead': 'Higher-timeframe data can look ahead',
  'no-entry-read': 'Nothing reads as an entry',
};
const count = (rs: Row[], code: Correction['code']) => rs.filter(r => r.corrections.some(c => c.code === code)).length;
const table = (title: string, rs: Row[]) => [`### ${title} (${rs.length} scripts)`, '', '| Finding | Scripts |', '|---|---|',
  ...(Object.keys(LABEL) as Correction['code'][]).map(c => `| ${LABEL[c]} | ${count(rs, c)} |`), ''];
const detail = (rs: Row[]) => rs.flatMap(r => r.corrections.length ? [`**${r.name}** (\`${r.id}\`, ${r.lines} lines)`, '',
  ...r.corrections.map(c => `- ${c.severity}, ${c.code}${c.line ? `, line ${c.line}` : ''}: ${c.finding} ${c.proposal}`), ''] : []);
const md = [`# Script audit`, '', `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run script-audit\`. A static read of ${rows.length} Pine sources against the bot's reading of each. Findings are proposals to confirm, not changes.`, '',
  ...table('All scripts', rows), ...table('Scripts with a written reading', rows.filter(r => r.specified)),
  ...(config ? [...table('Enabled scanners', rows.filter(r => r.enabled)), '## Enabled scanners, finding by finding', '', ...detail(rows.filter(r => r.enabled))] : []),
  '## Readings that contradict the source', '', ...detail(rows.filter(r => r.corrections.some(c => c.severity === 'high')).map(r => ({ ...r, corrections: r.corrections.filter(c => c.severity === 'high') })).slice(0, 80)),
].join('\n');
if (process.env.MD) fs.writeFileSync(process.env.MD, md + '\n');
console.log(md.split('\n').slice(0, 44).join('\n'));
console.log(`\n${rows.length} scripts read, ${unreadable} unreadable. Full results: ${out}${process.env.MD ? `, summary: ${process.env.MD}` : ''}`);
