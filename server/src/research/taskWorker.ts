import { goLive } from '../analytics/golive.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { fitModels } from '../ml/fit.ts';
import { runBacktest } from '../paper/backtest.ts';
import { walkForward } from '../validation/walkForward.ts';
import type { Sample } from '../ml/model.ts';

try {
  const { kind, input } = workerData;
  let result: unknown;
  if (kind === 'ml') {
    let samples: Sample[] = input.samples,
      stored = input.stored,
      resetAt = input.resetAt;
    if (input.file !== ':memory:') {
      const db = new DatabaseSync(input.file, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=1000; BEGIN');
        samples = (db.prepare('SELECT * FROM ml_samples ORDER BY at DESC LIMIT 100000').all() as any[]).map(
          (r) => ({
            scannerId: r.scanner_id,
            symbol: r.symbol,
            tf: r.tf,
            at: r.at,
            features: JSON.parse(r.features),
            win: r.win,
            r: r.r,
            pnl: r.pnl,
            exitReason: r.exit_reason,
            bt: Boolean(r.bt),
            resolvedAt: r.resolved_at,
          }),
        );
        stored = (db.prepare('SELECT count(*) n FROM ml_samples').get() as { n: number }).n;
        const saved = db.prepare("SELECT v FROM kv WHERE k='paper.resetAt'").get() as
          { v: string } | undefined;
        resetAt = saved ? JSON.parse(saved.v) : 0;
      } finally {
        db.close();
      }
    }
    const excluded = new Set(input.excluded);
    result = fitModels(
      samples.filter(
        (s) =>
          !excluded.has(s.scannerId) &&
          s.resolvedAt != null &&
          Number.isFinite(s.resolvedAt) &&
          s.resolvedAt >= s.at &&
          s.resolvedAt <= input.at,
      ),
      input.names,
      stored,
      resetAt,
    );
  } else if (kind === 'backtest') result = runBacktest(input);
  else if (kind === 'walk-forward') result = walkForward(input);
  else if (kind === 'readiness') result = goLive(input);
  else throw Error('unknown research task');
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message.slice(0, 300) : 'research calculation failed',
  });
}
