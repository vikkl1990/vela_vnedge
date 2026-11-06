import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryResolver } from '../src/chart/libraryResolver.ts';
import { LOCK_PREFIX } from '../../shared/pineLibraries.ts';
const hash = 'a'.repeat(64), other = 'b'.repeat(64), path = 'TradingView/ta/7';
const pinned = (h: string | null) => `import ${path} as lib\n${LOCK_PREFIX}${JSON.stringify({[path]:h})}`;

test('chart requests the pinned version and shares concurrent exact-source fetches', async () => {
  let calls = 0;
  const resolver = createLibraryResolver(()=>[pinned(hash)],async (p,h)=>{calls++;assert.equal(p,path);assert.equal(h,hash);return {path:p,sha256:h,source:'library("ta")'};});
  assert.deepEqual(await Promise.all([resolver(path),resolver(path)]),['library("ta")','library("ta")']);
  assert.equal(calls,1);
});

test('chart rejects absent, historical conflicts and wrong-response pins; failures can retry', async () => {
  let sources = [pinned(hash)], bad = true, calls = 0;
  const resolver = createLibraryResolver(()=>sources,async()=>{calls++;return {path,sha256:bad?other:hash,source:'ok'};});
  await assert.rejects(resolver(path),/response mismatch/); bad=false;assert.equal(await resolver(path),'ok');assert.equal(calls,2);
  sources=[pinned(hash),pinned(other)];await assert.rejects(resolver(path),/conflicting/);
  sources=[pinned(null)];await assert.rejects(resolver(path),/missing/);
  sources=[`import ${path} as lib`];await assert.rejects(resolver(path),/require a pinned/);
  assert.equal(calls,2);
});
