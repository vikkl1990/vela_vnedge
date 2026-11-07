import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectConnectionRequest } from './routes.ts';
import { permissionFor } from '../auth/routes.ts';
import { can } from '../auth/store.ts';

test('every connection route requires admin, including metadata reads and trailing slashes', () => {
  for (const route of ['/api/connections/delta', '/api/connections/delta/', '/api/connections/delta/check']) {
    for (const method of ['GET', 'HEAD', 'PUT', 'POST', 'DELETE']) {
      assert.equal(permissionFor(method, route), 'admin');
      assert.equal(can('viewer', permissionFor(method, route)!), false);
      assert.equal(can('trader', permissionFor(method, route)!), false);
    }
  }
});

const req = (peer: string, headers: Record<string, string | undefined> = {}, encrypted = false) => ({
  method: 'PUT', socket: { remoteAddress: peer, encrypted }, headers: { host: 'bot.example', 'content-type': 'application/json', ...headers },
}) as any;

test('credentials require TLS or local tunnel; internet peers cannot forge proxy headers', () => {
  assert.doesNotThrow(() => protectConnectionRequest(req('127.0.0.1', { host: 'localhost:18787', origin: 'http://localhost:18787' })));
  assert.doesNotThrow(() => protectConnectionRequest(req('203.0.113.4', { origin: 'https://bot.example' }, true)));
  assert.doesNotThrow(() => protectConnectionRequest(req('127.0.0.1', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.4', origin: 'https://bot.example' })));
  for (const input of [req('203.0.113.4'), req('203.0.113.4', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' }), req('127.0.0.1', { 'x-forwarded-for': '203.0.113.4' })]) {
    assert.throws(() => protectConnectionRequest(input), /Use HTTPS/);
  }
});

test('cross-origin, cross-site, insecure origins and non-JSON mutations are rejected', () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'http://bot.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    assert.throws(() => protectConnectionRequest(req('203.0.113.4', headers, true)));
  }
});
