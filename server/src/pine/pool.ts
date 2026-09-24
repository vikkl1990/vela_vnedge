import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.ts';
import type { WorkerJob, WorkerResult } from './worker.ts';

const log = logger.scoped('pool');
const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');
/** Heap ceiling per worker thread (MB); override with VNEDGE_WORKER_HEAP_MB. */
export const WORKER_HEAP_MB = Number(process.env.VNEDGE_WORKER_HEAP_MB) || 1536;

interface PoolWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  postMessage(job: WorkerJob): void;
  terminate(): Promise<number>;
}
interface Pending { job: WorkerJob; resolve: (r: WorkerResult) => void; startedAt?: number; queuedAt: number; deadline?: number; live: boolean }
/**
 * `live` is a current bar's evaluation, which can open or close a trade; `background` is
 * everything that can wait: backtests, warm-ups, the incubator's shadow runs and research.
 */
export type JobPriority = 'live' | 'background';
/** A live job still waiting after this long would act on a signal too old to trade: drop it. */
export const LIVE_QUEUE_DEADLINE_MS = 240_000;
interface Slot { w: PoolWorker; busy: Pending | null; index: number; ready: boolean; retiring: boolean }

/**
 * Fixed-size worker pool. Only the exit handler owns worker replacement. Two queues: live
 * evaluations always dispatch before background work, so research can delay itself but never a
 * trading decision.
 */
export class PinePool {
  private workers: Slot[] = [];
  private live: Pending[] = [];
  private queue: Pending[] = [];
  private nextId = 1;
  readonly size: number;
  /**
   * Workers background work may never occupy, so a bar close always finds one free. A pool of fewer
   * than four workers reserves none: research tooling runs a pool of one or two and has no live work.
   */
  readonly reserved: number;
  private expiredBackground = 0;
  readonly timeoutMs: number;
  private stopped = false;
  private timeoutTimer: ReturnType<typeof setInterval>;
  private createWorker: (index: number) => PoolWorker;

  /**
   * Workers default to one per core, capped at 12. Measured on an 8-core VM with live-shaped runs:
   * 4 workers 4.4 runs/s, 6 → 6.5, 8 → 7.5, 12 → 8.2, 16 → 7.6. Past the core count the gain turns
   * into queueing (p95 latency doubles from 8 to 16 workers), so oversubscribing is not free.
   */
  constructor(size = Math.max(2, Math.min(12, os.cpus()?.length ?? 4)), timeoutMs = 90_000,
    createWorker: (index: number) => PoolWorker = index => new Worker(WORKER_FILE, {
      workerData: { index }, execArgv: ['--no-warnings=ExperimentalWarning'],
      // A script that runs away with memory must fail its own job, not take the machine down:
      // one did, filling 22 GB until the VM stopped answering. V8 ends the worker at this heap
      // size, the pool fails the job and replaces the worker.
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    })) {
    this.size = size; this.reserved = size >= 4 ? Math.round(size / 4) : 0; this.timeoutMs = timeoutMs; this.createWorker = createWorker;
    for (let i = 0; i < size; i++) this.spawn(i);
    this.timeoutTimer = setInterval(() => this.reapTimeouts(), 5_000);
    this.timeoutTimer.unref();
  }

  get stats() {
    return {
      size: this.size, reserved: this.reserved, queued: this.queue.length + this.live.length, queuedLive: this.live.length,
      busy: this.workers.filter(w => w.busy).length, expiredLive: this.expiredLive, expiredBackground: this.expiredBackground,
    };
  }
  private expiredLive = 0;

  private fail(p: Pending, error: string) {
    p.resolve({ id: p.job.id, ok: false, error, ms: p.startedAt === undefined ? 0 : Date.now() - p.startedAt,
      bars: p.job.bars.length, lastBarTime: p.job.bars.at(-1)?.time ?? 0, warnings: 0, alerts: [], shapes: [], labels: [], plots: [] });
  }

  private retire(slot: Slot, error: string) {
    if (slot.retiring) return;
    slot.retiring = true;
    slot.ready = false;
    if (slot.busy) { this.fail(slot.busy, error); slot.busy = null; }
    // The eventual exit event replaces this slot exactly once.
    void slot.w.terminate().catch(e => log.error(`worker ${slot.index} termination failed: ${String(e)}`));
  }

