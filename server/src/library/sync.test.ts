import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SourceReview, syncSources, completeSource, sourceHash, acquireSyncLock, publicText } from './sync.ts';
import type { Publication, InstalledSource } from './sync.ts';

const code = (n = 1) => `// Public source fixture: the length check must never be the only completeness test.\n//@version=6\nindicator("Example", overlay = true)\nplot(close * ${n})\n`;
const pub: Publication = { name: 'Example', author: 'Author', url: 'https://www.tradingview.com/script/Abc12345-Example/', pub: 'PUB;example', updated: '2026-11-06T00:00:00Z' };
function fixture(t: any, dry = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'pine'));
  fs.writeFileSync(path.join(dir, 'pine', 'original.pine'), code());
  const installed: InstalledSource[] = [{ id: 'original', file: 'original.pine', directory: path.join(dir, 'pine'), url: pub.url, pub: pub.pub, status: 'ok', updated: '2026-10-01T00:00:00Z' }];
  const root = path.join(dir, 'updates');
  return { dir, root, installed, review: new SourceReview(installed, root, dry, '2026-11-07T00:00:00Z') };
}
const tvRow = (p = pub) => ({ name: p.name, script_id_part: p.pub, chart_url: p.url, script_access: 1, updated_at: p.updated });
const page = (pine: unknown, preview?: unknown, uuid: string | null = null) => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { indicator: { name: 'Example', tradingviewUuid: uuid, creationDateDisplayed: '2026-11-06' }, pineScriptCode: pine, sourcePreview: preview } } })}</script>`;
const sitemap = (slugs: string[]) => slugs.map(s => `<url><loc>https://www.luxalgo.com/library/indicator/${s}/</loc></url>`).join('');

test('a compilable LuxAlgo preview and malformed completeness claims are rejected', () => {
  assert.throws(() => completeSource(code(), { shownLines: 40, totalLines: 323 }), /Incomplete/);
  for (const p of [{}, true, { shownLines: '40', totalLines: '40' }, { shownLines: 0, totalLines: 0 }, { shownLines: 50, totalLines: 40 }]) {
    assert.throws(() => completeSource(code(), p), /Incomplete/);
  }
  assert.throws(() => completeSource(code(), { shownLines: 40, totalLines: 40 }), /shorter/);
  assert.throws(() => completeSource('<html>' + 'failure'.repeat(40)), /unavailable/);
  assert.equal(completeSource(code(), { shownLines: 4, totalLines: 4 }), code());
});

test('a known publication is fetched and a revised hash is staged without touching installed source', async t => {
  const f = fixture(t), requests: string[] = [];
  const report = await syncSources({ review: f.review, authors: ['Author'], luxalgo: false, text: async url => {
    requests.push(url);
    if (url.includes('/api/v1/')) return JSON.stringify({ results: [tvRow()], next: null });
    return JSON.stringify({ scriptAccess: 'open_no_auth', source: code(2), version: '2.0', updated: pub.updated });
  } });
  assert.equal(requests.length, 2, 'known publication IDs must not skip the source check');
  assert.equal(report.candidates[0].kind, 'revision');
  assert.equal(report.candidates[0].version, '2.0');
  const candidate = report.candidates[0];
  assert.equal(fs.readFileSync(path.join(f.root, candidate.sourceFile), 'utf8'), code(2));
  assert.equal(candidate.sha256, createHash('sha256').update(code(2)).digest('hex'));
  assert.equal(fs.readFileSync(path.join(f.dir, 'pine', 'original.pine'), 'utf8'), code());
  assert.equal(fs.existsSync(path.join(f.dir, 'manifest.json')), false);
  assert.equal(report.complete, true);
});

test('known LuxAlgo slugs are rechecked and incomplete new pages never create source candidates', async t => {
  const f = fixture(t);
  f.installed[0].url = 'https://www.luxalgo.com/library/indicator/existing/'; f.installed[0].pub = null;
  const report = await syncSources({ review: f.review, authors: [], text: async url => {
    if (url.endsWith('.xml')) return sitemap(['existing', 'preview']);
    return url.includes('/existing/') ? page(code(2)) : page(code(), { shownLines: 40, totalLines: 323 });
  } });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].kind, 'revision');
  assert.equal(report.candidates[0].installedIds[0], 'original');
  assert.match(report.issues[0].reason, /40\/323/);
  assert.equal(fs.readdirSync(path.join(f.root, 'sources')).length, 1);
});

test('intentional local patches are differences, not automatic upgrades or overwrites', t => {
  const f = fixture(t);
  f.review.consider({ ...pub, updated: f.installed[0].updated }, code(2));
  const r = f.review.save(true);
  assert.equal(r.candidates[0].kind, 'local-difference');
  assert.equal(fs.readFileSync(path.join(f.dir, 'pine', 'original.pine'), 'utf8'), code());
});

