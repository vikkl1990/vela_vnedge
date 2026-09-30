/**
 * Keep the script library in step with the LuxAlgo Library (decision 65).
 *
 *   npm run library:sync            # import into scripts/ (the repo's library; commit afterwards)
 *   OUT=data npm run library:sync   # import into data/library/ (the machine's own overlay, read by the registry; the VM timer)
 *   DRY=1 npm run library:sync      # list what would be imported
 *
 * Reads the library's sitemap, fetches each new indicator page and takes the Pine source the page
 * embeds (MPL-2.0 for the library's own implementations, CC BY-NC-SA 4.0 for the TradingView-
 * published ones — non-commercial use only, which paper trading is). A script is new when neither
 * its TradingView id nor its library slug is in the manifest. Nothing is enabled: the daily screen
 * finds the newcomers on its own. Runs from a timer on the VM; polite to the site (one request at
 * a time, a pause between them).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, SCRIPTS_DIR } from '../config.ts';

const SITEMAP = 'https://www.luxalgo.com/server-sitemap.xml';
const UA = 'Mozilla/5.0 (compatible; VNEdge library sync)';
const OUT_ROOT = process.env.OUT === 'data' ? path.join(DATA_DIR, 'library') : SCRIPTS_DIR;
const PINE_DIR = path.join(OUT_ROOT, 'pine');
const manifestFile = path.join(OUT_ROOT, 'manifest.json');
fs.mkdirSync(PINE_DIR, { recursive: true });
/** The repo's manifest always counts as known; the overlay's own manifest is what this run extends when OUT=data. */
const repoManifest: any[] = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8'));
const manifest: any[] = OUT_ROOT === SCRIPTS_DIR ? repoManifest : (fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : []);
const knownRows = OUT_ROOT === SCRIPTS_DIR ? manifest : [...repoManifest, ...manifest];
const dry = process.env.DRY === '1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const fname = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const known = { uuids: new Set(knownRows.map(m => String(m.file).split('-', 1)[0])), slugs: new Set(knownRows.map(m => (m.url as string | undefined)?.match(/\/library\/indicator\/([^/]+)\/?$/)?.[1]).filter(Boolean) as string[]), ids: new Set(knownRows.map(m => m.id)), files: new Set(knownRows.map(m => m.file)) };

const xml = await (await fetch(SITEMAP, { headers: { 'User-Agent': UA } })).text();
const slugs = [...xml.matchAll(/<loc>https:\/\/www\.luxalgo\.com\/library\/indicator\/([^/<]+)\/<\/loc>/g)].map(m => m[1]);
const candidates = slugs.filter(s => !known.slugs.has(s));
console.log(`library: ${slugs.length} indicators · ${candidates.length} not yet matched by slug`);

let added = 0, skipped = 0, failed = 0;
for (const slug of candidates) {
  try {
    const html = await (await fetch(`https://www.luxalgo.com/library/indicator/${slug}/`, { headers: { 'User-Agent': UA } })).text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    if (!m) { failed++; continue; }
    const pp = JSON.parse(m[1])?.props?.pageProps ?? {};
    const ind = pp.indicator ?? {}; const code: string = pp.pineScriptCode ?? '';
    const uuid: string | null = ind.tradingviewUuid || null;
    if (!code || code.length < 100 || (uuid && known.uuids.has(uuid))) { skipped++; continue; }
    const name: string = ind.name || slug;
    const uid = uuid ?? `LIB${Buffer.from(slug).toString('hex').slice(0, 5).toUpperCase()}`;
    const file = `${uid}-${fname(name)}-LuxAlgo.pine`;
    let id = slugify(name); if (known.ids.has(id)) id = `${id}-luxalgo`; if (known.ids.has(id)) id = `${id}-${slug.slice(0, 12)}`;
    if (known.files.has(file) || known.ids.has(id)) { skipped++; continue; }
    const license = /Mozilla Public License/.test(code.slice(0, 400)) ? 'MPL-2.0' : /by-nc-sa/i.test(code.slice(0, 600)) ? 'CC BY-NC-SA 4.0' : null;
    console.log(`${dry ? 'would import' : 'import'} ${slug} → ${file}`);
    if (!dry) {
      fs.writeFileSync(path.join(PINE_DIR, file), code);
      manifest.push({ id, name, author: 'LuxAlgo', file, url: `https://www.luxalgo.com/library/indicator/${slug}/`, pub: null, access: 'Open-source script', pineVersion: (code.match(/\/\/@version=(\d+)/) ?? [])[1] ?? null, lines: code.split('\n').length, updated: ind.creationDateDisplayed ?? null, scriptType: /^\s*strategy\s*\(/m.test(code) ? 'strategy' : 'indicator', status: 'ok', reason: null, overlay: true, source: 'luxalgo-library', family: ind.family ?? null, license, tradingviewUuid: uuid });
      known.ids.add(id); known.files.add(file); if (uuid) known.uuids.add(uuid);
    }
    added++;
  } catch (e: any) { failed++; console.error(`${slug}: ${e?.message ?? e}`); }
  await sleep(400);
}
if (!dry && added) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
console.log(`${dry ? 'would add' : 'added'} ${added} · skipped ${skipped} · failed ${failed} · ${OUT_ROOT === SCRIPTS_DIR ? 'repo manifest' : 'overlay manifest'} ${manifest.length}`);
