/**
 * Authentication and user administration.
 *
 * Route permissions are decided centrally in `permissionFor`, and mutations default to `trade`.
 * A route added later is therefore closed to backtest-only users until someone deliberately
 * opens it, which is the direction a mistake should fail in.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { AuthStore, ROLE_LABELS, ROLES, SESSION_TTL_MS, can, isRole, passwordProblem, type Permission, type Role, type User } from './store.ts';
import { logger } from '../log.ts';

const log = logger.scoped('auth');
export const SESSION_COOKIE = 'vnedge_session';

/** Mutating routes a backtest-only user may still call: they compute, they do not trade. */
const BACKTEST_SAFE: RegExp[] = [
  /^\/api\/backtest\/run$/,
  /^\/api\/validation\/run$/,
  /^\/api\/validation\/history\/fetch$/,
  /^\/api\/dev\/script-list$/,
];

/** What a request needs. `null` means the route is public. */
export function permissionFor(method: string, pathname: string): Permission | null {
  if (pathname === '/api/auth/login' || pathname === '/api/auth/setup' || pathname === '/api/auth/status') return null;
  if (pathname.startsWith('/api/auth/')) return 'read';        // me, logout, own password: any signed-in user
  if (pathname.startsWith('/api/users')) return 'admin';
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (BACKTEST_SAFE.some(r => r.test(pathname))) return 'backtest';
  return 'trade';                                               // default-deny for anything that changes state
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token: string, maxAgeSec: number, secure: boolean): string {
  const bits = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** True when the request reached us over TLS, directly or through a proxy that says so. */
function isSecureRequest(req: http.IncomingMessage): boolean {
  if ((req.socket as any)?.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

/** Loopback-only, used to gate first-run setup so nobody can claim the empty instance remotely. */
export function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export const publicUser = (u: User) => ({ ...u, roleLabel: ROLE_LABELS[u.role] });

/** Simple per-username and per-address throttle so the login form cannot be ground down. */
class LoginThrottle {
  private hits = new Map<string, { n: number; until: number }>();
  private readonly max = 8;
  private readonly windowMs = 10 * 60_000;
  check(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.until <= now) return 0;
    return h.n >= this.max ? Math.ceil((h.until - now) / 1000) : 0;
  }
  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.until <= now) this.hits.set(key, { n: 1, until: now + this.windowMs });
    else h.n++;
  }
  clear(key: string): void { this.hits.delete(key); }
}

export interface AuthContext { store: AuthStore; throttle: LoginThrottle }

export function createAuth(store: AuthStore): AuthContext {
  return { store, throttle: new LoginThrottle() };
}

type Add = (method: string, route: string, handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, url: URL, body: any) => unknown) => void;

