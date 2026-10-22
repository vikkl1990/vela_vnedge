/**
 * Decision 174: screening on demand. A queue of hand runs of the nightly screen (`cli/incubate.ts` with `IDS=`): one at a
 * time, never while the nightly itself is running, each inside a capped user scope (6 GB, two workers, nice 19) so the
 * trading service is never squeezed. Progress is read from the job's own log lines; the queue and the last results are
 * kept in the kv store, so a restart keeps what was queued and marks what it interrupted.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../log.ts';
import type { Db } from '../db.ts';

const log = logger.scoped('screen-queue');
const KV = 'incubator.screenQueue';
const HISTORY = 20;
const SCOPE_MEMORY = '6G';

export type ScreenJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface ScreenJob {
  id: string;
  /** What the operator asked for: a script's name, "everything by LuxAlgo", a list. */
  label: string;
  ids: string[];
  tf: string;
  markets?: string[];
  actor: string;
  requestedAt: number;
  status: ScreenJobStatus;
  startedAt?: number;
  finishedAt?: number;
  progress?: { scripts: number; done: number; runs: number; passed: number };
  /** The job's own closing line: runs, passed, new candidates. */
  summary?: string;
  error?: string;
  /** The last lines the job printed, for the page. */
  tail: string[];
}
export interface ScreenQueueView { running: ScreenJob | null; queued: ScreenJob[]; history: ScreenJob[]; nightlyRunning: boolean; capped: boolean }

export interface ScreenQueueDeps {
  db: Db;
  /** Where the id files and logs go (`data/diag`). */
  diagDir: string;
  /** The server package directory, the job's working directory. */
  serverDir: string;
  /** True while the nightly screen's own process is alive. */
  nightlyRunning: () => boolean;
  /** Reaches the operator (the alert channel) when a job finishes. */
  notify?: (text: string) => void;
  /** Test seam: how the job is started. */
  spawnJob?: (args: { env: NodeJS.ProcessEnv; cwd: string; capped: boolean }) => ChildProcess;
  now?: () => number;
}

export class ScreenQueue extends EventEmitter {
  private queued: ScreenJob[] = [];
  private history: ScreenJob[] = [];
  private running: ScreenJob | null = null;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly capped: boolean;
  private deps: ScreenQueueDeps;

  constructor(deps: ScreenQueueDeps) {
    super();
    this.deps = deps;
    this.capped = fs.existsSync('/usr/bin/systemd-run') && process.platform === 'linux';
    const saved = deps.db.kvGet<{ queued: ScreenJob[]; history: ScreenJob[]; running: ScreenJob | null }>(KV);
    if (saved) {
      this.queued = saved.queued ?? [];
      this.history = saved.history ?? [];
      // a job the previous process was running did not survive it
      if (saved.running) this.history.unshift({ ...saved.running, status: 'failed', finishedAt: this.now(), error: 'interrupted by a restart' });
      this.persist();
    }
    fs.mkdirSync(deps.diagDir, { recursive: true });
  }

  private now() { return this.deps.now?.() ?? Date.now(); }

  start() {
    this.timer = setInterval(() => this.pump(), 30_000);
    this.timer.unref?.();
    this.pump();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): ScreenQueueView {
    return { running: this.running, queued: [...this.queued], history: [...this.history], nightlyRunning: this.deps.nightlyRunning(), capped: this.capped };
  }

  /** Queue a screen. The same list on the same timeframe already queued is returned rather than queued twice. */
  enqueue(req: { label: string; ids: string[]; tf: string; markets?: string[]; actor: string }): ScreenJob {
    const ids = [...new Set(req.ids)].sort();
    if (!ids.length) throw Object.assign(new Error('nothing to screen: no runnable script matched'), { status: 400 });
    const key = `${ids.join(',')}|${req.tf}|${(req.markets ?? []).join(',')}`;
    const same = [this.running, ...this.queued].find(j => j && `${[...j.ids].sort().join(',')}|${j.tf}|${(j.markets ?? []).join(',')}` === key);
    if (same) return same;
    const job: ScreenJob = { id: `${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`, label: req.label, ids, tf: req.tf, markets: req.markets?.length ? req.markets : undefined, actor: req.actor, requestedAt: this.now(), status: 'queued', tail: [] };
    this.queued.push(job);
    this.persist();
    log.info(`queued ${job.id}: ${job.label} (${ids.length} scripts, ${job.tf}) by ${req.actor}`);
    this.emit('change');
    this.pump();
    return job;
  }

  cancel(id: string, actor: string): ScreenJob {
    const qi = this.queued.findIndex(j => j.id === id);
    if (qi >= 0) {
      const [job] = this.queued.splice(qi, 1);
      job.status = 'cancelled'; job.finishedAt = this.now(); job.error = `cancelled by ${actor}`;
      this.remember(job);
      return job;
    }
    if (this.running?.id === id) {
      this.running.error = `cancelled by ${actor}`;
      this.child?.kill('SIGTERM');
      return this.running;
    }
    throw Object.assign(new Error('no such screen job'), { status: 404 });
  }

