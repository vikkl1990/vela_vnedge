import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { AuthStore, can, hashPassword, passwordProblem, usernameProblem, verifyPassword } from './store.ts';
import { permissionFor } from './routes.ts';

function store(t: { after: (fn: () => void) => void }) {
  const db = new Db(':memory:');
  t.after(() => db.db.close());
  return new AuthStore(db);
}

test('passwords are salted, slow and compared without leaking length', () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.notEqual(a, b, 'the same password hashes differently each time');
  assert.ok(verifyPassword('correct horse battery', a));
  assert.ok(!verifyPassword('correct horse batterz', a));
  assert.ok(!verifyPassword('', a));
  assert.ok(!verifyPassword('x', 'not-a-hash'), 'a malformed hash never verifies');
  assert.ok(a.startsWith('scrypt$16384$8$1$'), 'parameters travel with the hash');
});

test('weak usernames and passwords are refused', () => {
  assert.match(passwordProblem('short') ?? '', /at least 10/);
  assert.match(passwordProblem('1234567890') ?? '', /too common|only digits/);
  assert.equal(passwordProblem('a-reasonable-one'), null);
  assert.match(usernameProblem('ab') ?? '', /3–32/);
  assert.match(usernameProblem('has space') ?? '', /3–32/);
  assert.equal(usernameProblem('vikram.k'), null);
});

test('roles carry exactly the rights they are named for', () => {
  assert.deepEqual(['read', 'backtest', 'trade', 'admin'].map(p => can('viewer', p as any)), [true, true, false, false]);
  assert.deepEqual(['read', 'backtest', 'trade', 'admin'].map(p => can('trader', p as any)), [true, true, true, false]);
  assert.deepEqual(['read', 'backtest', 'trade', 'admin'].map(p => can('admin', p as any)), [true, true, true, true]);
});

test('every mutation is closed by default; only named routes are backtest-safe', () => {
  assert.equal(permissionFor('GET', '/api/stats'), 'read');
  assert.equal(permissionFor('POST', '/api/backtest/run'), 'backtest');
  assert.equal(permissionFor('POST', '/api/validation/run'), 'backtest');
  // anything that changes what the bot does, including a route nobody has written yet
  for (const p of ['/api/paper/reset', '/api/paper/close-all', '/api/config', '/api/scanners/x', '/api/risk/kill', '/api/some/future/route']) {
    assert.equal(permissionFor('POST', p), 'trade', `${p} must require trade access`);
  }
  assert.equal(permissionFor('PUT', '/api/config'), 'trade');
  assert.equal(permissionFor('DELETE', '/api/users/3'), 'admin');
  assert.equal(permissionFor('GET', '/api/users'), 'admin', 'the user list is not readable by everyone');
  assert.equal(permissionFor('POST', '/api/auth/login'), null, 'login must be reachable signed out');
  assert.equal(permissionFor('GET', '/api/auth/me'), 'read');
});

test('a backtest-only user cannot reach any trading route', () => {
  const denied = ['/api/paper/reset', '/api/paper/close-all', '/api/config', '/api/scanners/abc', '/api/risk/kill', '/api/execution/close-all', '/api/scanners/auto-tune']
    .filter(p => can('viewer', permissionFor('POST', p)!));
  assert.deepEqual(denied, [], 'viewer reached a trading route');
  assert.ok(can('viewer', permissionFor('POST', '/api/backtest/run')!), 'but backtests stay open to them');
});

test('login is rejected for wrong passwords and disabled accounts, and records the time', t => {
  const s = store(t);
  const u = s.createUser({ username: 'vikram', password: 'a-good-password', role: 'trader' });
  assert.equal(u.role, 'trader');
  assert.equal(s.login('vikram', 'wrong'), null);
  assert.equal(s.login('nobody', 'a-good-password'), null);
  const ok = s.login('VIKRAM', 'a-good-password');       // usernames are case-insensitive
  assert.equal(ok?.id, u.id);
  assert.ok(ok!.lastLoginAt! > 0);
  s.updateUser(u.id, { disabled: true });
  assert.equal(s.login('vikram', 'a-good-password'), null, 'a disabled account cannot sign in');
});

test('sessions resolve, expire, and die with the account', t => {
  const s = store(t);
  const u = s.createUser({ username: 'trader1', password: 'a-good-password', role: 'trader' });
  const sess = s.startSession(u.id);
  assert.equal(s.resolve(sess.token)?.id, u.id);
  assert.equal(s.resolve('made-up'), null);
  assert.equal(s.resolve(null), null);
  assert.equal(s.resolve(sess.token, sess.expiresAt + 1), null, 'an expired token is refused');
  const live = s.startSession(u.id);
  s.updateUser(u.id, { disabled: true });
  assert.equal(s.resolve(live.token), null, 'disabling an account kills its sessions');
});

test('changing a password signs every session out', t => {
  const s = store(t);
  const u = s.createUser({ username: 'trader2', password: 'a-good-password', role: 'trader' });
  const a = s.startSession(u.id), b = s.startSession(u.id);
  assert.equal(s.sessionCount(u.id), 2);
  s.updateUser(u.id, { password: 'another-good-password' });
  assert.equal(s.resolve(a.token), null);
  assert.equal(s.resolve(b.token), null);
  assert.ok(s.login('trader2', 'another-good-password'));
});

