import { test } from 'node:test';
import assert from 'node:assert/strict';


test('behind the proxy the rightmost forwarded address counts, so a client cannot claim loopback', async () => {
  const { clientAddress, isLoopback } = await import('./routes.ts');
  const req = (peer: string, fwd?: string) => ({ socket: { remoteAddress: peer }, headers: fwd === undefined ? {} : { 'x-forwarded-for': fwd } }) as any;
  assert.equal(clientAddress(req('203.0.113.5', '127.0.0.1')), '203.0.113.5', 'a direct peer is never overridden');
  assert.equal(clientAddress(req('127.0.0.1', '127.0.0.1, 203.0.113.5')), '203.0.113.5', 'the proxy appended the real address last');
  assert.equal(isLoopback(req('127.0.0.1', '127.0.0.1, 203.0.113.5')), false);
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.5')), '203.0.113.5');
  assert.equal(isLoopback(req('127.0.0.1')), true, 'no header: the local peer is local');
});
