/**
 * Prefix honesty (decisions 85, 87). A script run on bars[0..n-cut] must raise the same entries, on the
 * same bars, as the run on all n bars, for every bar before the cut. A script whose earlier entries move
 * or vanish when later bars are hidden is reading the future; its history is not what a live run saw.
 */
import type { WorkerResult } from '../pine/worker.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScannerConfig } from '../config.ts';
import { applyRules } from './rules.ts';
import { extractEvents } from './extractor.ts';

export const REPAINT_CUT = Number(process.env.REPAINT_CUT ?? 60);
export const REPAINT_MAX_SHARE = 0.10;

export interface RepaintCheck { prefix: number; changed: number; share: number; repaints: boolean }

/** Entries up to `cutAt`, as "barTime:side" keys, read the way the scanner's config reads them. */
function entryKeys(res: WorkerResult, bars: Bar[], scannerId: string, sc: Partial<ScannerConfig>, cutAt: number): Set<string> {
  const derived = applyRules({ scannerId, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars, mode: 'backtest' });
  const events = extractEvents(res.alerts, res.shapes, { derived, sources: sc.sources, edge: sc.edge, labels: sc.labels, invert: sc.invert });
  return new Set(events.filter(e => e.kind === 'entry' && e.barTime <= cutAt).map(e => `${e.barTime}:${e.side}`));
}

/** Compare the full run with the run on the shortened history (the same script, the same reading). */
export function compareRepaint(full: WorkerResult, bars: Bar[], part: WorkerResult, partBars: Bar[], scannerId: string, sc: Partial<ScannerConfig>): RepaintCheck {
  const cutAt = partBars[partBars.length - 1].time;
  const a = entryKeys(full, bars, scannerId, sc, cutAt), b = entryKeys(part, partBars, scannerId, sc, cutAt);
  let changed = 0; for (const k of a) if (!b.has(k)) changed++; for (const k of b) if (!a.has(k)) changed++;
  const prefix = Math.max(a.size, b.size);
  const share = prefix ? changed / prefix : 0;
  return { prefix, changed, share, repaints: prefix >= 5 && share > REPAINT_MAX_SHARE };
}

export const repaintReason = (c: RepaintCheck) => `repaints: ${c.changed} of ${c.prefix} earlier entries changed when the last ${REPAINT_CUT} bars were hidden (${(c.share * 100).toFixed(0)}%)`;