export function authRoutes(add: Add, ctx: AuthContext, currentUser: (req: http.IncomingMessage) => User | null) {
  const { store, throttle } = ctx;
  const fail = (status: number, message: string) => { const e: any = new Error(message); e.status = status; throw e; };

  add('GET', '/api/auth/status', (req) => ({
    configured: store.countUsers() > 0,
    canSetup: store.countUsers() === 0 && isLoopback(req),
    roles: ROLES.map(r => ({ role: r, label: ROLE_LABELS[r] })),
  }));

  // First run only, and only from the machine itself.
  add('POST', '/api/auth/setup', (req, res, _p, _u, body) => {
    if (store.countUsers() > 0) fail(409, 'already configured');
    if (!isLoopback(req)) fail(403, 'the first administrator must be created from the server itself');
    const user = store.createUser({ username: String(body?.username ?? ''), password: String(body?.password ?? ''), role: 'admin', displayName: body?.displayName });
    const s = store.startSession(user.id);
    res.setHeader('Set-Cookie', cookieHeader(s.token, Math.floor(SESSION_TTL_MS / 1000), isSecureRequest(req)));
    log.warn(`first administrator created: ${user.username}`);
    return { user: publicUser(user) };
  });

  add('POST', '/api/auth/login', (req, res, _p, _u, body) => {
    const username = String(body?.username ?? '').trim();
    const addr = req.socket.remoteAddress ?? 'unknown';
    for (const key of [`u:${username.toLowerCase()}`, `a:${addr}`]) {
      const wait = throttle.check(key);
      if (wait) fail(429, `too many attempts, try again in ${wait}s`);
    }
    const user = store.login(username, String(body?.password ?? ''));
    if (!user) {
      throttle.fail(`u:${username.toLowerCase()}`); throttle.fail(`a:${addr}`);
      log.warn(`failed login for ${username || '(blank)'} from ${addr}`);
      fail(401, 'wrong username or password');
    }
    throttle.clear(`u:${username.toLowerCase()}`); throttle.clear(`a:${addr}`);
    const s = store.startSession(user!.id);
    res.setHeader('Set-Cookie', cookieHeader(s.token, Math.floor(SESSION_TTL_MS / 1000), isSecureRequest(req)));
    log.info(`${user!.username} signed in as ${user!.role}`);
    return { user: publicUser(user!) };
  });

  add('POST', '/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) store.revoke(token);
    res.setHeader('Set-Cookie', cookieHeader('', 0, isSecureRequest(req)));
    return { ok: true };
  });

  add('GET', '/api/auth/me', (req) => {
    const u = currentUser(req);
    if (!u) fail(401, 'not signed in');
    return {
      user: publicUser(u!),
      permissions: (['read', 'backtest', 'trade', 'admin'] as Permission[]).filter(p => can(u!.role, p)),
      sessions: store.sessionCount(u!.id),
    };
  });

  /** Change your own password. Requires the current one, and signs every other session out. */
  add('POST', '/api/auth/password', (req, res, _p, _u, body) => {
    const u = currentUser(req);
    if (!u) fail(401, 'not signed in');
    if (!store.login(u!.username, String(body?.current ?? ''))) fail(403, 'current password is wrong');
    const next = String(body?.next ?? '');
    const problem = passwordProblem(next);
    if (problem) fail(400, problem);
    if (crypto.timingSafeEqual(Buffer.from(String(body?.current ?? '')), Buffer.from(next)) === true) fail(400, 'the new password must differ from the current one');
    store.updateUser(u!.id, { password: next });
    const s = store.startSession(u!.id);   // keep this browser signed in
    res.setHeader('Set-Cookie', cookieHeader(s.token, Math.floor(SESSION_TTL_MS / 1000), isSecureRequest(req)));
    log.info(`${u!.username} changed their password`);
    return { ok: true };
  });

  add('POST', '/api/auth/profile', (req, _res, _p, _u, body) => {
    const u = currentUser(req);
    if (!u) fail(401, 'not signed in');
    return { user: publicUser(store.updateUser(u!.id, { displayName: String(body?.displayName ?? u!.displayName) })) };
  });

  // ---- administration ----

  add('GET', '/api/users', () => ({
    users: store.listUsers().map(publicUser),
    roles: ROLES.map(r => ({ role: r, label: ROLE_LABELS[r] })),
  }));

  add('POST', '/api/users', (_req, _res, _p, _u, body) => {
    const role = body?.role;
    if (!isRole(role)) fail(400, `role must be one of ${ROLES.join(', ')}`);
    const user = store.createUser({ username: String(body?.username ?? ''), password: String(body?.password ?? ''), role, displayName: body?.displayName });
    log.info(`user ${user.username} created as ${user.role}`);
    return { user: publicUser(user) };
  });

  add('POST', '/api/users/:id', (req, _res, params, _u, body) => {
    const id = Number(params.id);
    const me = currentUser(req);
    const patch: any = {};
    if (body?.role !== undefined) patch.role = body.role;
    if (body?.displayName !== undefined) patch.displayName = body.displayName;
    if (body?.disabled !== undefined) patch.disabled = Boolean(body.disabled);
    if (body?.password !== undefined) patch.password = String(body.password);
    if (me && me.id === id && patch.role && patch.role !== me.role) fail(400, 'change your own role from another administrator account');
    const user = store.updateUser(id, patch);
    log.info(`user ${user.username} updated${patch.role ? ` to ${patch.role}` : ''}${patch.disabled !== undefined ? patch.disabled ? ' (disabled)' : ' (enabled)' : ''}`);
    return { user: publicUser(user) };
  });

  add('DELETE', '/api/users/:id', (req, _res, params) => {
    const id = Number(params.id);
    const me = currentUser(req);
    if (me && me.id === id) fail(400, 'you cannot delete your own account');
    const target = store.getUser(id);
    store.deleteUser(id);
    log.info(`user ${target?.username ?? id} deleted`);
    return { ok: true };
  });

  add('POST', '/api/users/:id/sessions/revoke', (_req, _res, params) => {
    const id = Number(params.id);
    store.revokeAllFor(id);
    return { ok: true };
  });
}
