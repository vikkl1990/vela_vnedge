import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ScannerEngine } from './engine.ts';
import type { WorkerResult } from '../pine/worker.ts';

for (const change of ['none', 'disabled', 'removed', 'reenabled', 'timeframe'] as const) {
  test(`pending 1m scanner run respects ${change} configuration`, async t => {
    const db = new Db(':memory:');
    t.after(() => db.db.close());
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.symbols = ['BTCUSD']; cfg.timeframes = ['1m'];
    cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
    // anchor to real time: the entry path rejects signals whose bar closed more than
    // paper.maxSignalAgeSec ago, and epoch-0 fixtures would read as decades stale
    const lastClose = Math.floor(Date.now() / 60_000) * 60_000;
    const bars = Array.from({ length: 60 }, (_, i) => ({ time: lastClose - (60 - i) * 60_000, open: 100, high: 101, low: 99, close: 100, volume: 100 }));
    const candles = Object.assign(new EventEmitter(), { get: () => bars });
    let finish!: (result: WorkerResult) => void;
    const pool = { stats: { queued: 0 }, run: () => new Promise<WorkerResult>(resolve => { finish = resolve; }) };
    const scanner = { id: 's', name: 'Test', status: 'ok', patched: '' };
    const paper = new PaperEngine(db, () => cfg);
    const engine = new ScannerEngine({ db, cfgRef: () => cfg, paper,
      candles: candles as any, pool: pool as any,
      registry: { all: () => [scanner] } as any,
      rest: { product: async () => ({ tick_size: '0.25', contract_value: '1' }) } as any });
    const complete = once(engine, 'scanner');
    candles.emit('closed', { symbol: 'BTCUSD', tf: '1m', bar: bars.at(-1)! });
    await setImmediate();
    assert.equal(typeof finish, 'function', '1m close must dispatch a job');
    if (change === 'disabled') cfg.scanners.s = { ...cfg.scanners.s, enabled: false };
    if (change === 'removed') cfg.scanners.s = { ...cfg.scanners.s, enabled: false, hidden: true };
    if (change === 'reenabled') cfg.scanners.s = { ...cfg.scanners.s, enabled: true };
    if (change === 'timeframe') cfg.timeframes = ['5m'];
    finish({ id: 1, ok: true, ms: 1, bars: bars.length, lastBarTime: bars.at(-1)!.time, warnings: 0,
      plots: [], shapes: [], labels: [], alerts: [{ type: 'alert', barIndex: 59, time: bars.at(-1)!.time,
        message: 'LONG | Entry: 100 | SL: 95 | TP1: 105 | TP2: 110 | TP3: 115' }] });
    await complete;
    assert.equal(paper.openPositions().length, change === 'none' ? 1 : 0);
    assert.equal(db.all('SELECT * FROM signals').length, change === 'none' ? 1 : 0);
  });
}
