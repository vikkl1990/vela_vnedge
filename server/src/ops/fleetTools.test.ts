import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../config.ts';
import { Db } from '../db.ts';
import { IncubatorStore } from '../incubator/store.ts';
import { scannerPairs } from '../scanners/allocation.ts';
import { enableFleet, readFleet, releaseFleet } from '../../../ops/enable-fleet-b.ts';
import { parseCell, startJudging } from '../../../ops/start-judging-tracked.ts';
import { clusteredSe, scoreTrades, type ScoredTrade } from '../../../ops/score-fleet-b.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 21);

function workdir(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (dir: string, name: string, v: unknown) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(v, null, 2)); return f; };
const cells = [
  { scannerId: 'alpha', symbol: 'AKEUSD', tf: '15m' },
  { scannerId: 'alpha', symbol: 'BLESSUSD', tf: '15m' },
  { scannerId: 'beta', symbol: 'BNBUSD', tf: '4h' },
  { scannerId: 'gamma', symbol: 'GTCUSD', tf: '15m' },
];
function setup(t: { after(fn: () => void): void }, scanners: Record<string, unknown> = {}, mode = 'paper') {
  const dir = workdir(t);
  const configFile = write(dir, 'config.json', { execution: { mode }, timeframes: ['15m'], scanners });
  const manifestFile = write(dir, 'manifest.json', [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }, { id: 'gone', removed: true }]);
  const cellsFile = write(dir, 'cells.json', { id: 'fleet-test', cells });
  return { dir, configFile, manifestFile, cellsFile, opts: { configFile, manifestFile, cellsFile, now: T0 } };
}
const pairsOf = (configFile: string, id: string) => { const s = new ConfigStore(configFile); return scannerPairs(s.get().scanners[id], s.get().timeframes).map((p) => `${p.symbol} ${p.tf}`).sort(); };

test('a dry run validates everything and writes nothing', (t) => {
  const x = setup(t, { alpha: { enabled: false, hidden: true, symbols: null, timeframes: null, exitMode: 'both' } });
  const before = fs.readFileSync(x.configFile, 'utf8');
  const r = enableFleet(x.opts);
  assert.equal(r.dryRun, true);
  assert.equal(r.willAdd, 4);
  assert.equal(r.scanners.length, 3);
  assert.equal(fs.readFileSync(x.configFile, 'utf8'), before, 'the config file is byte for byte the same');
  assert.deepEqual(fs.readdirSync(x.dir).sort(), ['cells.json', 'config.json', 'manifest.json'], 'no backup, no marker, no stray temp files');
  assert.equal(r.scanners.find((s) => s.scannerId === 'alpha')!.unhides, true);
});

test('apply allocates the cells like the dashboard does: enabled, un-hidden, existing pairs kept, a backup and a marker written', (t) => {
  const x = setup(t, {
    alpha: { enabled: false, hidden: true, symbols: null, timeframes: null, exitMode: 'both' },
    beta: { enabled: true, hidden: false, symbols: ['ETHUSD'], timeframes: ['1h'], exitMode: 'script' },
  });
  const before = fs.readFileSync(x.configFile, 'utf8');
  const r = enableFleet({ ...x.opts, apply: true });
  assert.equal(r.dryRun, false);
  assert.deepEqual(pairsOf(x.configFile, 'alpha'), ['AKEUSD 15m', 'BLESSUSD 15m']);
  assert.deepEqual(pairsOf(x.configFile, 'beta'), ['BNBUSD 4h', 'ETHUSD 1h'], 'the legacy symbol list became explicit pairs and kept ETHUSD 1h');
  assert.deepEqual(pairsOf(x.configFile, 'gamma'), ['GTCUSD 15m'], 'a scanner with no stored entry gets one');
  const cfg = new ConfigStore(x.configFile).get().scanners;
  for (const id of ['alpha', 'beta', 'gamma']) { assert.equal(cfg[id].enabled, true, id); assert.equal(cfg[id].hidden ?? false, false, id); }
  assert.equal(cfg.beta.exitMode, 'script', 'a scanner\'s own settings are untouched');
  assert.equal(fs.readFileSync((r as any).backup, 'utf8'), before, 'the backup is the file as it was');
  const marker = JSON.parse(fs.readFileSync((r as any).marker, 'utf8'));
  assert.equal(marker.added.length, 4);
  assert.equal(marker.appliedAt, T0);
  assert.deepEqual(marker.before.alpha, { enabled: false, hidden: true });
  assert.equal(marker.before.gamma, null);
  assert.throws(() => enableFleet({ ...x.opts, apply: true }), /already applied/);
});

