#!/usr/bin/env node
/**
 * A second scanner list, running in the paper account beside the current one (decision 325).
 *
 * Each cell in the list becomes an explicit operator allocation, exactly what the Scanners page does and what promotion does
 * for a proposal: the scanner is enabled and un-hidden, and the cell is added to its pairs (a legacy symbol list is converted
 * to explicit pairs first, so nothing already running is dropped). The scanner's reading, exit mode and inputs are untouched.
 * Position sizing, the entry gates and the risk limits are the account's own. Nothing else changes.
 *
 *   node ops/enable-fleet-b.ts             dry run: validates and prints what would change, writes nothing
 *   node ops/enable-fleet-b.ts --apply     backs up config.json, applies, writes data/<fleet>.json so it can be undone and scored
 *   node ops/enable-fleet-b.ts --release   removes exactly the cells it added and restores what it enabled or un-hid
 *
 * Run with the service stopped, then start it: the incubator reads the new allocations as live cells at start. Paper mode only.
 * VNEDGE_CONFIG, VNEDGE_DB and FLEET_CELLS override the config, database and list paths.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConfigStore, TF_SECONDS, type ScannerConfig } from '../server/src/config.ts';
import { requireFleetMaintenance, commitFleetConfig, assertPaper } from './fleet-maintenance.ts';
import { scannerPairs } from '../server/src/scanners/allocation.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CELLS = path.join(ROOT, 'docs', 'research', 'fleet-b-2026-11-21', 'cells.json');

export interface FleetCell { scannerId: string; symbol: string; tf: string }
export interface FleetDef { id: string; cells: FleetCell[] }
type Pair = { symbol: string; tf: string };
export interface FleetMarker {
  id: string;
  appliedAt: number;
  /** The cells this run added (not those that were already allocated). */
  added: FleetCell[];
  /** Each touched scanner's stored entry before the run, or null when it had none, so a release can restore it. */
  before: Record<string, Partial<ScannerConfig> | null>;
  /** Exact written scanner snapshots; a release refuses subsequent operator edits. */
  after: Record<string, Partial<ScannerConfig>>;
  version: 2;
  state: 'prepared'|'applied';
}
export interface FleetOptions {
  configFile: string;
  cellsFile?: string;
  dbFile?: string | null;
  manifestFile?: string;
  apply?: boolean;
  now?: number;
}

const key = (c: Pair) => `${c.symbol}|${c.tf}`;
const markerPath = (configFile: string, id: string) => path.join(path.dirname(configFile), `${id}.json`);

export function readFleet(file: string): FleetDef {
  const def = JSON.parse(fs.readFileSync(file, 'utf8')) as FleetDef;
  if (!/^[a-z0-9-]{2,40}$/.test(def.id ?? '')) throw new Error('fleet id: 2–40 lowercase letters, digits or dashes');
  if (!Array.isArray(def.cells) || def.cells.length < 1 || def.cells.length > 40) throw new Error('a fleet needs 1 to 40 cells');
  const seen = new Set<string>();
  for (const c of def.cells) {
    if (![c?.scannerId, c?.symbol, c?.tf].every((v) => typeof v === 'string' && v.trim())) throw new Error('every cell needs scannerId, symbol and tf');
    const k = `${c.scannerId}|${key(c)}`;
    if (seen.has(k)) throw new Error(`duplicate cell ${k}`);
    seen.add(k);
  }
  return def;
}

/** Why a cell cannot be allocated, or null. */
function refusal(c: FleetCell, manifest: Set<string>, quarantined: Set<string>): string | null {
  if (TF_SECONDS[c.tf] === undefined) return `unknown timeframe ${c.tf}`;
  if (!/^[A-Z0-9]+USDT?$/.test(c.symbol)) return `unrecognised market ${c.symbol}`;
  if (!manifest.has(c.scannerId)) return 'not in the script library (or removed from it)';
  if (quarantined.has(c.scannerId)) return 'the script is quarantined';
  return null;
}

