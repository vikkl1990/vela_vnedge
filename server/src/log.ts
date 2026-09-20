import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 2000;

class Logger extends EventEmitter {
  private ring: LogEntry[] = [];
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

  log(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    const entry: LogEntry = { at: Date.now(), level, scope, msg, data };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    if (LEVELS[level] >= LEVELS[this.minLevel]) {
      const ts = new Date(entry.at).toISOString().slice(11, 23);
      const extra = data === undefined ? '' : ' ' + safeJson(data);
      const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
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
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch {
    return String(v);
  }
}

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger['scoped']>;