test('a cell that is already allocated is skipped, not duplicated', (t) => {
  const x = setup(t, { alpha: { enabled: true, hidden: false, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'AKEUSD', tf: '15m' }] } });
  const r = enableFleet({ ...x.opts, apply: true });
  assert.equal(r.alreadyAllocated, 1);
  assert.equal(r.willAdd, 3);
  assert.deepEqual(pairsOf(x.configFile, 'alpha'), ['AKEUSD 15m', 'BLESSUSD 15m']);
  const marker = JSON.parse(fs.readFileSync((r as any).marker, 'utf8'));
  assert.equal(marker.added.some((c: any) => c.scannerId === 'alpha' && c.symbol === 'AKEUSD'), false, 'only what this run added can be released');
});

test('any refused cell stops the whole run before a byte is written', (t) => {
  for (const [bad, pattern] of [
    [{ scannerId: 'unknown', symbol: 'AKEUSD', tf: '15m' }, /not in the script library/],
    [{ scannerId: 'gone', symbol: 'AKEUSD', tf: '15m' }, /not in the script library/],
    [{ scannerId: 'alpha', symbol: 'AKEUSD', tf: '7m' }, /unknown timeframe/],
    [{ scannerId: 'alpha', symbol: 'ake', tf: '15m' }, /unrecognised market/],
  ] as const) {
    const x = setup(t);
    write(x.dir, 'cells.json', { id: 'fleet-test', cells: [...cells, bad] });
    const before = fs.readFileSync(x.configFile, 'utf8');
    assert.throws(() => enableFleet({ ...x.opts, apply: true }), pattern);
    assert.equal(fs.readFileSync(x.configFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(x.dir).sort(), ['cells.json', 'config.json', 'manifest.json']);
  }
});

test('a quarantined script is refused, and so is any mode other than paper', (t) => {
  const x = setup(t);
  const dbFile = path.join(x.dir, 'vnedge.db');
  const db = new Db(dbFile);
  db.db.exec('CREATE TABLE IF NOT EXISTS script_health (scanner_id TEXT PRIMARY KEY, fails INTEGER, last_at INTEGER, last_error TEXT, reason TEXT, quarantined INTEGER)');
  db.run("INSERT INTO script_health VALUES ('gamma',2,1,'x','does not transpile',1)");
  db.db.close();
  assert.throws(() => enableFleet({ ...x.opts, dbFile, apply: true }), /gamma GTCUSD 15m: the script is quarantined/);
  const live = setup(t, {}, 'testnet');
  assert.throws(() => enableFleet({ ...live.opts, apply: true }), /paper mode only/);
});

test('release removes exactly what was added and puts back what the run enabled or un-hid', (t) => {
  const x = setup(t, {
    alpha: { enabled: false, hidden: true, symbols: null, timeframes: null, exitMode: 'both' },
    beta: { enabled: true, hidden: false, symbols: null, timeframes: null, exitMode: 'both', pairs: [{ symbol: 'ETHUSD', tf: '1h' }] },
  });
  enableFleet({ ...x.opts, apply: true });
  const dry = releaseFleet({ configFile: x.configFile, fleetId: 'fleet-test' });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(pairsOf(x.configFile, 'alpha'), ['AKEUSD 15m', 'BLESSUSD 15m'], 'a dry release changes nothing');
  const r = releaseFleet({ configFile: x.configFile, fleetId: 'fleet-test', apply: true, now: T0 + 1 });
  assert.equal(r.dryRun, false);
  const cfg = new ConfigStore(x.configFile).get().scanners;
  assert.deepEqual(pairsOf(x.configFile, 'beta'), ['ETHUSD 1h'], 'the pair that was there before stays');
  assert.equal(cfg.beta.enabled, true);
  assert.deepEqual(pairsOf(x.configFile, 'alpha'), []);
  assert.equal(cfg.alpha.enabled, false);
  assert.equal(cfg.alpha.hidden, true, 'hidden again, as it was');
  assert.equal(cfg.gamma.enabled, false, 'a scanner that had no entry is switched off');
  assert.equal(fs.readdirSync(x.dir).some((f) => f === 'fleet-test.json'), false, 'the marker is retired');
  assert.equal(fs.readdirSync(x.dir).some((f) => f.startsWith('fleet-test.json.released-')), true);
  assert.throws(() => releaseFleet({ configFile: x.configFile, fleetId: 'fleet-test' }), /not applied/);
});

test('the frozen list in the repo is well formed and respects its own caps', () => {
  const def = readFleet(path.resolve(import.meta.dirname, '../../../docs/research/fleet-b-2026-11-21/cells.json'));
  assert.equal(def.id, 'fleet-b');
  assert.equal(def.cells.length, 12);
  const per = (k: 'scannerId' | 'symbol') => { const m = new Map<string, number>(); for (const c of def.cells) m.set(c[k], (m.get(c[k]) ?? 0) + 1); return Math.max(...m.values()); };
  assert.ok(per('scannerId') <= 2 && per('symbol') <= 2);
});

function seedIncubator(dir: string) {
  const file = path.join(dir, 'vnedge.db');
  const db = new Db(file);
  const store = new IncubatorStore(db);
  store.move({ scannerId: 'nexus', symbol: 'BTCUSD', tf: '15m' }, 'tracked', 'tracker', {}, 'tracker:willy', T0 - DAY);
  store.move({ scannerId: 'nexus', symbol: 'ETHUSD', tf: '15m' }, 'tracked', 'tracker', {}, 'tracker:willy', T0 - DAY);
  store.move({ scannerId: 'other', symbol: 'SOLUSD', tf: '1h' }, 'shadow', 'admit', {}, 'admitted', T0 - DAY);
  db.db.close();
  return file;
}
const stageOf = (file: string, c: string) => { const db = new Db(file); try { return new IncubatorStore(db).find(...(c.split(':') as [string, string, string]))?.stage; } finally { db.db.close(); } };

test('a tracked cell can be moved into the shadow book, and a dry run moves nothing', (t) => {
  const dir = workdir(t), dbFile = seedIncubator(dir);
  const cell = parseCell('nexus:BTCUSD:15m');
  const dry = startJudging({ dbFile, cells: [cell], now: T0 });
  assert.equal(dry.dryRun, true);
  assert.equal(stageOf(dbFile, 'nexus:BTCUSD:15m'), 'tracked');
  const r = startJudging({ dbFile, cells: [cell], apply: true, now: T0 });
  assert.equal(r.dryRun, false);
  assert.equal(stageOf(dbFile, 'nexus:BTCUSD:15m'), 'shadow');
  assert.equal(stageOf(dbFile, 'nexus:ETHUSD:15m'), 'tracked', 'only the chosen cell moved');
  const db = new Db(dbFile);
  try {
    const ev = db.all<any>("SELECT from_stage, to_stage, actor FROM incubator_events WHERE scanner_id='nexus' AND symbol='BTCUSD' ORDER BY id DESC LIMIT 1")[0];
    assert.deepEqual({ from: ev.from_stage, to: ev.to_stage, actor: ev.actor }, { from: 'tracked', to: 'shadow', actor: 'operator' });
    assert.equal(new IncubatorStore(db).find('nexus', 'BTCUSD', '15m')!.since, T0, 'the judging window starts at the move');
  } finally { db.db.close(); }
});

test('a cell that is not tracked, or does not exist, refuses the whole move', (t) => {
  const dir = workdir(t), dbFile = seedIncubator(dir);
  for (const bad of ['other:SOLUSD:1h', 'nope:BTCUSD:15m']) {
    assert.throws(() => startJudging({ dbFile, cells: [parseCell('nexus:BTCUSD:15m'), parseCell(bad)], apply: true }), /refused, nothing written/);
    assert.equal(stageOf(dbFile, 'nexus:BTCUSD:15m'), 'tracked', 'the good cell did not move either');
  }
  assert.throws(() => parseCell('only-two:parts'), /expected scanner:SYMBOL:tf/);
  assert.throws(() => startJudging({ dbFile, cells: [] }), /1 to 20 cells/);
});

const tr = (o: Partial<ScoredTrade>): ScoredTrade => ({ sc: 'alpha', sym: 'AKEUSD', tf: '15m', side: 'long', at: T0, exitAt: T0 + 3_600_000, r: 0, ...o });

test('the score is excess R against same-side same-timeframe shadow, over the same days only', () => {
  const shadow = [tr({ r: -0.2, side: 'long' }), tr({ r: -0.2, side: 'long' }), tr({ r: 0.1, side: 'short' })];
  const account = [tr({ r: 0.3, side: 'long' }), tr({ sc: 'zzz', r: -0.2, side: 'long' }), tr({ at: T0 - DAY, r: 5 })];
  const s = scoreTrades(account, shadow, [{ scannerId: 'alpha', symbol: 'AKEUSD', tf: '15m' }], T0, T0 + DAY);
  assert.equal(s.fleet.trades, 1);
  assert.ok(Math.abs(s.fleet.excessR - 0.5) < 1e-12, 'a +0.3R long against a -0.2R long baseline');
  assert.equal(s.rest.trades, 1);
  assert.ok(Math.abs(s.rest.excessR - 0) < 1e-12);
  assert.equal(s.fleet.trades + s.rest.trades, 2, 'a trade opened before the fleet went in is not counted');
});

test('no verdict before 14 days and 60 fleet trades; then the interval decides', () => {
  const cell = [{ scannerId: 'alpha', symbol: 'AKEUSD', tf: '15m' }];
  const mk = (n: number, fleetR: number, restR: number) => [
    ...Array.from({ length: n }, (_, i) => tr({ r: fleetR + (i % 2 ? 0.02 : -0.02), exitAt: T0 + (i % 20) * DAY })),
    ...Array.from({ length: n }, (_, i) => tr({ sc: 'rest', r: restR + (i % 2 ? 0.02 : -0.02), exitAt: T0 + (i % 20) * DAY })),
  ];
  const shadow = [tr({ r: 0 })];
  assert.match(scoreTrades(mk(80, 0.3, 0), shadow, cell, T0, T0 + 5 * DAY).verdict, /^too early: 5\.0\/14 days/);
  assert.match(scoreTrades(mk(30, 0.3, 0), shadow, cell, T0, T0 + 30 * DAY).verdict, /^too early: 30\.0\/14 days, 30\/60 fleet trades/);
  assert.match(scoreTrades(mk(80, 0.3, 0), shadow, cell, T0, T0 + 30 * DAY).verdict, /ahead of the rest/);
  assert.match(scoreTrades(mk(80, 0, 0.3), shadow, cell, T0, T0 + 30 * DAY).verdict, /behind the rest/);
  assert.match(scoreTrades(mk(80, 0.01, 0), shadow, cell, T0, T0 + 30 * DAY).verdict, /^no difference detected|ahead|behind/);
});

test('the clustered error needs at least two closing days and grows when trades on one day agree', () => {
  assert.equal(clusteredSe([{ x: 1, exitAt: T0 }, { x: 2, exitAt: T0 + 1000 }]), null, 'one day: no interval');
  const mixed = clusteredSe([{ x: 1, exitAt: T0 }, { x: -1, exitAt: T0 }, { x: 1, exitAt: T0 + DAY }, { x: -1, exitAt: T0 + DAY }]);
  const agree = clusteredSe([{ x: 1, exitAt: T0 }, { x: 1, exitAt: T0 }, { x: -1, exitAt: T0 + DAY }, { x: -1, exitAt: T0 + DAY }]);
  assert.equal(mixed, 0);
  assert.ok(Math.abs(agree! - Math.SQRT1_2) < 1e-12, 'day sums of +2 and -2: sqrt(8)/4, where four independent trades of the same size would give 0.5');
});
