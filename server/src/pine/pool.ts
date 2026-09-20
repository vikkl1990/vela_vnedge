import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../log.ts';
import type { WorkerJob, WorkerResult } from './worker.ts';

const log = logger.scoped('pool');
const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.ts');

interface Pending { job: WorkerJob; resolve: (r: WorkerResult) => void; reject: (e: Error) => void; startedAt?: number; worker?: Worker }

/** Fixed-size worker_threads pool with per-job timeout and crash recovery. */
export class PinePool {
  private workers: Array<{ w: Worker; busy: Pending | null; index: number }> = [];
  private queue: Pending[] = [];
  private nextId = 1;
  readonly size: number;
  readonly timeoutMs: number;
  private stopped = false;

  constructor(size = Math.max(2, Math.min(6, (os.cpus()?.length ?? 4) - 1)), timeoutMs = 90_000) {
    this.size = size; this.timeoutMs = timeoutMs;
    for (let i = 0; i < size; i++) this.spawn(i);
    setInterval(() => this.reapTimeouts(), 5_000).unref();
  }

  get stats() { return { size: this.size, queued: this.queue.length, busy: this.workers.filter(w => w.busy).length }; }

  private spawn(index: number) {
    const w = new Worker(WORKER_FILE, { workerData: { index }, execArgv: ['--no-warnings=ExperimentalWarning'] });
    const slot = { w, busy: null as Pending | null, index };
    const existing = this.workers.findIndex(x => x.index === index);
    if (existing >= 0) this.workers[existing] = slot; else this.workers.push(slot);
    w.on('message', (msg: WorkerResult & { ready?: boolean }) => {
      if (msg.ready) { this.pump(); return; }
      const p = slot.busy;
      if (p && p.job.id === msg.id) { slot.busy = null; p.resolve(msg); this.pump(); }
    });
    w.on('error', (err) => {
      log.error(`worker ${index} crashed: ${err.message}`);
      const p = slot.busy; slot.busy = null;
      if (p) p.resolve({ id: p.job.id, ok: false, error: 'worker crashed: ' + err.message, ms: Date.now() - (p.startedAt ?? Date.now()), bars: p.job.bars.length, lastBarTime: p.job.bars.at(-1)?.time ?? 0, warnings: 0, alerts: [], shapes: [], labels: [], plots: [] });
      if (!this.stopped) setTimeout(() => this.spawn(index), 500);
    });
    w.on('exit', (code) => {
      if (this.stopped) return;
      if (code !== 0) { log.warn(`worker ${index} exited with ${code}, respawning`); setTimeout(() => this.spawn(index), 500); }
    });
  }

  run(job: Omit<WorkerJob, 'id'>): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const full = { ...job, id: this.nextId++ } as WorkerJob;
      this.queue.push({ job: full, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      slot.busy = p; p.startedAt = Date.now(); p.worker = slot.w;
      slot.w.postMessage(p.job);
    }
  }

  private reapTimeouts() {
    const now = Date.now();
    for (const slot of this.workers) {
      const p = slot.busy;
      if (p && p.startedAt && now - p.startedAt > this.timeoutMs) {
        log.warn(`job ${p.job.scannerId} ${p.job.symbol} ${p.job.tf} timed out after ${this.timeoutMs}ms; terminating worker ${slot.index}`);
        slot.busy = null;
        p.resolve({ id: p.job.id, ok: false, error: `timeout after ${this.timeoutMs}ms`, ms: now - p.startedAt, bars: p.job.bars.length, lastBarTime: p.job.bars.at(-1)?.time ?? 0, warnings: 0, alerts: [], shapes: [], labels: [], plots: [] });
        slot.w.terminate().then(() => this.spawn(slot.index));
      }
    }
  }

  async stop() {
    this.stopped = true;
    await Promise.all(this.workers.map(s => s.w.terminate()));
  }
}
