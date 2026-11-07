import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { DeltaConnection, ConnectionError } from './delta.ts';
import { DeltaRequestError } from '../delta/rest.ts';

const credentials = { environment: 'production', apiKey: 'test-key-not-real', apiSecret: 'test-secret-not-real' };
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'secrets'), filename: path.join(root, 'secrets/delta-connection.json') };
}
function noSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const secret of [credentials.apiKey, credentials.apiSecret, 'apiKey', 'apiSecret', 'revision']) assert.ok(!json.includes(secret), secret);
}

test('save persists only in owner-only storage, returns metadata and survives restart without verified status', async t => {
  const { root, directory, filename } = fixture(t);
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{"execution":{"mode":"paper"}}');
  const c = new DeltaConnection(root, async () => {});
  assert.equal(c.status().configured, false);
  noSecrets(c.save(credentials));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ['delta-connection.json']);
  const checked = await c.check(); noSecrets(checked); assert.equal(checked.check?.ok, true);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"execution":{"mode":"paper"}}');
  const restarted = new DeltaConnection(root); noSecrets(restarted.status());
  assert.equal(restarted.status().configured, true); assert.equal(restarted.status().check, null);
  assert.equal(restarted.remove().configured, false); assert.ok(!fs.existsSync(filename));
  assert.equal(restarted.remove().configured, false);
});

test('validation refuses missing credentials and arbitrary environments without writing anything', t => {
  const { root, directory } = fixture(t); const c = new DeltaConnection(root);
  for (const invalid of [null, {}, { ...credentials, environment: 'https://attacker.invalid' }, { ...credentials, apiSecret: 'bad\nsecret' }, { ...credentials, apiKey: '' }]) {
    assert.throws(() => c.save(invalid), (e: any) => e instanceof ConnectionError && e.status === 400);
  }
  assert.ok(!fs.existsSync(directory));
});

test('insecure permissions, symlinks and corrupt files fail closed without revealing file contents', t => {
  const { root, directory, filename } = fixture(t); const c = new DeltaConnection(root);
  c.save(credentials); fs.chmodSync(filename, 0o644);
  assert.throws(() => c.status(), /Credential storage unavailable/);
  fs.chmodSync(filename, 0o600); fs.writeFileSync(filename, credentials.apiSecret);
  assert.throws(() => c.status(), (e: any) => { noSecrets({ error: e.message }); return e.status === 503; });
  c.remove();
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'do not change', { mode: 0o600 });
  fs.symlinkSync(outside, filename);
  for (const op of [() => c.save(credentials), () => c.status(), () => c.remove()]) assert.throws(op, /Credential storage unavailable/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not change');
  fs.unlinkSync(filename); fs.rmdirSync(directory); fs.symlinkSync(root, directory);
  assert.throws(() => c.save(credentials), /Credential storage unavailable/);
});

test('check sends signed GETs only to the selected official host and rejects redirects', async t => {
  const { root } = fixture(t);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['api-key'], credentials.apiKey);
    assert.equal(headers.signature, createHmac('sha256', credentials.apiSecret).update('GET' + headers.timestamp + new URL(url).pathname).digest('hex'));
    return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
  });
  for (const [environment, host] of [['testnet', 'https://cdn-ind.testnet.deltaex.org'], ['production', 'https://api.india.delta.exchange']]) {
    const c = new DeltaConnection(root); c.save({ ...credentials, environment });
    const result = await c.check(); assert.equal(result.check?.ok, true); noSecrets(result);
    assert.deepEqual(calls.splice(0), [`${host}/v2/wallet/balances`, `${host}/v2/positions/margined`]);
  }
});

test('upstream errors and unexpected payloads are sanitized; a failed second read is not a verified connection', async t => {
  const { root } = fixture(t);
  const c = new DeltaConnection(root, async () => { throw new DeltaRequestError(credentials.apiSecret, 401, credentials.apiKey); });
  c.save(credentials); const status = await c.check(); noSecrets(status);
  assert.equal(status.check?.ok, false); assert.match(status.check!.message, /Authentication refused/);
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: true, result: ++count === 1 ? [] : { private: credentials.apiSecret } })));
  const wrongShape = new DeltaConnection(root); wrongShape.save(credentials);
  const result = await wrongShape.check(); noSecrets(result); assert.equal(result.check?.ok, false); assert.equal(count, 2);
});

test('replacement and removal invalidate an in-flight check; concurrent checks coalesce', async t => {
  const { root } = fixture(t);
  for (const action of ['replace', 'remove']) {
    let release!: () => void, calls = 0;
    const c = new DeltaConnection(root, () => { calls++; return new Promise<void>(resolve => { release = resolve; }); });
    c.save(credentials); const a = c.check(), b = c.check();
    assert.equal(calls, 1);
    if (action === 'replace') c.save({ ...credentials, apiKey: 'replacement-key' }); else c.remove();
    const failed = Promise.all([assert.rejects(a, /Credentials changed/), assert.rejects(b, /Credentials changed/)]);
    release(); await failed; assert.equal(c.status().check, null);
  }
});

test('checks require saved credentials and are rate limited', async t => {
  const { root } = fixture(t); let calls = 0;
  const c = new DeltaConnection(root, async () => { calls++; });
  await assert.rejects(c.check(), /Save a Delta/);
  c.save(credentials); await c.check(); await assert.rejects(c.check(), (e: any) => e.status === 429);
  assert.equal(calls, 1);
});