  private pump() {
    if (this.running || !this.queued.length) return;
    if (this.deps.nightlyRunning()) return;    // the nightly has the machine; the queue waits for it
    const job = this.queued.shift()!;
    this.run(job);
  }

  private run(job: ScreenJob) {
    const idsFile = path.join(this.deps.diagDir, `screen-${job.id}.ids`);
    fs.writeFileSync(idsFile, job.ids.join('\n') + '\n');
    const logFile = path.join(this.deps.diagDir, `screen-${job.id}.log`);
    const env: NodeJS.ProcessEnv = { ...process.env, IDS: idsFile, TF: job.tf, WORKERS: process.env.SCREEN_WORKERS || '2', NODE_ENV: process.env.NODE_ENV ?? 'production' };
    if (job.markets?.length) env.MARKETS = job.markets.join(',');
    job.status = 'running'; job.startedAt = this.now(); job.tail = [];
    this.running = job;
    this.persist();
    let child: ChildProcess;
    try {
      child = this.deps.spawnJob ? this.deps.spawnJob({ env, cwd: this.deps.serverDir, capped: this.capped }) : this.spawnDefault(env);
    } catch (e: any) {
      this.finish(job, 'failed', `could not start: ${e?.message ?? e}`);
      return;
    }
    this.child = child;
    log.info(`screen ${job.id} started: ${job.label} (${job.ids.length} scripts, ${job.tf}${job.markets ? `, ${job.markets.length} markets` : ''})${this.capped ? ', capped' : ''}`);
    let buf = '';
    const onLine = (line: string) => {
      try { fs.appendFileSync(logFile, line + '\n'); } catch { /* the log is a convenience */ }
      job.tail = [...job.tail.slice(-11), line.replace(/^\[incubate [^\]]+\] /, '')];
      const p = /(\d+)\/(\d+) scripts(?: · (\d+) runs)?(?: · (\d+) passed)?/.exec(line);
      if (p) job.progress = { done: Number(p[1]), scripts: Number(p[2]), runs: Number(p[3] ?? job.progress?.runs ?? 0), passed: Number(p[4] ?? job.progress?.passed ?? 0) };
      const s = /screen: (\d+) runs, (\d+) passed \((\d+) new candidates\)[^\n]*/.exec(line);
      if (s) { job.summary = s[0]; job.progress = { ...(job.progress ?? { done: 0, scripts: job.ids.length }), runs: Number(s[1]), passed: Number(s[2]) }; }
    };
    const onData = (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => this.finish(job, 'failed', String(e?.message ?? e)));
    child.on('exit', (code, signal) => {
      if (buf) onLine(buf);
      if (job.error?.startsWith('cancelled')) this.finish(job, 'cancelled', job.error);
      else if (code === 0) this.finish(job, 'done');
      else this.finish(job, 'failed', `exit ${code ?? signal}: ${job.tail.at(-1) ?? ''}`);
    });
  }

  private spawnDefault(env: NodeJS.ProcessEnv): ChildProcess {
    const node = process.execPath;
    const args = ['--no-warnings=ExperimentalWarning', '--max-old-space-size=3072', 'src/cli/incubate.ts'];
    if (this.capped) {
      const uid = process.getuid?.() ?? 1000;
      const scoped = { ...env, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=/run/user/${uid}/bus` };
      return spawn('systemd-run', ['--user', '--scope', '-q', '-p', `MemoryMax=${SCOPE_MEMORY}`, '-p', 'MemorySwapMax=0', 'nice', '-n', '19', node, ...args], { cwd: this.deps.serverDir, env: scoped, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return spawn(node, args, { cwd: this.deps.serverDir, env: { ...env, WORKERS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  private finish(job: ScreenJob, status: ScreenJobStatus, error?: string) {
    if (this.running?.id !== job.id) return;
    job.status = status; job.finishedAt = this.now(); if (error) job.error = error;
    this.running = null; this.child = null;
    this.remember(job);
    const mins = job.startedAt ? Math.round((job.finishedAt - job.startedAt) / 60_000) : 0;
    const text = status === 'done' ? `Screen done: ${job.label} (${job.ids.length} scripts, ${job.tf}) in ${mins} min · ${job.summary ?? 'no summary'}` : `Screen ${status}: ${job.label} (${job.tf}) · ${job.error ?? ''}`;
    log.info(text);
    try { this.deps.notify?.(text); } catch { /* the channel's own problem */ }
    this.emit('change');
    this.pump();
  }

  private remember(job: ScreenJob) {
    this.history.unshift(job);
    if (this.history.length > HISTORY) this.history.length = HISTORY;
    this.persist();
    this.emit('change');
  }

  private persist() {
    this.deps.db.kvSet(KV, { queued: this.queued, history: this.history, running: this.running });
  }
}
