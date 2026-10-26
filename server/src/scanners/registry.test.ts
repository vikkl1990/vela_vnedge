import { test } from 'node:test';
import assert from 'node:assert/strict';


test('the overlay flag comes from the script declaration, not the manifest', async () => {
  const { declaredOverlay } = await import('./registry.ts');
  assert.equal(declaredOverlay('//@version=6\nindicator("AI Predictive Flow (Zeiierman)", overlay = false)\nplot(close)'), false);
  assert.equal(declaredOverlay('//@version=5\nindicator(title="X", shorttitle="x", overlay=true, max_lines_count=500)'), true);
  assert.equal(declaredOverlay('//@version=5\nstrategy("Y",\n  overlay = true,\n  pyramiding = 1)'), true);
  assert.equal(declaredOverlay('//@version=5\nindicator("Z")'), null, 'no declaration: the manifest decides');
});

test('retired catalogue entries stay absent and duplicate canonical scanners remain available', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { SCRIPTS_DIR, PINE_DIR } = await import('../config.ts');
  const { ScannerRegistry, loadVariants } = await import('./registry.ts');
  const review = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'retirements-20261027.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'manifest.json'), 'utf8')) as Array<{id:string;file:string;status:string;reason:string}>;
  const byId = new Map(manifest.map(s => [s.id, s]));
  const registry = new ScannerRegistry();
  for (const retired of review.retired) {
    const row = byId.get(retired.id)!;
    assert.equal(row.status, 'removed', retired.id);
    assert.match(row.reason, /Retired 2026-10-27/);
    assert.equal(registry.get(retired.id), undefined, retired.id);
    if (retired.canonicalId) {
      const canonical = registry.get(retired.canonicalId);
      assert.ok(canonical, `duplicate keeper ${retired.canonicalId}`);
      assert.equal(crypto.createHash('sha256').update(canonical.source).digest('hex'), retired.sourceSha256);
    }
  }
  for (const file of review.deletedFiles) {
    assert.equal(fs.existsSync(path.join(PINE_DIR, file)), false, file);
    assert.equal(manifest.some(s => s.status !== 'removed' && s.file === file), false, `no retained scanner lost ${file}`);
  }
  for (const v of loadVariants()) {
    assert.ok(registry.get(v.id), `intentional reading variant ${v.id} is retained`);
    assert.ok(registry.get(v.base), `variant base ${v.base} is retained`);
  }
});
