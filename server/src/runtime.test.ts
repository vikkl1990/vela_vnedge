import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ProcessSupervisor, RuntimeState } from './runtime.ts';

test('fatal latch immediately blocks entries, is monotonic and never mutates risk configuration', async () => {
  const state = new RuntimeState(); let calls = 0; let finish!: () => void;
  const done = new Promise<number>(resolve => {
    const supervisor = new ProcessSupervisor({
      mark: (fatal, reason) => state.stop(fatal, reason),
      shutdown: () => { calls++; return new Promise<void>(r => { finish = r; }); },
      timeoutMs: () => 1000, report: () => {}, exit: resolve,
    });
    assert.equal(state.entryBlock, null);
    supervisor.request('SIGTERM'); assert.ok(state.entryBlock);
    supervisor.request('uncaughtException'); supervisor.request('SIGTERM');
    assert.equal(state.state, 'failed');
  });
  await Promise.resolve(); assert.equal(calls, 1); finish(); assert.equal(await done, 1);
});

test('shutdown failure returns nonzero even for an ordinary termination', async () => {
  const code = await new Promise<number>(resolve => new ProcessSupervisor({
    mark: () => {}, shutdown: async () => { throw Error('private-canary'); },
    timeoutMs: () => 1000, report: () => {}, exit: resolve,
  }).request('SIGTERM'));
  assert.equal(code, 1);
});

for (const mode of ['exception', 'rejection', 'hung', 'signal', 'startup']) test(`real process ${mode} has bounded, correct exit status and no secret output`, async () => {
  const source = `
    import {ProcessSupervisor,RuntimeState} from ${JSON.stringify(new URL('./runtime.ts', import.meta.url).href)};
    const state=new RuntimeState();
    const supervisor = new ProcessSupervisor({
      mark:(fatal,reason)=>{state.stop(fatal,reason);console.log('blocked='+Boolean(state.entryBlock));},
      shutdown:async()=>{console.log('cleanup');if(${JSON.stringify(mode)}==='hung')await new Promise(()=>{});},
      timeoutMs:()=>100,report:message=>console.log(message),exit:code=>process.exit(code)
    });supervisor.install();
    if(${JSON.stringify(mode)}==='signal')process.kill(process.pid,'SIGTERM');
    else if(${JSON.stringify(mode)}==='rejection')Promise.reject(new Error('secret-canary'));
    else if(${JSON.stringify(mode)}==='startup')supervisor.request('startup');
    else setImmediate(()=>{throw new Error('secret-canary')});
    setInterval(()=>{},1000);
  `;
  const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { timeout: 5000 });
    let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, out }));
  });
  assert.equal(result.code, mode === 'signal' ? 0 : 1, result.out);
  assert.match(result.out, /blocked=true/); assert.equal(result.out.split('cleanup').length - 1, 1);
  assert.ok(!result.out.includes('secret-canary'));
});