test('matching any reviewed version suppresses duplicate candidates and normalizes CRLF', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'pine', 'newer.pine'), code(2).replaceAll('\n', '\r\n'));
  f.installed.push({ ...f.installed[0], id: 'reviewed-v2', file: 'newer.pine' });
  f.review.consider(pub, code(2));
  assert.equal(f.review.save(true).candidates.length, 0);
  assert.equal(f.review.counts.current, 1);
  assert.equal(sourceHash(code()), sourceHash(code().replaceAll('\n', '\r\n')));
});

test('retired publications are not fetched or resurrected', async t => {
  const f = fixture(t); f.installed[0].status = 'removed';
  const report = await syncSources({ review: f.review, authors: ['Author'], luxalgo: false, text: async url => {
    assert.match(url, /api\/v1/);
    return JSON.stringify({ results: [tvRow()], next: null });
  } });
  assert.equal(report.counts.retired, 1);
  assert.deepEqual(report.candidates, []);
});

test('new sources are staged idempotently and never enter the running registry', t => {
  const f = fixture(t), p = { ...pub, url: 'https://www.tradingview.com/script/New12345-New/', pub: 'PUB;new' };
  f.review.consider(p, code(3)); f.review.save(true);
  const next = new SourceReview(f.installed, f.root, false, '2026-11-08T00:00:00Z');
  next.consider(p, code(3)); const r = next.save(true);
  assert.equal(r.candidates.length, 1); assert.equal(r.candidates[0].kind, 'new');
  assert.equal(r.candidates[0].firstSeen, '2026-11-07T00:00:00Z');
  assert.equal(r.candidates[0].lastSeen, '2026-11-08T00:00:00Z');
  assert.equal(fs.readdirSync(path.join(f.root, 'sources')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'pine')), ['original.pine']);
});

test('a failed download preserves staged evidence and does not skip later publications', async t => {
  const f = fixture(t); f.review.consider(pub, code(2)); f.review.save(true);
  const next = new SourceReview(f.installed, f.root);
  const second = { ...pub, pub: 'PUB;second', url: 'https://www.tradingview.com/script/Second12-New/' };
  const r = await syncSources({ review: next, authors: ['Author'], luxalgo: false, text: async url => {
    if (url.includes('/api/v1/')) return JSON.stringify({ results: [tvRow(), tvRow(second)], next: null });
    if (url.includes('example')) throw new Error('network down');
    return JSON.stringify({ scriptAccess: 'open_no_auth', source: code(3) });
  } });
  assert.equal(r.complete, false); assert.equal(r.counts.failed, 1);
  assert.equal(r.candidates.length, 2); assert.equal(r.issues[0].reason, 'network down');
});

test('pagination follows next even without page_count, and duplicate rows are fetched once', async t => {
  const f = fixture(t); let sources = 0;
  await syncSources({ review: f.review, authors: ['Author'], luxalgo: false, text: async url => {
    if (url.includes('page=1&')) return JSON.stringify({ results: [], next: 'page2' });
    if (url.includes('page=2&')) return JSON.stringify({ results: [tvRow(), tvRow()], next: null });
    sources++; return JSON.stringify({ scriptAccess: 'open_no_auth', source: code() });
  } });
  assert.equal(sources, 1); assert.equal(f.review.counts.current, 1);
});

test('primary full source takes precedence over a duplicate library preview', async t => {
  const f = fixture(t);
  const r = await syncSources({ review: f.review, authors: ['Author'], text: async url => {
    if (url.includes('/api/v1/')) return JSON.stringify({ results: [tvRow()], next: null });
    if (url.includes('pine-facade')) return JSON.stringify({ scriptAccess: 'open_no_auth', source: code(2) });
    if (url.endsWith('.xml')) return sitemap(['example']);
    return page(code(), { shownLines: 40, totalLines: 323 }, 'Abc12345');
  } });
  assert.equal(r.candidates.length, 1); assert.equal(r.issues.length, 0);
});

test('dry runs do not create report, source, manifest or lock files', async t => {
  const f = fixture(t, true);
  await syncSources({ review: f.review, authors: [], text: async url => url.endsWith('.xml') ? sitemap(['new']) : page(code(2)) });
  assert.equal(fs.existsSync(f.root), false);
});

test('corrupt prior review fails closed and concurrent sync writers are rejected', t => {
  const f = fixture(t), release = acquireSyncLock(f.root);
  assert.throws(() => acquireSyncLock(f.root), /already running/);
  release(); const again = acquireSyncLock(f.root); again();
  fs.writeFileSync(path.join(f.root, 'review.json'), '{bad');
  assert.throws(() => new SourceReview(f.installed, f.root));
});

test('HTTP errors are not parsed as public source', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('not found', { status: 404 }); });
  await assert.rejects(publicText('https://example.test/source'), /HTTP 404/);
  assert.equal(calls, 1);
});
