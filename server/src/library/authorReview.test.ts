import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS_DIR, DEFAULT_CONFIG } from '../config.ts';
import { authorReview, authorReviewCatalog, type AuthorReviewCatalog, type SourceContract } from './authorReview.ts';

const source = 'indicator("test")\nplot(close)';
const sha256 = createHash('sha256').update(source).digest('hex');
const script = { id: 'test', file: 'test.pine', source, patches: [] };
function fixture(): AuthorReviewCatalog {
  return { schema: 1, generatedAt: '2026-11-14', scripts: { test: { file: 'test.pine', publication: 'pub', integrationNotes: [] } },
    sources: { 'test.pine': { sha256, reviewedAt: '2026-11-12', entries: [], notEntries: [], claims: [] } as unknown as SourceContract },
    publications: { pub: { url: 'https://www.tradingview.com/script/test/', author: 'ActualAuthor', retrievedAt: '2026-11-14', updatedAt: '2026-11-13', version: 2,
      reviewedAt: null, role: null, summary: null, requirements: null, reviewVersion: null, reviewUpdatedAt: null } } };
}

test('source changes hide obsolete entry conditions and claims; matching filenames are insufficient', () => {
  const c = fixture();
  assert.equal(authorReview(script, {}, c).sourceStatus, 'matches');
  const stale = authorReview({ ...script, source: source + '\nplot(open)' }, {}, c);
  assert.equal(stale.sourceStatus, 'changed'); assert.equal(stale.contract, null);
  const unknown = authorReview({ ...script, id: 'unknown' }, {}, c);
  assert.equal(unknown.sourceStatus, 'unreviewed'); assert.equal(unknown.contract, null);
  const alias = authorReview({ ...script, id: 'variant', variantOf: 'test' }, {}, c);
  assert.equal(alias.sourceStatus, 'matches');
  assert.equal(authorReview({ ...script, file: 'another.pine' }, {}, c).sourceStatus, 'unreviewed');
});

test('page retrieval is not author review; publication updates invalidate the current-review label', () => {
  const c = fixture();
  assert.equal(authorReview(script, {}, c).descriptionStatus, 'retrieved');
  Object.assign(c.publications.pub, { reviewedAt: '2026-11-14', reviewVersion: 2, reviewUpdatedAt: '2026-11-13' });
  assert.equal(authorReview(script, {}, c).descriptionStatus, 'reviewed');
  c.publications.pub.version = 3;
  assert.equal(authorReview(script, {}, c).descriptionStatus, 'changed');
  c.publications.pub.version = 2; c.publications.pub.updatedAt = '2026-11-14';
  assert.equal(authorReview(script, {}, c).descriptionStatus, 'changed');
  c.publications.pub.retrievedAt = null;
  assert.equal(authorReview(script, {}, c).descriptionStatus, 'unavailable');
});

test('reading inspection does not mutate scanner settings, capital, risk or evidence configuration', () => {
  const config = structuredClone(DEFAULT_CONFIG), before = JSON.stringify(config);
  const reading = config.scanners['structure-anchored-vwap'];
  const review = authorReview(script, reading, fixture());
  assert.match(review.admission, /neither enables/);
  assert.equal(JSON.stringify(config), before);
});

test('claims for another scanner reading do not leak through shared source', () => {
  const c = fixture();
  c.sources['test.pine'].claims = ['test', 'other'].map(scannerId => ({ scannerId, marker: 'Buy', problem: 'role', line: 2, evidence: 'Historical fixture' }));
  assert.deepEqual(authorReview(script, {}, c).contract!.claims.map(x => x.scannerId), ['test']);
  assert.deepEqual(authorReview({ ...script, id: 'alias', variantOf: 'test' }, {}, c).contract!.claims.map(x => x.scannerId), ['test']);
});

test('catalogue links every manifest entry, retains separate verified authors and usable entry conditions', () => {
  const c = authorReviewCatalog();
  const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as Array<{ id: string; file: string; status: string }>;
  for (const s of manifest) {
    const row = c.scripts[s.id]; assert.ok(row, s.id); assert.equal(row.file, s.file);
    if (row.publication) assert.ok(c.publications[row.publication], s.id);
    if (s.status !== 'removed') {
      const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'pine', s.file), 'utf8');
      assert.equal(authorReview({ ...s, source, patches: [] }, {}, c).sourceStatus, 'matches', `${s.id}: reconcile source changes before claiming the old conditions still apply`);
    }
  }
  for (const [file, x] of Object.entries(c.sources)) {
    assert.match(x.sha256, /^[a-f0-9]{64}$/); assert.ok(Array.isArray(x.entries), file);
    for (const e of x.entries) { assert.equal(typeof e.condition, 'string', file); assert.equal(typeof e.marker, 'string', file); }
    assert.ok(Array.isArray(x.claims), file);
  }
  const ladder = c.publications[c.scripts['rsi-volume-ladder'].publication!];
  assert.equal(ladder.author, 'wielkieef', 'the import feed is not the author');
  assert.match(c.scripts['rsi-volume-ladder'].integrationNotes.join(' '), /ignores same-direction adds/);
});
