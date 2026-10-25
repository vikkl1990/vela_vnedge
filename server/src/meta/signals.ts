/** Research-only per-scanner MTF evidence. No PaperEngine, order executor or live config mutation. */
import { createHash } from 'node:crypto';
import { TF_SECONDS } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { WorkerPlot } from '../pine/worker.ts';
import type { ScanEvent, Side } from '../scanners/extractor.ts';

export const META_VERSION = 1;
export const META_CONTRACTS = {
  'adaptive-macd': { contextPlot: 'MACD', triggerPlot: 'Histogram', trigger: 'zero-cross' },
  'adaptive-squeeze-momentum-pro': { contextPlot: 'Momentum', triggerPlot: 'Momentum', trigger: 'squeeze-release' },
} as const;
export type MetaScanner = keyof typeof META_CONTRACTS;
export const META_PROFILES = {
  scalp: { entryTf: '15m', contextTf: '1h', referenceTf: '4h' },
  swing: { entryTf: '1h', contextTf: '4h', referenceTf: '15m' },
} as const;
export type MetaProfile = keyof typeof META_PROFILES;
export interface MetaCell {
  scannerId: MetaScanner; symbol: string; tf: string; sourceHash: string; settingsHash: string;
  bars: Bar[]; plots: WorkerPlot[]; events: ScanEvent[];
  /** False means a displayed chart is not evidence of an active server observation. Research callers explicitly opt in. */
  scheduled: boolean;
  /** Actual per-bar run availability; omitted only by retrospective research, which explicitly assumes bar-close availability. */
  availableAt?: Record<number, number>;
  error?: string;
}
export interface CellEvidence {
  tf: string; sourceHash: string; settingsHash: string; barTime: number | null; closedAt: number | null;
  availableAt: number | null; availability: 'observed' | 'assumed-bar-close';
  state: Side | 'neutral' | 'unknown'; plot: string; value: number | null; reason: string | null;
}
export interface MetaDecision {
  researchOnly: true; version: number; scannerId: MetaScanner; symbol: string; profile: MetaProfile; at: number;
  status: 'WAIT' | 'READY_LONG' | 'READY_SHORT' | 'BLOCKED' | 'UNKNOWN'; reason: string;
  trigger: { side: Side; barTime: number; confirmedAt: number; expiresAt: number } | null;
  key: string | null; evidence: CellEvidence[]; reference: CellEvidence;
}
const step = (tf: string) => (TF_SECONDS[tf] ?? 0) * 1000;
function latestBar(cell: MetaCell, at: number): number {
  // Binary search requires the validated ascending input; the candle must have closed by decision time.
  let lo = 0, hi = cell.bars.length - 1, found = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cell.bars[m].time + step(cell.tf) <= at) { found = m; lo = m + 1; } else hi = m - 1; }
  return found;
}
function valueAt(cell: MetaCell, plot: string, time: number): number | null {
  const values = cell.plots.filter(p => p.title === plot);
  if (values.length !== 1) return null; // ambiguous plot names cannot silently pick a winner
  const data = values[0].data; let lo = 0, hi = data.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (data[m].time === time) { const v = data[m].value; return v !== null && Number.isFinite(v) ? v : null; } if (data[m].time < time) lo = m + 1; else hi = m - 1; }
  return null;
}
const direction = (v: number): Side | 'neutral' => v > 0 ? 'long' : v < 0 ? 'short' : 'neutral';