function manifestIds(file: string): Set<string> {
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string; removed?: boolean }>;
  return new Set(list.filter((s) => !s.removed).map((s) => s.id));
}
function quarantinedIds(dbFile: string | null | undefined): Set<string> {
  if (!dbFile || !fs.existsSync(dbFile)) throw new Error('quarantine state unavailable: an existing database is required');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try { return new Set((db.prepare('SELECT scanner_id FROM script_health WHERE quarantined=1').all() as Array<{ scanner_id: string }>).map((r) => r.scanner_id)); }
  catch { throw new Error('quarantine state unavailable: cannot read script_health'); }
  finally { db.close(); }
}

/** The same allocation for every scanner, computed against the store it is given. */
function allocate(store: ConfigStore, byScanner: Map<string, FleetCell[]>) {
  const done: Array<{ scannerId: string; before: Pair[]; after: Pair[]; added: FleetCell[]; wasEnabled: boolean; wasHidden: boolean }> = [];
  for (const [scannerId, cells] of byScanner) {
    const cfg = store.get();
    const sc = cfg.scanners[scannerId];
    // an enabled scanner keeps what it runs; a disabled or hidden one starts from nothing (the dashboard and promotion do the same)
    const existing = sc?.enabled && !sc.hidden ? scannerPairs(sc, cfg.timeframes) : [];
    const have = new Set(existing.map(key));
    const added = cells.filter((c) => !have.has(key(c)));
    if (!added.length) continue;
    const after = [...existing, ...added.map(({ symbol, tf }) => ({ symbol, tf }))];
    store.setScanner(scannerId, { enabled: true, hidden: false, pairs: after });
    done.push({ scannerId, before: existing, after, added, wasEnabled: Boolean(sc?.enabled), wasHidden: Boolean(sc?.hidden) });
  }
  return done;
}