test('the last administrator cannot be removed, demoted or disabled', t => {
  const s = store(t);
  const admin = s.createUser({ username: 'boss', password: 'a-good-password', role: 'admin' });
  const other = s.createUser({ username: 'helper', password: 'a-good-password', role: 'viewer' });
  assert.throws(() => s.updateUser(admin.id, { role: 'viewer' }), /last administrator/);
  assert.throws(() => s.updateUser(admin.id, { disabled: true }), /last administrator/);
  assert.throws(() => s.deleteUser(admin.id), /last administrator/);
  // with a second administrator in place the first may step down
  s.updateUser(other.id, { role: 'admin' });
  assert.equal(s.updateUser(admin.id, { role: 'viewer' }).role, 'viewer');
});

test('duplicate usernames are refused regardless of case', t => {
  const s = store(t);
  s.createUser({ username: 'vikram', password: 'a-good-password', role: 'viewer' });
  assert.throws(() => s.createUser({ username: 'VIKRAM', password: 'a-good-password', role: 'viewer' }), /taken/);
});

test('expired sessions are swept', t => {
  const s = store(t);
  const u = s.createUser({ username: 'sweep', password: 'a-good-password', role: 'viewer' });
  const old = s.startSession(u.id, Date.now() - 48 * 3600_000);
  s.startSession(u.id);
  assert.equal(s.sweep(), 1);
  assert.equal(s.resolve(old.token), null);
  assert.equal(s.sessionCount(u.id), 1);
});

test('a proxied request is judged by the real client, not by the proxy', async () => {
  const { isLoopback, clientAddress } = await import('./routes.ts')
  const mk = (peer: string, fwd?: string) => ({ socket: { remoteAddress: peer }, headers: fwd ? { 'x-forwarded-for': fwd } : {} }) as any;

  // direct connections: the socket decides
  assert.equal(isLoopback(mk('127.0.0.1')), true);
  assert.equal(isLoopback(mk('::1')), true);
  assert.equal(isLoopback(mk('203.0.113.9')), false);

  // behind the reverse proxy every request arrives from loopback; the header must decide
  assert.equal(isLoopback(mk('127.0.0.1', '203.0.113.9')), false, 'a public caller must not look local');
  // only the entry the proxy itself appended (the rightmost) is trusted; what the client put before it is not (review, 16 Oct)
  assert.equal(isLoopback(mk('127.0.0.1', '127.0.0.1, 203.0.113.9')), false, 'a client claiming loopback on the left is still remote');
  assert.equal(isLoopback(mk('127.0.0.1', '203.0.113.9, 127.0.0.1')), true, 'the proxy says its peer was local');
  assert.equal(isLoopback(mk('127.0.0.1', '127.0.0.1')), true, 'a genuine local call through the proxy stays local');

  // a direct public connection may not forge the header
  assert.equal(isLoopback(mk('203.0.113.9', '127.0.0.1')), false, 'only a loopback peer is trusted to forward');
  assert.equal(clientAddress(mk('203.0.113.9', '127.0.0.1')), '203.0.113.9');
});

test('decision 117: a share link signs in as a read-only guest, expires with the link, and dies when revoked', () => {
  const s = store(test as any);
  const t0 = Date.UTC(2026, 9, 17, 12);
  assert.ok(can('guest', 'read') && !can('guest', 'backtest') && !can('guest', 'trade') && !can('guest', 'admin'));
  const { link, token } = s.createShareLink({ label: 'audit', hours: 48, createdBy: null }, t0);
  assert.equal(link.expiresAt, t0 + 48 * 3_600_000); assert.equal(link.uses, 0);
  assert.ok(!s.listShareLinks().some(l => JSON.stringify(l).includes(token)), 'the token is never stored');
  const got = s.redeemShareLink(token, t0 + 1000)!;
  assert.ok(got); assert.equal(s.resolve(got.session.token, t0 + 2000)?.role, 'guest');
  assert.equal(s.resolve(got.session.token, t0 + 2000)?.username, 'share-guest');
  assert.equal(got.session.expiresAt, Math.min(t0 + 1000 + 12 * 3_600_000, link.expiresAt), 'a guest session never outlives the link');
  assert.equal(s.shareLink(link.id)!.uses, 1);
  assert.equal(s.redeemShareLink('not-a-real-token-at-all-really', t0), null);
  assert.equal(s.redeemShareLink(token, link.expiresAt + 1), null, 'expired');
  // revoke: the link stops redeeming and the guest's sessions end at once
  s.revokeShareLink(link.id, t0 + 5000);
  assert.equal(s.redeemShareLink(token, t0 + 6000), null);
  assert.equal(s.resolve(got.session.token, t0 + 6000), null);
  assert.throws(() => s.createShareLink({ hours: 0 }, t0), /hours/);
  assert.throws(() => s.createShareLink({ hours: 24 * 30 }, t0), /hours/);
  // the guest cannot be logged into with a password
  assert.equal(s.login('share-guest', 'anything-at-all-12', t0), null);
});
