import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shadowRecovery } from '../../test/fixtures/shadowRecovery.ts';

for (const point of ['after-receipt', 'before-decision-commit', 'after-commit'])
  test(`SIGKILL ${point}: shadow keeps its receipt and never duplicates or backdates the fill`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'vnedge-shadow-inbox-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'db.sqlite');
    const child = spawnSync(
      process.execPath,
      [
        '--no-warnings=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `
    import {shadowRecovery} from ${JSON.stringify(new URL('../../test/fixtures/shadowRecovery.ts', import.meta.url).href)};
    const [file,point]=process.argv.slice(1),f=shadowRecovery(file),kill=()=>process.kill(process.pid,'SIGKILL');
    if(point==='after-receipt'){const accept=f.runner.inbox.accept.bind(f.runner.inbox);f.runner.inbox.accept=(...args)=>{const rows=accept(...args);kill();return rows;};}
    if(point==='before-decision-commit'){const finish=f.runner.inbox.finish.bind(f.runner.inbox);f.runner.inbox.finish=(...args)=>{if(args[1]==='shadow')kill();return finish(...args);};}
    if(point==='after-commit')f.paper.on('order',o=>{if(o.reason==='entry')kill();});
    await f.runner.run(f.pair,f.closeAt,false,f.closeAt);
    throw Error('crash boundary was not reached');
  `,
        file,
        point,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr + child.stdout);
    const f = shadowRecovery(file);
    t.after(() => {
      f.runner.stop();
      f.db.db.close();
    });
    assert.equal(f.db.get<any>('PRAGMA quick_check')!.quick_check, 'ok');
    const before = f.db.get<any>('SELECT count(*) n FROM positions')!.n;
    assert.equal(before, point === 'after-commit' ? 1 : 0);
    const restartAt = Date.now();
    f.paper.setMark('BTCUSD', 100.25);
    await f.runner.recoverReceipts();
    await f.runner.recoverReceipts();
    assert.equal(f.db.get<any>('SELECT count(*) n FROM positions')!.n, 1);
    assert.equal(f.db.get<any>('SELECT count(*) n FROM orders')!.n, 1);
    assert.equal(f.runner.inbox.pending().length, 0);
    const trade = f.paper.openPositions()[0];
    assert.ok(trade);
    if (point !== 'after-commit') {
      assert.ok(trade.entryAt >= restartAt);
      assert.equal(trade.entryPrice, 100.25, 'recovery uses the fresh mark, never the pre-crash reference');
    }
  });

test('changed-policy shadow receipts are refused without changing evidence or inventing a trade', async (t) => {
  const f = shadowRecovery(':memory:');
  t.after(() => {
    f.runner.stop();
    f.db.db.close();
  });
  f.runner.stopped = true;
  await f.runner.run(f.pair, f.closeAt, false, f.closeAt);
  assert.equal(f.runner.inbox.pending().length, 1);
  f.cfg.paper.latencyMs++;
  f.runner.stopped = false;
  f.paper.setMark('BTCUSD', 100);
  await f.runner.recoverReceipts();
  assert.equal(f.paper.openPositions().length, 0);
  assert.equal(f.runner.inbox.pending().length, 0);
  assert.equal(
    f.db.get<any>("SELECT count(*) n FROM gated_signals WHERE promotion_eligible=0 AND stage='recovery'")!.n,
    1,
  );
});

test('expired shadow entries cannot fill after downtime, while an old exit cannot close a replacement', async (t) => {
  const f = shadowRecovery(':memory:');
  t.after(() => {
    f.runner.stop();
    f.db.db.close();
  });
  let captured: any;
  const accept = f.runner.inbox.accept.bind(f.runner.inbox);
  f.runner.inbox.accept = (ds: any[], advance: () => void) => {
    captured = structuredClone(ds[0]);
    return accept(ds, advance);
  };
  f.runner.stopped = true;
  await f.runner.run(f.pair, f.closeAt, false, f.closeAt);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 301000 });
  f.runner.stopped = false;
  f.paper.setMark('BTCUSD', 100);
  await f.runner.recoverReceipts();
  assert.equal(f.paper.openPositions().length, 0);
  assert.equal(f.runner.inbox.pending().length, 0);
  // New fresh trade, followed by a close and replacement, all at actual processing time.
  const event = { ...captured.event, barTime: Date.now() - 900000 };
  const context = {
    scannerId: 's',
    scannerName: 'S',
    symbol: 'BTCUSD',
    tf: '15m',
    market: captured.market,
    atr: 4,
    refPrice: 100,
    at: Date.now(),
    signalId: null,
    exitMode: 'both' as const,
  };
  const old = f.paper.onEntry(event, context).position!;
  assert.ok(old);
  const closeReceipt = {
    ...captured,
    event: { ...event, kind: 'exit', exitType: 'close', label: 'close' },
    target: { positionId: old.id, pendingIds: [] },
    receivedAt: Date.now(),
  };
  f.runner.inbox.accept([closeReceipt], () => {});
  f.paper.closeManual(old.id);
  const replacement = f.paper.onEntry(event, context).position!;
  assert.ok(replacement);
  await f.runner.recoverReceipts();
  assert.equal(f.paper.openPositions()[0].id, replacement.id);
  assert.equal(f.runner.inbox.pending().length, 0);
});

test('raw interpretation output survives a failed comparison handoff without recomputing or repeating the ordinary fill', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vnedge-raw-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'db.sqlite');
  const plan = {
    id: 'reading',
    enabled: true,
    scannerId: 's',
    symbol: 'BTCUSD',
    tf: '15m',
    readingOverride: { reader: 2 },
  };
  const first = shadowRecovery(file);
  first.cfg.executionPlans = [plan as any];
  let attempts = 0;
  first.runner.deps.compareScan = () => {
    attempts++;
    throw Error('comparison store temporarily unavailable');
  };
  await first.runner.run(first.pair, first.closeAt, false, first.closeAt);
  assert.equal(first.paper.openPositions().length, 1, 'comparison failure cannot block the ordinary book');
  assert.equal(
    first.runner.inbox.pending().length,
    0,
    'failed work backs off instead of spinning in the execution loop',
  );
  const raw = first.db.get<any>("SELECT * FROM shadow_signal_inbox WHERE kind='scan'");
  assert.equal(raw.compare_done, 0);
  assert.ok(raw.payload);
  first.runner.stop();
  first.db.db.close();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1100 });
  const second = shadowRecovery(file);
  t.after(() => {
    second.runner.stop();
    second.db.db.close();
  });
  second.cfg.executionPlans = [plan as any];
  second.paper.setMark('BTCUSD', 100.25);
  second.runner.deps.compareScan = (scan: any) => {
    attempts++;
    assert.equal(scan.result.alerts[0].message, 'LONG | Price: 100');
    assert.equal(scan.recovery, true);
  };
  await second.runner.recoverReceipts();
  await second.runner.recoverReceipts();
  assert.equal(attempts, 2);
  assert.equal(second.runner.inbox.pending().length, 0);
  assert.equal(second.paper.openPositions().length, 1);
  assert.equal(second.db.get<any>('SELECT count(*) n FROM orders')!.n, 1);
});
