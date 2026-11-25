import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { MlService } from '../ml/service.ts';
import { ScannerEngine } from './engine.ts';

function closedPosition(db: Db, o: { id: number; bt?: number; entryAt: number; features?: Record<string, number> | null; pnl: number }) {
  db.run(`INSERT INTO positions(id,status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,sl,sl_original,
    realized_pnl,fees,risk_amount,exit_at,exit_price,exit_reason,fills,bt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    o.id, 'closed', 's', 'S', 'BTCUSD', '15m', 'long', 1, 0, 0.001, 100, o.entryAt, 99, 99, o.pnl + 0.1, 0.1, 1, o.entryAt + 60_000, 101, 'tp1',
    JSON.stringify({ fills: [], features: o.features ?? undefined }), o.bt ?? 0);
}

function engineFor(db: Db, ml: MlService) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  return new ScannerEngine({ db, cfgRef: () => cfg, paper: new PaperEngine(db, () => cfg), ml,
    candles: Object.assign(new EventEmitter(), { get: () => [] }) as any, pool: { stats: { queued: 0 }, run: async () => ({}) } as any,
    registry: { all: () => [], get: () => undefined } as any, rest: {} as any });
}

test('a closed account trade whose learning callback was lost is recovered from the journal exactly once', t => {
  const db = new Db(':memory:'); t.after(() => db.db.close());
  const ml = new MlService(db, () => ({}));
  closedPosition(db, { id: 1, entryAt: 1_000_000, features: { atrPct: 0.5, dir: 1 }, pnl: 2 });     // lost callback
  closedPosition(db, { id: 2, entryAt: 2_000_000, features: null, pnl: -1 });                      // no features: nothing to learn
  closedPosition(db, { id: 3, bt: -1, entryAt: 3_000_000, features: { atrPct: 0.4, dir: -1 }, pnl: 1 }); // archived book
  const count = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM ml_samples WHERE bt=0')!.n;

  const first = engineFor(db, ml);
  assert.equal(count(), 1);
  const row = db.get<any>('SELECT * FROM ml_samples WHERE bt=0')!;
  assert.equal(row.at, 1_000_000); assert.equal(row.win, 1); assert.equal(row.exit_reason, 'tp1');
  assert.ok(Math.abs(row.r - 2) < 1e-9, 'R comes from the journalled net pnl and risk');
  assert.equal(first.recoverLiveSamples(), 0, 'a second sweep finds nothing to do');

  engineFor(db, ml);   // another restart
  assert.equal(count(), 1);
});
