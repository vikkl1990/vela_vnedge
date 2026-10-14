import { test } from 'node:test';
import assert from 'node:assert/strict';


test('the overlay flag comes from the script declaration, not the manifest', async () => {
  const { declaredOverlay } = await import('./registry.ts');
  assert.equal(declaredOverlay('//@version=6\nindicator("AI Predictive Flow (Zeiierman)", overlay = false)\nplot(close)'), false);
  assert.equal(declaredOverlay('//@version=5\nindicator(title="X", shorttitle="x", overlay=true, max_lines_count=500)'), true);
  assert.equal(declaredOverlay('//@version=5\nstrategy("Y",\n  overlay = true,\n  pyramiding = 1)'), true);
  assert.equal(declaredOverlay('//@version=5\nindicator("Z")'), null, 'no declaration: the manifest decides');
});
