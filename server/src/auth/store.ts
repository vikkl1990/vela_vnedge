/**
 * Users, passwords and sessions.
 *
 * Passwords are hashed with scrypt from node:crypto — no dependency, and deliberately slow.
 * Each hash carries its own random salt and the parameters it was made with, so the cost can be
 * raised later without invalidating existing passwords. Comparison is constant time.
 *
 * Sessions are opaque random tokens stored server side. The cookie carries only the token, so a
 * stolen database row cannot be replayed as a password and a session can be revoked instantly.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';

/** What a role is allowed to do. Checked on the server for every request; the UI only mirrors it. */
export type Role = 'admin' | 'trader' | 'viewer' | 'guest';
/** `read` is any GET, `backtest` runs simulations, `trade` changes what the bot does, `admin` manages users. */
export type Permission = 'read' | 'backtest' | 'trade' | 'admin';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  /** Decision 117: a share link signs in as this — it can look at everything and change nothing, not even run a backtest. */
  guest: ['read'],
  viewer: ['read', 'backtest'],
  trader: ['read', 'backtest', 'trade'],
  admin: ['read', 'backtest', 'trade', 'admin'],
};

export const ROLE_LABELS: Record<Role, string> = {
  guest: 'Read only (share links)',
  viewer: 'Backtest only',
  trader: 'Backtest and trade',
  admin: 'Administrator',
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as Role[];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as string[]).includes(v);
export function can(role: Role, p: Permission): boolean { return ROLE_PERMISSIONS[role]?.includes(p) ?? false; }

