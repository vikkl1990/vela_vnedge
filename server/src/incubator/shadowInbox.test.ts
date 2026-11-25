import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { sourceHash } from '../paper/fingerprint.ts';
import { ShadowRunner } from './shadow.ts';
import { ShadowInbox, shadowEventKey, type ShadowDelivery } from './shadowInbox.ts';

const H = 3600_000;
const SOURCE = 'alert("x")';

function harness(opts: { killExit?: boolean } = {}) {
  const db = new Db(':memory:');
  const inbox = new ShadowInbox(db);
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.incubator.enabled = true; cfg.incubator.mirror = { ...cfg.incubator.mirror!, enabled: false };
  cfg.risk.regime = { ...cfg.risk.regime, enabled: false };
  if (cfg.paper.trendGate) cfg.paper.trendGate = { ...cfg.paper.trendGate, enabled: false };
  const pair: any = { id: 1, scannerId: 's', symbol: 'XUSD', tf: '1h', stage: 'shadow', since: 0, updated: 0, screen: null, gate: null, note: null };
  const last = Math.floor(Date.now() / H) * H - H;
  const bars = Array.from({ length: 80 }, (_, i) => ({ time: last - (79 - i) * H, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 }));
  const calls = { exits: [] as any[], entries: [] as any[] };
  const state = { held: { id: 7, scannerId: 's', symbol: 'XUSD', tf: '1h', side: 'long', policy: undefined } as any, fresh: true, killExit: !!opts.killExit };
  const paper: any = new EventEmitter();
  Object.assign(paper, {
    book: 2,
    commitDecision: (fn: () => any) => db.transaction(fn),
    findOpen: () => state.held ?? undefined,
    onScriptExit: (...a: any[]) => {
      db.run("INSERT INTO kv(k,v) VALUES('test.exit',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(a.length));
      if (state.killExit) throw new Error('simulated kill before commit');
      calls.exits.push(a);
    },
    onEntry: (ev: any, ctx: any) => { calls.entries.push({ ev, ctx }); return { action: 'opened' }; },
    recordGatedEntry: () => {}, openPositions: () => [], pendingEntries: () => [], mark: () => 2,
    hasFreshPrice: () => state.fresh,
  });
  const store = {
    shadowFunnel: () => ({}), setShadowFunnel: () => {},
    liveMarks: () => db.kvGet<Record<string, number>>('incubator.liveMarks'), setLiveMarks: (r: any) => db.kvSet('incubator.liveMarks', r),
    get: () => pair, trades: () => [], quarantineReason: () => null,
  };
  let alerts: any[] = [];
  const runner = new ShadowRunner({
    store, cfgRef: () => cfg, candles: { get: () => bars }, inbox,
    registry: { get: () => ({ id: 's', name: 'S', status: 'ok', patched: SOURCE }) },
    pool: { run: async () => ({ ok: true, alerts, shapes: [], labels: [], plots: [], ms: 1 }), stats: { queued: 0 }, rssReader: () => 0, memoryGuardBytes: 1 },
    paper, marketInfo: async () => ({ tickSize: 0.01, contractValue: 1 }),
  } as any) as any;
  const exitAlert = () => { alerts = [{ type: 'alert', time: last, barIndex: 79, message: '🛑 SL HIT | Long | Entry: 1 | SL: 0.9' }]; };
  const run = () => runner.run(pair, Date.now(), true, Date.now());
  const rows = () => db.all<any>('SELECT event_key,kind,state,outcome FROM shadow_inbox');
  const delivery = (ev: any, over: Partial<ShadowDelivery> = {}): ShadowDelivery => ({ version: 1, pairId: 1, scannerId: 's', scannerName: 'S', symbol: 'XUSD', tf: '1h', ev, bars,
    market: { tickSize: 0.01, contractValue: 1 } as any, exitMode: 'both', lastBar: bars.at(-1)!, sourceHash: sourceHash(SOURCE), scannerConfig: JSON.stringify(cfg.scanners.s ?? null),
    targetPositionId: null, ...over });
  return { db, inbox, cfg, runner, state, calls, exitAlert, run, rows, delivery, last };
}

test('S2: a shadow exit gets a receipt with the watermark and completes in the decision transaction', async t => {
  const h = harness(); t.after(() => h.db.db.close());
  h.exitAlert();
  await h.run();
  assert.equal(h.calls.exits.length, 1);
  assert.deepEqual(h.rows().map(r => [r.kind, r.state, r.outcome]), [['exit', 'done', 'exit:applied']]);
  assert.equal(h.db.kvGet<Record<string, number>>('incubator.liveMarks')?.['s:XUSD:1h'], h.last, 'watermark advanced');
  await h.run();
  assert.equal(h.calls.exits.length, 1, 'the same bar is not applied twice');
});

test('S2: a kill before the shadow decision commits leaves the receipt pending; recovery applies it once', async t => {
  const h = harness({ killExit: true }); t.after(() => h.db.db.close());
  h.exitAlert();
  await assert.rejects(h.run(), /simulated kill/);
  assert.equal(h.db.kvGet('test.exit'), undefined, 'the half-made decision rolled back');
  assert.deepEqual(h.rows().map(r => r.state), ['pending'], 'the receipt survived');
  assert.equal(h.db.kvGet<Record<string, number>>('incubator.liveMarks')?.['s:XUSD:1h'], h.last, 'watermark and receipt committed together');
  h.state.killExit = false;
  assert.equal(await h.runner.recoverReceipts(), 1);
  assert.equal(h.calls.exits.length, 1);
  assert.equal(h.calls.exits[0][0], 's');
  assert.deepEqual(h.rows().map(r => [r.state, r.outcome]), [['done', 'exit:applied']]);
  assert.equal(await h.runner.recoverReceipts(), 0, 'nothing left to recover');
});

test('S2: a recovered exit never touches a different position than the one it was received for', async t => {
  const h = harness(); t.after(() => h.db.db.close());
  const ev = { kind: 'exit', exitType: 'sl', label: 'SL HIT', barTime: h.last, barIndex: 79, tp: [] };
  h.inbox.acceptAll([h.delivery(ev, { targetPositionId: 6 })], Date.now(), () => {});
  await h.runner.recoverReceipts();
  assert.equal(h.calls.exits.length, 0);
  assert.equal(h.rows()[0].outcome, 'ignored:no matching held shadow position');
});

test('S2: recovered entries must be timely, unchanged and priced now', async t => {
  const h = harness(); t.after(() => h.db.db.close());
  const entry = (label: string) => ({ kind: 'entry', side: 'long', price: 1, sl: 0.9, tp: [1.2], label, barTime: h.last, barIndex: 79 });
  // expired: received two minutes ago
  h.inbox.acceptAll([h.delivery(entry('old'))], Date.now() - 120_000, () => {});
  // source edited since receipt
  h.inbox.acceptAll([h.delivery(entry('edited'), { sourceHash: 'something-else' })], Date.now(), () => {});
  await h.runner.recoverReceipts();
  assert.equal(h.calls.entries.length, 0);
  const outcome = (label: string) => h.db.get<any>('SELECT outcome FROM shadow_inbox WHERE event_key=?', shadowEventKey({ scannerId: 's', symbol: 'XUSD', tf: '1h', ev: entry(label) as any }))?.outcome;
  assert.equal(outcome('old'), 'rejected:interrupted shadow entry expired before recovery');
  assert.equal(outcome('edited'), 'rejected:source or reading changed before shadow decision');
  // timely and unchanged, but no fresh price yet: stays pending and retries
  h.state.fresh = false;
  h.inbox.acceptAll([h.delivery(entry('fresh'))], Date.now(), () => {});
  await h.runner.recoverReceipts();
  assert.equal(h.calls.entries.length, 0);
  assert.equal(h.db.get<any>("SELECT state FROM shadow_inbox WHERE state='pending'")?.state, 'pending');
  h.state.fresh = true;
  await h.runner.recoverReceipts();
  assert.equal(h.calls.entries.length, 1);
  assert.equal(h.calls.entries[0].ev.price, 2, 'executes against the current mark, not the pre-crash signal price');
  assert.equal(outcome('fresh'), 'opened');
});
