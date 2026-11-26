import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { Db } from '../db.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ProductionReadiness } from './readiness.ts';
import { ExchangeExecutor } from './testnet.ts';

test('a passing readiness approval expires and binds the actual source and policy without changing paper settings', (t) => {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG),
    paper = new PaperEngine(db, () => cfg);
  cfg.scanners.s = { enabled: true, symbols: null, timeframes: null, exitMode: 'both' };
  paper.sourceHashFor = () => 'source';
  const policy = paper.policyForCell({ scannerId: 's', symbol: 'BTCUSD', tf: '15m' }),
    sources = { s: 'source' };
  const before = structuredClone(cfg),
    guard = new ProductionReadiness();
  assert.equal(typeof guard.check(cfg, sources, policy, policy, 100), 'string');
  guard.observe(true, cfg, sources, 100);
  assert.equal(typeof guard.check(cfg, sources, policy, policy, 101), 'object');
  assert.equal(typeof guard.check(cfg, { s: 'changed' }, policy, policy, 101), 'string');
  assert.equal(typeof guard.check(cfg, sources, { ...policy, adoptedAt: 1 }, policy, 101), 'string');
  assert.equal(typeof guard.check(cfg, sources, policy, policy, 60100), 'string');
  cfg.paper.feeTaxPct = (cfg.paper.feeTaxPct ?? 0) + 1;
  assert.equal(typeof guard.check(cfg, sources, policy, policy, 101), 'string');
  assert.deepEqual(before.risk, cfg.risk);
});

function fixture(t: any) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  const cfg = structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper, {
    feeRatePct: 0,
    makerFeeRatePct: 0,
    slippageBps: 0,
    latencyMs: 0,
    fillSource: 'candles',
    liquidation: false,
  });
  Object.assign(cfg.execution, { mode: 'testnet', bracket: false, reconcileSec: 0, sweepSec: 0 });
  const paper = new PaperEngine(db, () => cfg);
  paper.sourceHashFor = () => 'source';
  let posts = 0;
  const fake: any = {
    host: 'production',
    hasAuth: true,
    dryRun: false,
    products: async () => new Map([['BTCUSD', { id: 27, symbol: 'BTCUSD' }]]),
    wallet: async () => [],
    openOrders: async () => [],
    setLeverage: async (_p: number, leverage: number) => ({ leverage }),
    placeOrder: async (o: any) => {
      posts++;
      return {
        ...o,
        id: posts,
        state: 'closed',
        unfilled_size: 0,
        average_fill_price: 100,
        paid_commission: 0,
      };
    },
  };
  const ex = new ExchangeExecutor(paper, () => cfg, fake, { now: () => 1000, confirmSec: 0 });
  t.after(() => ex.stop());
  const open = () =>
    paper.onEntry(
      {
        kind: 'entry',
        side: 'long',
        price: 100,
        sl: 95,
        tp: [105, 110, 115],
        label: 'entry',
        message: '',
        source: 'alert',
        barTime: 0,
        barIndex: 0,
      },
      {
        scannerId: 's',
        scannerName: 'S',
        symbol: 'BTCUSD',
        tf: '15m',
        market: { tickSize: 0.01, contractValue: 1 },
        refPrice: 100,
        at: 60010,
        signalId: null,
        exitMode: 'both',
      },
    );
  return { db, cfg, paper, fake, ex, open, posts: () => posts };
}

test('production cannot commit an entry intent without readiness; reduce-only exit dispatch stays available', async (t) => {
  const f = fixture(t);
  await f.ex.start();
  assert.throws(() => f.paper.commitDecision(f.open), /readiness/);
  assert.equal(f.db.get<any>('SELECT count(*) n FROM execution_commands')!.n, 0);
  assert.equal(f.posts(), 0);
  let exits = 0;
  (f.ex as any).marketExit = async () => {
    exits++;
  };
  await (f.ex as any).onFill({ symbol: 'BTCUSD', side: 'sell', qty: 1, reason: 'sl', positionId: 1 });
  assert.equal(exits, 1, 'entry approval never blocks protective exits');
  (f.ex as any).adopting.add(99);
  assert.doesNotThrow(
    () => f.paper.executionIntent!(1, { positionId: 99, reason: 'entry' } as any),
    'adopting an already executed exchange fill cannot require new-entry permission',
  );
});

test('production rechecks readiness after the leverage await before any entry POST', async (t) => {
  const f = fixture(t);
  let ready = true;
  f.ex.admission = () =>
    ready ? { identity: 'tested-policy', evaluatedAt: 0, validUntil: 2000 } : 'changed during leverage';
  f.fake.setLeverage = async (_p: number, leverage: number) => {
    ready = false;
    return { leverage };
  };
  await f.ex.start();
  f.paper.commitDecision(f.open);
  await f.ex.flush();
  assert.equal(f.posts(), 0);
  assert.equal(f.paper.openPositions().length, 0);
});
