/**
 * Import published TradingView scripts into scripts/pine + scripts/manifest.json.
 * Usage: node src/cli/import-scripts.ts <author> <list.json>   (list: [[name, urlOrSlug], ...])
 * Only open-source scripts have retrievable source (via TradingView's pine-facade).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PINE_DIR, SCRIPTS_DIR } from '../config.ts';

const [author, listFile] = process.argv.slice(2);
if (!author || !listFile) { console.error('usage: import-scripts <author> <list.json>'); process.exit(1); }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';
type Item = { name: string; url: string; pub?: string | null; access?: string | null; type?: string | null; updated?: string | null };
const rawList: any[] = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const list: Item[] = rawList.map((x) => (Array.isArray(x) ? { name: x[0], url: x[1] } : x));
const manifestFile = path.join(SCRIPTS_DIR, 'manifest.json');
const manifest: any[] = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const known = new Set(manifest.map(m => m.file));
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const ids = new Set(manifest.map(m => m.id));
let added = 0, skipped = 0, errors = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

for (const item of list) {
  const url = item.url.startsWith('http') ? item.url : `https://in.tradingview.com/script/${item.url}`;
  const slug = decodeURIComponent(url.replace(/\/$/, '').split('/').pop()!);
  const file = `${slug}.pine`;
  if (known.has(file)) { skipped++; continue; }
  const name = item.name.replace(/\s*\[.*?\]\s*$/, '').replace(/^LuxAlgo® - /, '').trim();
  try {
    // TradingView API `script_access`: 1 = open-source, 2 = protected, 3 = invite-only
    const ACCESS: Record<string, string> = { '1': 'Open-source script', '2': 'Protected script', '3': 'Invite-only script', open: 'Open-source script', closed: 'Protected script', invite_only: 'Invite-only script' };
    let pub = item.pub ?? null; let access: string | null = item.access != null ? (ACCESS[String(item.access)] ?? String(item.access)) : null;
    if (!pub) {
      const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
      pub = (html.match(/"script_id_part":"(PUB;[0-9A-Za-z]+)"/) ?? [])[1] ?? null;
      access = (html.match(/(Open-source script|Protected script|Invite-only script)/) ?? [])[1] ?? null;
    }
    const m = pub ? [pub, pub] : null;
    let source = '';
    if (m && (access === 'Open-source script' || access === null)) {
      const fu = `https://pine-facade.tradingview.com/pine-facade/get/${m[1].replace(';', '%3B')}/last?no_4xx=true`;
      const d: any = await (await fetch(fu, { headers: { 'User-Agent': UA } })).json();
      source = String(d?.source ?? '');
    }
    let id = slugify(name); if (ids.has(id)) id = `${id}-${slugify(author)}`; if (ids.has(id)) id = `${id}-${slug.slice(0, 8).toLowerCase()}`;
    ids.add(id);
    const version = (source.match(/\/\/@version=(\d+)/) ?? [])[1] ?? null;
    if (source.length > 100) fs.writeFileSync(path.join(PINE_DIR, file), source);
    manifest.push({
      id, name, author, file, url, pub: m ? m[1] : null, access, pineVersion: version, lines: source ? source.split('\n').length : null, updated: item.updated ?? null, scriptType: item.type ?? null,
      status: source.length > 100 ? 'ok' : 'unavailable', reason: source.length > 100 ? null : `${access ?? 'Unknown access'} on TradingView: source not published`, overlay: true,
    });
    known.add(file); added++;
    if (added % 25 === 0) { fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1)); console.log(`… ${added} added, ${errors} errors`); }
    await sleep(250);
  } catch (e: any) {
    errors++; console.log('ERR', name, e?.message ?? e);
  }
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
console.log(`done: ${added} added, ${skipped} already present, ${errors} errors; manifest now ${manifest.length} scripts`);
