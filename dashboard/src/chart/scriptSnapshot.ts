import type { ScriptRun } from '@luxalgo/vela'
export type ScriptSnapshot = Pick<ScriptRun, 'id' | 'title' | 'time' | 'forming' | 'complete' | 'cause' | 'plots'> & {tf: string; warnings: number}
export function snapshotRun(run: ScriptRun, tf: string): ScriptSnapshot {
  return {id: run.id, title: run.title, time: run.time, forming: run.forming, complete: run.complete, cause: run.cause,
    plots: {...run.plots}, tf, warnings: run.warnings.length}
}
