import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../config.ts';

test('rejects invalid calculation settings even when split weights sum to one', () => {
  for (const paper of [{ tpSplit: [-1, 1, 1] }, { fallbackRR: [1, 0, -1] }, { slippageBps: -1 }, { slippageBps: Infinity }, { fallbackAtrSl: 0 }]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.paper, paper);
    assert.ok(validateConfig(cfg).length > 0);
  }
});

test('give-back trailing is a valid alternative to a fixed trail distance', async () => {
  const { validateConfig, DEFAULT_CONFIG } = await import('../config.ts');
  const base = structuredClone(DEFAULT_CONFIG);
  Object.assign(base.paper, { trailAfterR: 1, trailDistanceR: 0, trailGiveBackPct: 25 });
  assert.deepEqual(validateConfig(base), [], 'give-back supplies the distance');
  Object.assign(base.paper, { trailGiveBackPct: 0 });
  assert.ok(validateConfig(base).some(e => e.includes('trailDistanceR')), 'without either, the trail has no distance');
});

test('a running bot does not overwrite edits made to the config file while it runs', async () => {
  const { ConfigStore } = await import('../config.ts');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-cfg-')), 'config.json');
  const bot = new ConfigStore(file);
  bot.update({ paper: { ...bot.get().paper, trailAfterR: 1 } } as any);            // the bot's view: 1R
  // someone edits the file by hand while the bot runs
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.paper.trailAfterR = 1.5; onDisk.paper.floorAtR = 1; onDisk.paper.floorKeepR = 0.5;
  await new Promise(r => setTimeout(r, 20));                                        // a distinct mtime
  fs.writeFileSync(file, JSON.stringify(onDisk));
  // the bot then saves an unrelated scanner change
  bot.setScanner('some-scanner', { enabled: true, symbols: ['SOLUSD'] });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.paper.trailAfterR, 1.5, 'the hand edit survives');
  assert.equal(after.paper.floorAtR, 1);
  assert.deepEqual(after.scanners['some-scanner'].symbols, ['SOLUSD'], 'and the bot change is applied on top');
  assert.equal(bot.get().paper.trailAfterR, 1.5, 'the bot now runs with the edited value');
  assert.ok(!fs.readdirSync(path.dirname(file)).some(f => f.endsWith('.tmp')), 'no temp files left behind');
});