export function enableFleet(o: FleetOptions) {
  const now = o.now ?? Date.now();
  const def = readFleet(o.cellsFile ?? DEFAULT_CELLS);
  const before = fs.readFileSync(o.configFile, 'utf8');
  const raw = JSON.parse(before) as { scanners?: Record<string, Partial<ScannerConfig>> };
  const real = new ConfigStore(o.configFile);
  assertPaper(real.get());
  const marker = markerPath(o.configFile, def.id);
  if (fs.existsSync(marker)) throw new Error(`${def.id} is already applied (${path.basename(marker)} exists); release it first`);

  const manifest = manifestIds(o.manifestFile ?? path.join(ROOT, 'scripts', 'manifest.json'));
  const quarantined = quarantinedIds(o.dbFile);
  const refused: Array<FleetCell & { reason: string }> = [];
  const byScanner = new Map<string, FleetCell[]>();
  for (const c of def.cells) {
    const reason = refusal(c, manifest, quarantined);
    if (reason) { refused.push({ ...c, reason }); continue; }
    (byScanner.get(c.scannerId) ?? byScanner.set(c.scannerId, []).get(c.scannerId)!).push(c);
  }
  if (refused.length) throw new Error(`refused, nothing written: ${refused.map((r) => `${r.scannerId} ${r.symbol} ${r.tf}: ${r.reason}`).join('; ')}`);

  // the whole change is first made on a copy: any validation or fleet-cap error stops here, before the real file is touched
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-b-'));
  let planned;
  let after: string;
  try {
    const copy = path.join(dir, 'config.json');
    fs.writeFileSync(copy, before, { mode: 0o600 });
    planned = allocate(new ConfigStore(copy), byScanner);
    const staged = JSON.parse(fs.readFileSync(copy, 'utf8'));
    // Persist only this operation's scanner edits, not defaults or unrelated specs.
    const scanners = { ...raw.scanners };
    for (const p of planned) scanners[p.scannerId] = staged.scanners[p.scannerId];
    after = JSON.stringify({ ...raw, scanners }, null, 2) + '\n';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const summary = planned.map((p) => ({
    scannerId: p.scannerId, enabledBefore: p.wasEnabled, hiddenBefore: p.wasHidden,
    pairsBefore: p.before.length, pairsAfter: p.after.length, added: p.added.map((c) => `${c.symbol} ${c.tf}`),
    unhides: p.wasHidden, enables: !p.wasEnabled,
  }));
  const alreadyAllocated = def.cells.length - planned.reduce((n, p) => n + p.added.length, 0);
  const result = { fleet: def.id, dryRun: !o.apply, cells: def.cells.length, willAdd: planned.reduce((n, p) => n + p.added.length, 0), alreadyAllocated, scanners: summary };
  if (!o.apply || !planned.length) return result;

  const afterRaw = JSON.parse(after);
  const mark: FleetMarker = {
    version: 2, state: 'prepared', id: def.id, appliedAt: now, added: planned.flatMap((p) => p.added),
    before: Object.fromEntries(planned.map((p) => [p.scannerId, raw.scanners?.[p.scannerId] ?? null])),
    after: Object.fromEntries(planned.map((p) => [p.scannerId, afterRaw.scanners[p.scannerId]])),
  };
  const backup = commitFleetConfig(o.configFile, before, after, `${def.id}-${now}`, () => {
    // Durable intent precedes the single atomic config replace. If replacement fails,
    // release can recognize the unchanged prior snapshot and retire this marker.
    fs.writeFileSync(marker, JSON.stringify(mark, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(marker, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  // A prepared marker is recoverable but never scoreable. Mark success only
  // after the config rename is durable; interrupted finalization requires review/release.
  const finished = `${marker}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(finished, JSON.stringify({...mark,state:'applied'},null,2)+'\n', {mode:0o600,flag:'wx'});
    const fd=fs.openSync(finished,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(finished,marker);
    const dir=fs.openSync(path.dirname(marker),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  } finally { fs.rmSync(finished,{force:true}); }
  return { ...result, dryRun: false, backup, marker };
}

/** Release only unchanged fleet-owned scanner entries. Preserve every unrelated setting. */
export function releaseFleet(o: { configFile: string; fleetId?: string; apply?: boolean; now?: number }) {
  const now = o.now ?? Date.now();
  const id = o.fleetId ?? readFleet(DEFAULT_CELLS).id;
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw new Error('invalid fleet id');
  const before = fs.readFileSync(o.configFile, 'utf8');
  assertPaper(new ConfigStore(o.configFile).get());
  const file = markerPath(o.configFile, id);
  if (!fs.existsSync(file)) throw new Error(`${id} is not applied (no ${path.basename(file)})`);
  const mark = JSON.parse(fs.readFileSync(file, 'utf8')) as FleetMarker;
  if (mark.version !== 2 || mark.id !== id || !mark.before || !mark.after) throw new Error('fleet marker lacks reversible snapshots; manual review required');
  const raw = JSON.parse(before);
  const scanners = { ...raw.scanners };
  const touched = Object.keys(mark.after);
  for (const scannerId of touched) {
    const cur = scanners[scannerId] ?? null;
    const prior = mark.before[scannerId];
    if (prior === undefined) throw new Error('incomplete fleet marker');
    // Also handles a crash after the intent/backup was written but before config commit,
    // or after config restoration and before marker retirement.
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!equal(cur, mark.after[scannerId]) && !equal(cur, prior))
      throw new Error(`scanner ${scannerId} changed since fleet allocation; nothing written`);
    if (prior === null) delete scanners[scannerId];
    else scanners[scannerId] = prior;
  }
  if (!o.apply) return { fleet: id, dryRun: true, cells: mark.added.length, scanners: touched.length };
  const after = JSON.stringify({ ...raw, scanners }, null, 2) + '\n';
  const backup = commitFleetConfig(o.configFile, before, after, `release-${id}-${now}`);
  fs.renameSync(file, `${file}.released-${now}`);
  return { fleet: id, dryRun: false, backup, scanners: touched };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configFile = process.env.VNEDGE_CONFIG ?? path.join(ROOT, 'data', 'config.json');
  const dbFile = process.env.VNEDGE_DB ?? path.join(path.dirname(configFile), 'vnedge.db');
  const apply = process.argv.includes('--apply');
  if (apply) requireFleetMaintenance();
  const out = process.argv.includes('--release')
    ? releaseFleet({ configFile, apply, fleetId: readFleet(process.env.FLEET_CELLS ?? DEFAULT_CELLS).id })
    : enableFleet({ configFile, dbFile, apply, cellsFile: process.env.FLEET_CELLS ?? DEFAULT_CELLS });
  console.log(JSON.stringify(out, null, 2));
  if ('dryRun' in out && out.dryRun) console.log('\ndry run: nothing was written. Add --apply (service stopped) to apply.');
}
