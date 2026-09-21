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
export type Role = 'admin' | 'trader' | 'viewer';
/** `read` is any GET, `backtest` runs simulations, `trade` changes what the bot does, `admin` manages users. */
export type Permission = 'read' | 'backtest' | 'trade' | 'admin';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ['read', 'backtest'],
  trader: ['read', 'backtest', 'trade'],
  admin: ['read', 'backtest', 'trade', 'admin'],
};

export const ROLE_LABELS: Record<Role, string> = {
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
`;

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

  startSession(userId: number, at = Date.now()): Session {
    const token = crypto.randomBytes(32).toString('base64url');
    const s: Session = { token, userId, createdAt: at, expiresAt: at + SESSION_TTL_MS };
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
  revokeAllFor(userId: number): void { this.db.run('DELETE FROM sessions WHERE user_id=?', userId); }
  sessionCount(userId: number): number { return this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND expires_at>?', userId, Date.now())?.n ?? 0; }
  /** Drop expired rows; called on a timer so the table does not grow without bound. */
  sweep(at = Date.now()): number {
    const before = this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')?.n ?? 0;
    this.db.run('DELETE FROM sessions WHERE expires_at<=?', at);
    return before - (this.db.get<{ n: number }>('SELECT COUNT(*) n FROM sessions')?.n ?? 0);
  }
}
