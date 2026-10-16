import { test } from 'node:test';
import assert from 'node:assert/strict';


test('the static handler serves only files inside the dist directory, not a sibling with the same prefix', async () => {
  const { insideDir } = await import('./server.ts');
  const path = await import('node:path');
  const dist = path.join('/opt', 'vnedge', 'dashboard', 'dist');
  assert.equal(insideDir(path.join(dist, 'index.html'), dist), true);
  assert.equal(insideDir(dist, dist), true);
  assert.equal(insideDir(path.join('/opt', 'vnedge', 'dashboard', 'dist-backup', 'x'), dist), false);
  assert.equal(insideDir(path.join('/opt', 'vnedge', 'dashboard', 'dist_secret'), dist), false);
});
