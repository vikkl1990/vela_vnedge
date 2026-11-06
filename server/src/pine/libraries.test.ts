import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PineLibraries, pineLibraries } from './libraries.ts';
import { readLibraryLock, LOCK_PREFIX } from '../../../shared/pineLibraries.ts';
import { PinePool } from './pool.ts';

function fixture(t: any, sources: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pine-libraries-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entries = Object.entries(sources).map(([key, source], i) => {
    const file = `library-${i}.pine`; fs.writeFileSync(path.join(dir, file), source);
    return { path: key, file, sha256: createHash('sha256').update(source).digest('hex'), url: 'fixture' };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(entries));
  return { dir, libraries: new PineLibraries(dir), entries };
}

test('source identity includes exact transitive imports; ordinary source stays identical', t => {
  const { libraries } = fixture(t, {'A/Root/1':'import A/Child/2 as child\nlibrary("Root")', 'A/Child/2':'library("Child")'});
  const plain = '//@version=6\nindicator("No imports")\nplot(close)';
  assert.equal(libraries.pin(plain), plain);
  const source = 'import A/Root/1 as root\n'+plain, pinned = libraries.pin(source);
  assert.deepEqual(Object.keys(readLibraryLock(pinned)), ['A/Child/2','A/Root/1']);
  assert.equal(libraries.pin(pinned), pinned);
  assert.match(libraries.resolver(pinned)('A/Child/2'), /library\("Child"\)/);
  assert.throws(() => libraries.resolver(source), /require a pinned/);
  assert.throws(() => libraries.resolver(pinned)('A/Child/1'), /outside pinned/);
});

test('missing versions, cycles, altered files and changed archived pins fail explicitly', t => {
  const { dir, libraries, entries } = fixture(t, {'A/Root/1':'library("Root")'});
  assert.throws(() => libraries.resolver(libraries.pin('import A/Root/2 as lib')), /not pinned or unavailable/);
  const old = libraries.pin('import A/Root/1 as lib').replace(entries[0].sha256, '0'.repeat(64));
  assert.equal(libraries.pin(old), old, 'never silently re-pin historical sources');
  assert.throws(() => libraries.resolver(old), /version mismatch/);
  fs.appendFileSync(path.join(dir, entries[0].file), '\n// changed');
  assert.throws(() => new PineLibraries(dir), /integrity failure/);
  const cyclic = fixture(t, {'A/Root/1':'import A/Child/2 as child', 'A/Child/2':'import A/Root/1 as root'}).libraries;
  assert.throws(() => cyclic.pin('import A/Root/1 as root'), /Circular/);
});

test('path traversal, malformed or incomplete locks cannot resolve library files', () => {
  const libraries = pineLibraries();
  assert.throws(() => libraries.get('../../config', '0'.repeat(64)), /Invalid/);
  assert.throws(() => readLibraryLock(`${LOCK_PREFIX}[]`), /Invalid/);
  assert.throws(() => readLibraryLock(`${LOCK_PREFIX}{"../ta/7":null}`), /Invalid/);
  const source = libraries.pin('import TradingView/ta/7 as lib');
  const lock = readLibraryLock(source); delete lock['TradingView/RelativeValue/2'];
  assert.throws(() => libraries.resolver(`import TradingView/ta/7 as lib\n${LOCK_PREFIX}${JSON.stringify(lock)}`), /RelativeValue/);
});

test('real scanner worker resolves each bundled ta version and matches EMA mathematics', {timeout:30_000}, async t => {
  const pool = new PinePool(1,20_000); t.after(() => pool.stop());
  const bars = Array.from({length:60}, (_,i) => ({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:10}));
  let expected = bars[0].close;
  for (const bar of bars.slice(1)) expected = 0.5*bar.close+0.5*expected;
  for (let v=7;v<=14;v++) {
    const source = pineLibraries().pin(`//@version=6\nimport TradingView/ta/${v} as lib\nindicator("Import")\nplot(lib.ema2(close,3), title="EMA")`);
    const r = await pool.run({scannerId:'library-test',source,symbol:'BTCUSD',tf:'1m',tickSize:0.5,bars,tailBars:'all',plotTail:60});
    assert.equal(r.ok,true,`ta/${v}: ${r.error}`);
    const value = r.plots.find(p=>p.title==='EMA')?.data.at(-1)?.value;
    assert.equal(typeof value,'number'); assert.ok(Math.abs(value!-expected)<1e-8, `${value} != ${expected}`);
  }
});