/** Build once per scanner/symbol history, then evaluate repeatedly without recalculating Pine. */
export function createMetaStudy(scannerId: MetaScanner, symbol: string, cells: MetaCell[]) {
  if (!META_CONTRACTS[scannerId]) throw new Error(`unsupported meta scanner: ${scannerId}`);
  const contract = META_CONTRACTS[scannerId], byTf = new Map<string, MetaCell>();
  for (const c of cells) {
    if (c.scannerId !== scannerId || c.symbol !== symbol) throw new Error('meta evidence mixes scanner or symbol');
    if (!step(c.tf) || byTf.has(c.tf)) throw new Error('invalid or duplicate meta timeframe');
    if (!c.sourceHash || !c.settingsHash) throw new Error('meta evidence needs source/settings fingerprints');
    for (let i = 0; i < c.bars.length; i++) if (!Number.isFinite(c.bars[i].time) || (i && c.bars[i].time <= c.bars[i - 1].time)) throw new Error('meta bars must be unique and ascending');
    for (const p of c.plots) for (let i = 0; i < p.data.length; i++) if (!Number.isFinite(p.data[i].time) || (i && p.data[i].time <= p.data[i - 1].time)) throw new Error('meta plots must be unique and ascending');
    byTf.set(c.tf, c);
  }
  function observe(tf: string, at: number, plot: string): CellEvidence {
    const c = byTf.get(tf); const i = c ? latestBar(c, at) : -1, time = i >= 0 ? c!.bars[i].time : null;
    const e: CellEvidence = { tf, sourceHash: c?.sourceHash ?? '', settingsHash: c?.settingsHash ?? '', barTime: time, closedAt: time === null ? null : time + step(tf), availableAt: c?.availableAt ? time === null ? null : c.availableAt[time] ?? null : time === null ? null : time + step(tf), availability: c?.availableAt ? 'observed' : 'assumed-bar-close', state: 'unknown', plot, value: null, reason: null };
    if (!c || !c.scheduled) e.reason = 'cell not observed/scheduled';
    else if (c.error) e.reason = `scanner error: ${c.error}`;
    else if (time === null) e.reason = 'no closed candle';
    else if (e.availableAt === null || !Number.isFinite(e.availableAt) || e.availableAt > at) e.reason = 'closed-bar scanner output not yet available';
    else if (at >= time + 2 * step(tf)) e.reason = 'closed candle is stale';
    else { e.value = valueAt(c, plot, time); if (e.value === null) e.reason = 'exact closed-bar plot missing/non-finite/ambiguous'; else e.state = direction(e.value); }
    return e;
  }
  const conflicts = new Map<string, Set<number>>();
  const triggers = new Map<string, Array<{ side: Side; barTime: number; confirmedAt: number; expiresAt: number }>>();
  for (const c of cells) {
    const events: Array<{ side: Side; barTime: number }> = [];
    if (contract.trigger === 'zero-cross') {
      for (let i = 1; i < c.bars.length; i++) {
        const before = c.bars[i - 1], bar = c.bars[i];
        if (bar.time - before.time !== step(c.tf)) continue; // do not invent a cross through a data gap
        const a = valueAt(c, contract.triggerPlot, before.time), b = valueAt(c, contract.triggerPlot, bar.time);
        if (a === null || b === null) continue;
        if (a <= 0 && b > 0) events.push({ side: 'long', barTime: bar.time });
        if (a >= 0 && b < 0) events.push({ side: 'short', barTime: bar.time });
      }
    } else {
      // Use the source's explicit squeeze-release contract, not generic bullish labels/divergences.
      for (const e of c.events) if (e.kind === 'entry' && e.side && /squeeze fired/i.test(e.label)) events.push({ side: e.side, barTime: e.barTime });
    }
    const grouped = new Map<number, Set<Side>>();
    for (const e of events) { const sides = grouped.get(e.barTime) ?? new Set<Side>(); sides.add(e.side); grouped.set(e.barTime, sides); }
    conflicts.set(c.tf, new Set([...grouped].filter(([, sides]) => sides.size > 1).map(([barTime]) => barTime)));
    triggers.set(c.tf, [...grouped].filter(([, sides]) => sides.size === 1).map(([barTime, sides]) => ({ side: [...sides][0], barTime, confirmedAt: barTime + step(c.tf), expiresAt: barTime + 2 * step(c.tf) })).sort((a, b) => a.confirmedAt - b.confirmedAt));
  }
  const evaluate = function evaluate(profile: MetaProfile, at: number): MetaDecision {
    if (!META_PROFILES[profile] || !Number.isFinite(at)) throw new Error('invalid meta profile/decision time');
    const p = META_PROFILES[profile];
    const evidence = [observe(p.entryTf, at, contract.triggerPlot), observe(p.contextTf, at, contract.contextPlot)];
    const reference = observe(p.referenceTf, at, contract.contextPlot);
    const candidates = triggers.get(p.entryTf) ?? []; let lo = 0, hi = candidates.length - 1, n = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (candidates[m].confirmedAt <= at) { n = m; lo = m + 1; } else hi = m - 1; }
    const trigger = n < 0 ? null : candidates[n];
    const result: MetaDecision = { researchOnly: true, version: META_VERSION, scannerId, symbol, profile, at, status: 'WAIT', reason: '', trigger, key: null, evidence, reference };
    const unknown = evidence.find(e => e.state === 'unknown');
    if (unknown) { result.status = 'UNKNOWN'; result.reason = `${unknown.tf}: ${unknown.reason}`; return result; }
    if (new Set(evidence.map(e => e.sourceHash)).size !== 1 || new Set(evidence.map(e => e.settingsHash)).size !== 1) { result.status = 'UNKNOWN'; result.reason = 'source/settings fingerprints differ across frames'; return result; }
    if (evidence[0].barTime !== null && conflicts.get(p.entryTf)?.has(evidence[0].barTime)) { result.status = 'UNKNOWN'; result.reason = 'contradictory triggers on the same entry candle'; return result; }
    if (!trigger) { result.reason = 'no confirmed trigger'; return result; }
    if (at >= trigger.expiresAt) { result.reason = 'trigger expired'; return result; }
    if (evidence[0].barTime !== trigger.barTime) { result.reason = 'trigger is not on the latest closed entry candle'; return result; }
    if (evidence[0].state !== trigger.side) { result.status = 'BLOCKED'; result.reason = 'trigger invalidated by its closed-bar plot'; return result; }
    if (evidence[1].state !== trigger.side) { result.status = 'BLOCKED'; result.reason = `${p.contextTf} context ${evidence[1].state} disagrees with ${trigger.side} trigger`; return result; }
    result.status = trigger.side === 'long' ? 'READY_LONG' : 'READY_SHORT';
    result.reason = `${p.entryTf} confirmed trigger with ${p.contextTf} context; ${p.referenceTf} is informational`;
    // Repeated evaluations of one trigger keep one key; consumers must persist seen keys before any future activation.
    result.key = createHash('sha256').update(JSON.stringify([META_VERSION, scannerId, symbol, profile, trigger.barTime, trigger.side, evidence.map(e => [e.sourceHash, e.settingsHash])])).digest('hex').slice(0, 24);
    return result;
  };
  return Object.assign(evaluate, {
    triggerTimes(profile: MetaProfile) {
      return (triggers.get(META_PROFILES[profile].entryTf) ?? []).map(t => ({ ...t }));
    },
  });
}