  private spawn(index: number) {
    if (this.stopped) return;
    const w = this.createWorker(index);
    const slot: Slot = { w, busy: null, index, ready: false, retiring: false };
    this.workers[index] = slot;
    w.on('message', (msg: WorkerResult & { ready?: boolean }) => {
      if (this.stopped || slot.retiring || this.workers[index] !== slot) return;
      if (msg.ready) { slot.ready = true; this.pump(); return; }
      const p = slot.busy;
      if (p && p.job.id === msg.id) { slot.busy = null; p.resolve(msg); this.pump(); }
    });
    w.on('error', (err: Error & { code?: string }) => {
      // name the job that exhausted its heap, so a runaway script identifies itself in the log
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') log.error(`worker ${index} ran out of memory (cap ${WORKER_HEAP_MB} MB) on ${slot.busy?.job.scannerId ?? '?'} ${slot.busy?.job.symbol ?? ''}`);
      log.error(`worker ${index} crashed: ${err.message}`);
      this.retire(slot, 'worker crashed: ' + err.message);
    });
    w.on('exit', (code: number) => {
      if (this.workers[index] !== slot) return;
      slot.ready = false; slot.retiring = true;
      if (slot.busy) { this.fail(slot.busy, `worker exited with ${code}`); slot.busy = null; }
      if (!this.stopped) this.spawn(index);
    });
  }

  /**
   * `deadlineMs` gives a background job the same protection live jobs have: if it is still queued
   * when the deadline passes it is dropped rather than run. A shadow scan whose bar is already too
   * old to trade costs a worker and produces a signal the engine will reject as stale — the worst of
   * both, and the reason 48% of signals were being discarded on the VM.
   */
  run(job: Omit<WorkerJob, 'id'>, opts: { priority?: JobPriority; deadlineMs?: number } = {}): Promise<WorkerResult> {
    return new Promise(resolve => {
      const now = Date.now();
      const live = (opts.priority ?? 'background') === 'live';
      const ttl = opts.deadlineMs ?? (live ? LIVE_QUEUE_DEADLINE_MS : undefined);
      const p: Pending = { job: { ...job, id: this.nextId++ }, resolve, queuedAt: now, deadline: ttl === undefined ? undefined : now + ttl, live };
      if (this.stopped) { this.fail(p, 'worker pool stopped'); return; }
      (live ? this.live : this.queue).push(p);
      this.pump();
    });
  }

  /**
   * Next job to dispatch: live first, then background, dropping anything that waited past its
   * deadline. Background work never takes the last `reserved` workers, so a warm-up sweep of
   * 4,000-bar backtests cannot leave a bar close waiting for a free worker.
   */
  private next(canTakeReserved: boolean): Pending | undefined {
    const now = Date.now();
    const expired = (p: Pending) => p.deadline !== undefined && now > p.deadline;
    while (this.live.length) {
      const p = this.live.shift()!;
      if (expired(p)) { this.expiredLive++; this.fail(p, `expired after ${Math.round((now - p.queuedAt) / 1000)}s in the queue`); continue; }
      return p;
    }
    if (!canTakeReserved) return undefined;
    while (this.queue.length) {
      const p = this.queue.shift()!;
      if (expired(p)) { this.expiredBackground++; this.fail(p, `dropped after ${Math.round((now - p.queuedAt) / 1000)}s queued: too late to be useful`); continue; }
      return p;
    }
    return undefined;
  }

  private pump() {
    if (this.stopped) return;
    for (const slot of this.workers) {
      if (!slot.ready || slot.retiring || slot.busy || (this.queue.length === 0 && this.live.length === 0)) continue;
      const busyOnBackground = this.workers.filter(w => w.busy && !w.busy.live).length;
      const p = this.next(busyOnBackground < this.size - this.reserved);
      if (!p) continue;
      slot.busy = p; p.startedAt = Date.now();
      try { slot.w.postMessage(p.job); }
      catch (e) { this.retire(slot, `worker dispatch failed: ${String(e)}`); }
    }
  }

  private reapTimeouts() {
    const now = Date.now();
    for (const slot of this.workers) {
      const p = slot.busy;
      if (p?.startedAt !== undefined && now - p.startedAt > this.timeoutMs) {
        log.warn(`job ${p.job.scannerId} timed out; terminating worker ${slot.index}`);
        this.retire(slot, `timeout after ${this.timeoutMs}ms`);
      }
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timeoutTimer);
    for (const p of [...this.live.splice(0), ...this.queue.splice(0)]) this.fail(p, 'worker pool stopped');
    for (const slot of this.workers) {
      slot.retiring = true; slot.ready = false;
      if (slot.busy) { this.fail(slot.busy, 'worker pool stopped'); slot.busy = null; }
    }
    await Promise.all(this.workers.map(s => s.w.terminate()));
  }
}
