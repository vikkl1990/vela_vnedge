/**
 * Worker-thread factory that records every spawn, so respawns (crash / timeout replacements)
 * can be counted without touching the pool. Passed to `PinePool` as its `createWorker`.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pine', 'worker.ts');

export class WorkerTracker {
  private spawnsByIndex = new Map<number, number>();
  /** Timestamps of respawns (any spawn after the first for an index). */
  private respawnTimes: number[] = [];
  spawns = 0;
  respawns = 0;

  /** `createWorker` for `PinePool`. */
  factory = (index: number): Worker => {
    this.note(index);
    return new Worker(WORKER_FILE, { workerData: { index }, execArgv: ['--no-warnings=ExperimentalWarning'] });
  };

  /** Record a spawn for `index` (exposed so tests can drive it without real threads). */
  note(index: number, now = Date.now()) {
    const n = (this.spawnsByIndex.get(index) ?? 0) + 1;
    this.spawnsByIndex.set(index, n);
    this.spawns++;
    if (n > 1) { this.respawns++; this.respawnTimes.push(now); if (this.respawnTimes.length > 1000) this.respawnTimes.splice(0, this.respawnTimes.length - 1000); }
  }

  /** Respawns within the trailing `windowMs`. */
  respawnsWithin(windowMs: number, now = Date.now()): number {
    const cut = now - windowMs;
    let i = this.respawnTimes.length - 1, n = 0;
    while (i >= 0 && this.respawnTimes[i] >= cut) { n++; i--; }
    return n;
  }
}
