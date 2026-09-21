import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

export interface LogFileOptions {
  /** Directory for `vnedge.log` (created if missing). */
  dir: string;
  /** Base file name, default `vnedge.log`. */
  name?: string;
  /** Rotate when the active file exceeds this many bytes. */
  maxBytes: number;
  /** Rotated generations kept (`name.1` … `name.N`); older ones are deleted. */
  maxFiles: number;
  /** Minimum level written to the file (defaults to the console level). */
  level?: LogLevel;
}

export interface LogFileStats {
  enabled: boolean;
  file: string | null;
  bytes: number;
  rotations: number;
  writeErrors: number;
  lastError: string | null;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 2000;

/**
 * Process-wide logger: console output (text or JSON via `LOG_FORMAT=json`), an in-memory ring
 * buffer for `/api/logs`, an `entry` event for SSE/metrics, and an optional size-rotated file
 * sink (`enableFile`). The file sink never throws: write failures are counted and surfaced in
 * `fileStats()` instead of crashing the process.
 */
class Logger extends EventEmitter {
  private ring: LogEntry[] = [];
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
  format: LogFormat = process.env.LOG_FORMAT === 'json' ? 'json' : 'text';
  /** Per-level counters since process start (metrics). */
  readonly counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };

  private file: { opts: Required<Omit<LogFileOptions, 'level'>> & { level: LogLevel }; path: string; fd: number | null; bytes: number; rotations: number; writeErrors: number; lastError: string | null } | null = null;

  log(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    const entry: LogEntry = { at: Date.now(), level, scope, msg, data };
    this.counts[level]++;
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    if (LEVELS[level] >= LEVELS[this.minLevel]) {
      const line = this.format === 'json' ? formatJson(entry) : formatText(entry);
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    if (this.file && LEVELS[level] >= LEVELS[this.file.opts.level]) this.writeFile(this.format === 'json' ? formatJson(entry) : formatText(entry));
    this.emit('entry', entry);
  }

  scoped(scope: string) {
    return {
      debug: (msg: string, data?: unknown) => this.log('debug', scope, msg, data),
      info: (msg: string, data?: unknown) => this.log('info', scope, msg, data),
      warn: (msg: string, data?: unknown) => this.log('warn', scope, msg, data),
      error: (msg: string, data?: unknown) => this.log('error', scope, msg, data),
    };
  }

  tail(limit = 200, level?: LogLevel): LogEntry[] {
    const min = level ? LEVELS[level] : 0;
    const out: LogEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      if (LEVELS[this.ring[i].level] >= min) out.push(this.ring[i]);
    }
    return out;
  }

  // ---- file sink with size/count rotation ----

  /** Start (or reconfigure) the rotating file sink. Safe to call repeatedly. */
  enableFile(opts: LogFileOptions): void {
    this.disableFile();
    const name = opts.name ?? 'vnedge.log';
    const full: Required<Omit<LogFileOptions, 'level'>> & { level: LogLevel } = { dir: opts.dir, name, maxBytes: Math.max(1024, opts.maxBytes), maxFiles: Math.max(1, Math.floor(opts.maxFiles)), level: opts.level ?? this.minLevel };
    const file = path.join(opts.dir, name);
    this.file = { opts: full, path: file, fd: null, bytes: 0, rotations: 0, writeErrors: 0, lastError: null };
    this.open();
  }

  disableFile(): void {
    if (!this.file) return;
    if (this.file.fd !== null) { try { fs.closeSync(this.file.fd); } catch { /* ignore */ } }
    this.file = null;
  }

  /** Flush + close the file descriptor (writes are synchronous, so this only closes). */
  flush(): void {
    const f = this.file;
    if (f && f.fd !== null) { try { fs.fsyncSync(f.fd); } catch { /* ignore */ } }
  }

  fileStats(): LogFileStats {
    const f = this.file;
    if (!f) return { enabled: false, file: null, bytes: 0, rotations: 0, writeErrors: 0, lastError: null };
    return { enabled: true, file: f.path, bytes: f.bytes, rotations: f.rotations, writeErrors: f.writeErrors, lastError: f.lastError };
  }

  /** Force a rotation now (also used by tests). Returns false when no file sink is active. */
  rotate(): boolean {
    const f = this.file;
    if (!f) return false;
    try {
      if (f.fd !== null) { fs.closeSync(f.fd); f.fd = null; }
      const { dir, name, maxFiles } = f.opts;
      // shift name.(N-1) → name.N …, drop anything beyond maxFiles
      for (let i = maxFiles; i >= 1; i--) {
        const from = i === 1 ? path.join(dir, name) : path.join(dir, `${name}.${i - 1}`);
        const to = path.join(dir, `${name}.${i}`);
        if (!fs.existsSync(from)) continue;
        if (i === maxFiles) { try { fs.rmSync(to, { force: true }); } catch { /* ignore */ } }
        fs.renameSync(from, to);
      }
      // anything older than maxFiles that a previous, larger setting left behind
      for (const entry of safeReaddir(dir)) {
        const m = entry.match(new RegExp(`^${escapeRe(name)}\\.(\\d+)$`));
        if (m && Number(m[1]) > maxFiles) { try { fs.rmSync(path.join(dir, entry), { force: true }); } catch { /* ignore */ } }
      }
      f.rotations++;
    } catch (e: any) {
      f.writeErrors++; f.lastError = String(e?.message ?? e);
    }
    this.open();
    return true;
  }

  private open() {
    const f = this.file;
    if (!f) return;
    try {
      fs.mkdirSync(f.opts.dir, { recursive: true });
      f.fd = fs.openSync(f.path, 'a');
      f.bytes = fs.fstatSync(f.fd).size;
    } catch (e: any) {
      f.fd = null; f.writeErrors++; f.lastError = String(e?.message ?? e);
    }
  }

  private writeFile(line: string) {
    const f = this.file;
    if (!f) return;
    const buf = Buffer.from(line + '\n', 'utf8');
    if (f.bytes + buf.length > f.opts.maxBytes && f.bytes > 0) this.rotate();
    if (f.fd === null) { this.open(); if (f.fd === null) return; }
    try { fs.writeSync(f.fd, buf); f.bytes += buf.length; }
    catch (e: any) { f.writeErrors++; f.lastError = String(e?.message ?? e); try { fs.closeSync(f.fd); } catch { /* ignore */ } f.fd = null; }
  }
}

function formatText(entry: LogEntry): string {
  const ts = new Date(entry.at).toISOString().slice(11, 23);
  const extra = entry.data === undefined ? '' : ' ' + safeJson(entry.data);
  return `${ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.msg}${extra}`;
}

function formatJson(entry: LogEntry): string {
  const o: Record<string, unknown> = { time: new Date(entry.at).toISOString(), level: entry.level, scope: entry.scope, msg: entry.msg };
  if (entry.data !== undefined) o.data = entry.data;
  try { return JSON.stringify(o); } catch { return JSON.stringify({ ...o, data: safeJson(entry.data) }); }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch {
    return String(v);
  }
}

function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger['scoped']>;