export interface User {
  id: number; username: string; displayName: string; role: Role;
  createdAt: number; lastLoginAt: number | null; disabled: boolean;
}
export interface Session { token: string; userId: number; createdAt: number; expiresAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
`;

export interface ShareLink { id: number; label: string; userId: number; createdBy: number | null; createdAt: number; expiresAt: number; revokedAt: number | null; uses: number; lastUsedAt: number | null }
/** The account every share link signs in as: a read-only guest nobody can log into with a password. */
export const SHARE_GUEST_USERNAME = 'share-guest';
export const SHARE_MAX_HOURS = 24 * 14;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** `scrypt$N$r$p$salt$hash`, all base64url. The parameters travel with the hash. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const actual = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

/** Rejects the passwords that make an audit embarrassing, without pretending to be a policy engine. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password must be under 200 characters';
  if (/^\d+$/.test(password)) return 'password must not be only digits';
  if (['password12', 'changeme12', '1234567890'].includes(password.toLowerCase())) return 'password is too common';
  return null;
}

export function usernameProblem(username: string): string | null {
  if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,31}$/i.test(username)) {
    return 'username must be 3–32 characters: letters, digits, dot, dash or underscore';
  }
  return null;
}

function rowToShare(r: any): ShareLink {
  return { id: r.id, label: r.label ?? '', userId: r.user_id, createdBy: r.created_by ?? null, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at ?? null, uses: r.uses ?? 0, lastUsedAt: r.last_used_at ?? null };
}

function rowToUser(r: any): User {
  return { id: r.id, username: r.username, displayName: r.display_name ?? '', role: isRole(r.role) ? r.role : 'viewer', createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null, disabled: Boolean(r.disabled) };
}

export class AuthStore {
  private db: Db;
  constructor(db: Db) { this.db = db; this.db.db.exec(SCHEMA); }

  countUsers(): number { return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? 0; }
  listUsers(): User[] { return this.db.all<any>('SELECT * FROM users ORDER BY username').map(rowToUser); }
  getUser(id: number): User | null { const r = this.db.get<any>('SELECT * FROM users WHERE id=?', id); return r ? rowToUser(r) : null; }
  byUsername(username: string): User | null { const r = this.db.get<any>('SELECT * FROM users WHERE username=? COLLATE NOCASE', username); return r ? rowToUser(r) : null; }

  createUser(input: { username: string; password: string; role: Role; displayName?: string }): User {
    const u = usernameProblem(input.username); if (u) throw new Error(u);
    const p = passwordProblem(input.password); if (p) throw new Error(p);
    if (!isRole(input.role)) throw new Error('unknown role');
    if (this.byUsername(input.username)) throw new Error('that username is taken');
    this.db.run('INSERT INTO users(username, display_name, password_hash, role, created_at, disabled) VALUES (?,?,?,?,?,0)',
      input.username, input.displayName ?? input.username, hashPassword(input.password), input.role, Date.now());
    return this.byUsername(input.username)!;
  }

  updateUser(id: number, patch: { role?: Role; displayName?: string; disabled?: boolean; password?: string }): User {
    const existing = this.getUser(id);
    if (!existing) throw new Error('unknown user');
    if (patch.role !== undefined) {
      if (!isRole(patch.role)) throw new Error('unknown role');
      // the last enabled administrator may not lock everyone out
      if (existing.role === 'admin' && patch.role !== 'admin' && this.otherActiveAdmins(id) === 0) throw new Error('this is the last administrator');
      this.db.run('UPDATE users SET role=? WHERE id=?', patch.role, id);
    }
    if (patch.displayName !== undefined) this.db.run('UPDATE users SET display_name=? WHERE id=?', String(patch.displayName).slice(0, 80), id);
    if (patch.disabled !== undefined) {
      if (patch.disabled && existing.role === 'admin' && this.otherActiveAdmins(id) === 0) throw new Error('this is the last administrator');
      this.db.run('UPDATE users SET disabled=? WHERE id=?', patch.disabled ? 1 : 0, id);
      if (patch.disabled) this.revokeAllFor(id);
    }
    if (patch.password !== undefined) {
      const p = passwordProblem(patch.password); if (p) throw new Error(p);
      this.db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(patch.password), id);
      this.revokeAllFor(id);   // a password change signs the account out everywhere
    }
    return this.getUser(id)!;
  }

  deleteUser(id: number): void {
    const existing = this.getUser(id);
    if (!existing) throw new Error('unknown user');
    if (existing.role === 'admin' && this.otherActiveAdmins(id) === 0) throw new Error('this is the last administrator');
    this.revokeAllFor(id);
    this.db.run('DELETE FROM users WHERE id=?', id);
  }

  private otherActiveAdmins(exceptId: number): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0 AND id<>?", exceptId)?.n ?? 0;
  }

  /** Returns the user on success, or null. Always runs a hash so a missing user is not faster. */
  login(username: string, password: string, at = Date.now()): User | null {
    const row = this.db.get<any>('SELECT * FROM users WHERE username=? COLLATE NOCASE', username);
    const stored = row?.password_hash ?? hashPassword('placeholder-for-constant-time');
    const ok = verifyPassword(String(password ?? ''), stored);
    if (!row || !ok || row.disabled) return null;
    this.db.run('UPDATE users SET last_login_at=? WHERE id=?', at, row.id);
    return rowToUser({ ...row, last_login_at: at });
  }

  // ---- sessions ----

  startSession(userId: number, at = Date.now(), expiresAt?: number): Session {
    const token = crypto.randomBytes(32).toString('base64url');
    const s: Session = { token, userId, createdAt: at, expiresAt: Math.min(at + SESSION_TTL_MS, expiresAt ?? Infinity) };
    this.db.run('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)', s.token, s.userId, s.createdAt, s.expiresAt);
    return s;
  }

  /** The user behind a session token, or null when it is unknown, expired or disabled. */
  resolve(token: string | null | undefined, at = Date.now()): User | null {
    if (!token) return null;
    const r = this.db.get<any>('SELECT * FROM sessions WHERE token=?', token);
    if (!r) return null;
    if (r.expires_at <= at) { this.revoke(token); return null; }
    const user = this.getUser(r.user_id);
    if (!user || user.disabled) return null;
    return user;
  }

  revoke(token: string): void { this.db.run('DELETE FROM sessions WHERE token=?', token); }

  // ---- share links (decision 117) ----

  /** The guest account share links sign in as, created on first use with a password nobody holds. */
  shareGuest(): User {
    const u = this.byUsername(SHARE_GUEST_USERNAME);
    if (u) return u;
    this.db.run('INSERT INTO users(username, display_name, password_hash, role, created_at, disabled) VALUES (?,?,?,?,?,0)',
      SHARE_GUEST_USERNAME, 'Share link guest', hashPassword(crypto.randomBytes(36).toString('base64url')), 'guest', Date.now());
    return this.byUsername(SHARE_GUEST_USERNAME)!;
  }

  /** A new link: the token is returned once and only its hash is kept. */
  createShareLink(input: { label?: string; hours: number; createdBy?: number | null }, at = Date.now()): { link: ShareLink; token: string } {
    const hours = Number(input.hours);
    if (!(hours > 0 && hours <= SHARE_MAX_HOURS)) throw new Error(`hours must be 1..${SHARE_MAX_HOURS}`);
    const guest = this.shareGuest();
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const label = String(input.label ?? '').slice(0, 80);
    const r = this.db.run('INSERT INTO share_links(token_hash, label, user_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)', hash, label, guest.id, input.createdBy ?? null, at, at + hours * 3_600_000);
    return { link: this.shareLink(Number(r.lastInsertRowid))!, token };
  }

  shareLink(id: number): ShareLink | null { const r = this.db.get<any>('SELECT * FROM share_links WHERE id=?', id); return r ? rowToShare(r) : null; }
  listShareLinks(): ShareLink[] { return this.db.all<any>('SELECT * FROM share_links ORDER BY created_at DESC').map(rowToShare); }

  /** Sign a visitor in through a link: a guest session that ends when the link does. Null when the link is unknown, revoked or expired. */
  redeemShareLink(token: string, at = Date.now()): { session: Session; link: ShareLink } | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = this.db.get<any>('SELECT * FROM share_links WHERE token_hash=?', hash);
    if (!r || r.revoked_at || r.expires_at <= at) return null;
    const guest = this.getUser(r.user_id);
    if (!guest || guest.disabled) return null;
    this.db.run('UPDATE share_links SET uses=uses+1, last_used_at=? WHERE id=?', at, r.id);
    return { session: this.startSession(guest.id, at, r.expires_at), link: this.shareLink(r.id)! };
  }

  /** Revoke a link, and with it every guest session, since a guest session cannot be told apart by its link. */
  revokeShareLink(id: number, at = Date.now()): ShareLink {
    const l = this.shareLink(id);
    if (!l) throw new Error('unknown share link');
    this.db.run('UPDATE share_links SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?', at, id);
    this.revokeAllFor(l.userId);
    return this.shareLink(id)!;
  }
  revokeAllFor(userId: number): void { this.db.run('DELETE FROM sessions WHERE user_id=?', userId); }
  sessionCount(userId: number): number { return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND expires_at>?', userId, Date.now())?.n ?? 0; }
  /** Drop expired rows; called on a timer so the table does not grow without bound. */
  sweep(at = Date.now()): number {
    const before = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')?.n ?? 0;
    this.db.run('DELETE FROM sessions WHERE expires_at<=?', at);
    return before - (this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')?.n ?? 0);
  }
}
