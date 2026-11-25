/** Runs one training in a short-lived worker thread and resolves with its result. */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrainingInput, TrainingResult } from './training.ts';

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'trainWorker.ts');
/** Heap for one training run: 100k samples and their models fit comfortably. */
const TRAIN_WORKER_HEAP_MB = 1024;
const TRAIN_TIMEOUT_MS = 5 * 60_000;

export type TrainInWorker = (file: string, input: TrainingInput) => Promise<TrainingResult>;

export interface TrainHandle { promise: Promise<TrainingResult>; terminate(): void }

export function startTrainingWorker(file: string, input: TrainingInput, timeoutMs = TRAIN_TIMEOUT_MS): TrainHandle {
  const worker = new Worker(WORKER_FILE, { workerData: { file, input }, execArgv: ['--no-warnings=ExperimentalWarning'], resourceLimits: { maxOldGenerationSizeMb: TRAIN_WORKER_HEAP_MB } });
  worker.unref();
  let settled = false;
  let cancel: () => void = () => {};
  const promise = new Promise<TrainingResult>((resolve, reject) => {
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); void worker.terminate(); };
    const timer = setTimeout(() => done(() => reject(new Error(`training worker timed out after ${timeoutMs} ms`))), timeoutMs);
    timer.unref();
    cancel = () => done(() => reject(new Error('training worker stopped')));
    worker.once('message', (m: { ok: boolean; result?: TrainingResult; error?: string }) => done(() => m.ok ? resolve(m.result!) : reject(new Error(m.error ?? 'training worker failed'))));
    worker.once('error', e => done(() => reject(e)));
    worker.once('exit', code => done(() => reject(new Error(`training worker exited with code ${code}`))));
  });
  return { promise, terminate: () => cancel() };
}
