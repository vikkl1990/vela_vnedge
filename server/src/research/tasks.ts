import { Worker } from 'node:worker_threads';

/** One CPU lane for fitting/replays, independent of Pine's reserved execution workers. */
class ResearchTasks {
  stopped = false;
  private queue: Array<{
    kind: string;
    input: unknown;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  private active: Worker | null = null;
  private kind: string | null = null;
  private completed = 0;
  private failed = 0;
  get status() {
    return {
      active: this.active ? 1 : 0,
      queued: this.queue.length,
      kind: this.kind,
      completed: this.completed,
      failed: this.failed,
      stopped: this.stopped,
    };
  }
  private completion: Promise<void> | null = null;
  run<T>(kind: string, input: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(Error('research stopped'));
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, input, resolve, reject });
      this.drain();
    });
  }
  private drain() {
    if (this.stopped || this.active || !this.queue.length) return;
    const job = this.queue.shift()!;
    this.kind = job.kind;
    const worker = (this.active = new Worker(new URL('./taskWorker.ts', import.meta.url), {
      workerData: { kind: job.kind, input: job.input },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    }));
    let settled = false;
    this.completion = new Promise<void>((done) => {
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        void worker.terminate().finally(() => {
          this.active = null;
          this.kind = null;
          this.completion = null;
          if (error) this.failed++;
          else this.completed++;
          if (error) job.reject(error);
          else job.resolve(value);
          done();
          this.drain();
        });
      };
      worker.once('message', (m) =>
        finish(m.ok ? null : Error(m.error ?? 'research calculation failed'), m.result),
      );
      worker.once('error', (e) => finish(e));
      worker.once('exit', (code) => {
        if (!settled) finish(Error(`research worker exited (${code})`));
      });
    });
  }
  async stop() {
    this.stopped = true;
    for (const job of this.queue.splice(0)) job.reject(Error('research stopped before calculation'));
    await this.active?.terminate();
    await this.completion;
  }
}
let tasks = new ResearchTasks();
export const startResearchTasks = () => {
  if (tasks.stopped) tasks = new ResearchTasks();
};
export const runResearchTask = <T>(kind: 'ml' | 'backtest' | 'walk-forward' | 'readiness', input: unknown) =>
  tasks.run<T>(kind, input);
export const stopResearchTasks = () => tasks.stop();

export const researchTaskStatus = () => tasks.status;
