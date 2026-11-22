import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../src/${name}.ts`, import.meta.url).href);

async function child(source: string): Promise<{ code: number | null; output: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnedge-lifecycle-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    symbols: ['BTCUSD'], timeframes: ['15m'], autoTune: { enabled: false },
    execution: { mode: 'paper', allowProduction: false }, incubator: { enabled: false },
  }));
  try {
    return await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
        delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID; delete process.env.DELTA_LIVE;
        ${source}
      `], { timeout: 15_000, env: { ...process.env, VNEDGE_DATA_DIR: dir, VNEDGE_WORKERS: '1', VNEDGE_LOG_FILE: '0', LOG_LEVEL: 'error' } });
      let output = '';
      processChild.stdout.on('data', b => { output += b; });
      processChild.stderr.on('data', b => { output += b; });
      processChild.on('error', reject);
      processChild.on('close', code => resolve({ code, output }));
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const stalled of [false, true]) test(`occupied API port cleans up once under the supervisor${stalled ? ', even when cleanup stalls' : ''}`, async () => {
  const result = await child(`
    import net from 'node:net';
    import {App} from ${moduleUrl('app')};
    import {ScannerRegistry} from ${moduleUrl('scanners/registry')};
    import {ProcessSupervisor} from ${moduleUrl('runtime')};
    ScannerRegistry.prototype.reload = function() {};
    const occupied = net.createServer();
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    process.env.PORT = String(occupied.address().port); process.env.HOST = '127.0.0.1';
    const request = ProcessSupervisor.prototype.request;
    ProcessSupervisor.prototype.request = function(reason) {
      this.d.timeoutMs = () => 1000;
      return request.call(this, reason);
    };
    const stop = App.prototype.stop;
    App.prototype.stop = async function() {
      console.log('cleanup:' + this.runtime.state);
      if (${stalled}) await new Promise(() => {});
      await stop.call(this);
      console.log('cleanup-complete');
    };
    App.prototype.start = async function() { console.log('unexpected-start'); };
    await import(${moduleUrl('index')});
  `);
  assert.equal(result.code, 1, result.output);
  assert.equal(result.output.split('cleanup:failed').length - 1, 1, result.output);
  assert.equal(result.output.includes('cleanup-complete'), !stalled, result.output);
  assert.ok(!result.output.includes('unexpected-start'), result.output);
});

test('App.stop cancels every wired execution timer, including funding and housekeeping', async () => {
  const result = await child(`
    import assert from 'node:assert/strict';
    import {EventEmitter} from 'node:events';
    import {App} from ${moduleUrl('app')};
    import {DeltaRest} from ${moduleUrl('delta/rest')};
    const feed = () => Object.assign(new EventEmitter(), { connected: false, subscriptions: [], start(){}, stop(){}, subscribe(){}, unsubscribe(){} });
    const scheduled = new Set(), remaining = new Set();
    const interval = globalThis.setInterval, clear = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms, ...args) => {
      const timer = interval(fn, ms, ...args);
      if (new Error().stack.includes('/execution/wiring.ts')) { scheduled.add(timer); remaining.add(timer); }
      return timer;
    };
    globalThis.clearInterval = timer => { remaining.delete(timer); return clear(timer); };
    let app;
    try {
      app = new App({ rest: new DeltaRest(), feed: feed(), advisoryFeedFactory: feed,
        registry: { all: () => [], get: () => undefined, runnable: () => [] }, alertTransport: async () => {} });
      assert.equal(scheduled.size, 0, 'construction must not arm execution timers');
      app.startExecutionLoops(); const count = scheduled.size;
      assert.ok(count >= 6, 'all execution tasks were armed');
      app.startExecutionLoops(); assert.equal(scheduled.size, count, 'start is idempotent');
      const recovery = setTimeout(() => { throw new Error('entry recovery after shutdown'); }, 300000);
      recovery.unref(); app.entryStateTimer = recovery;
      await app.stop();
      assert.equal(recovery._destroyed, true, 'restart recovery must not run against a stopped database');
      assert.equal(remaining.size, 0, 'execution timers survived App.stop');
      console.log('all-execution-timers-stopped');
    } finally {
      for (const timer of scheduled) clear(timer);
      globalThis.setInterval = interval; globalThis.clearInterval = clear;
      if (app) { await app.pool.stop(); app.db.db.close(); }
    }
  `);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /all-execution-timers-stopped/);
});
