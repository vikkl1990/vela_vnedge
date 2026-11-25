/**
 * Worker-thread entry for ML training (improvement plan S4). It opens its own read-only
 * connection to the journal, reads and parses the samples and fits the models, so neither the
 * JSON parsing of up to 100k rows nor the regression fitting runs on the market-data event loop.
 * The main thread only applies and saves the result.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeTraining, eligibleSamples, rowsToSamples, TRAINING_ROW_LIMIT, type TrainingInput } from './training.ts';

const { file, input } = workerData as { file: string; input: TrainingInput };
try {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    const rows = db.prepare('SELECT * FROM ml_samples ORDER BY at DESC LIMIT ?').all(TRAINING_ROW_LIMIT);
    const all = eligibleSamples(rowsToSamples(rows), input);
    parentPort!.postMessage({ ok: true, result: computeTraining(all, input) });
  } finally { db.close(); }
} catch (e: any) {
  parentPort!.postMessage({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
}
