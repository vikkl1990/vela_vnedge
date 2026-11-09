import { TF_SECONDS, type IncubatorConfig } from '../config.ts';

export type PilotHorizon = 'scalp' | 'swing';
export type PilotConfig = NonNullable<NonNullable<IncubatorConfig['mirror']>['pilot']>;
export interface PilotUsage { day: number; entries: number; byHorizon?: Record<PilotHorizon, number>; unclassified?: number }
export interface PilotHolding { tf: string; features?: Record<string, number> }
/** Zero disables only this pilot-specific cap; account risk and capital checks still apply. */
export const pilotLimitReached = (used: number, limit: number): boolean => limit > 0 && used >= limit;
export function pilotHorizon(tf: string): PilotHorizon | null {
  const seconds = TF_SECONDS[tf];
  return seconds > 0 ? seconds < 3600 ? 'scalp' : 'swing' : null;
}

/** Legacy reservations keep their global allowance and conservatively count toward both daily buckets. */
export function pilotUsage(saved: PilotUsage | undefined, day: number): Required<PilotUsage> {
  if (!saved || saved.day !== day) return { day, entries: 0, byHorizon: { scalp: 0, swing: 0 }, unclassified: 0 };
  const byHorizon = saved.byHorizon ?? { scalp: 0, swing: 0 };
  return { day, entries: saved.entries, byHorizon: { ...byHorizon }, unclassified: Math.max(saved.unclassified ?? 0, saved.entries - byHorizon.scalp - byHorizon.swing, 0) };
}

/** Open and pending reservations are passed together; native allocations do not consume pilot slots. */
export function pilotCapacityRefusal(cfg: PilotConfig, tf: string, holdings: PilotHolding[], usage: PilotUsage): string | null {
  const horizon = pilotHorizon(tf);
  if (!horizon) return 'copy pilot unsupported timeframe';
  const held = holdings.filter(p => p.features?.copy_pilot === 1);
  const state = pilotUsage(usage, usage.day), quota = cfg.byHorizon?.[horizon];
  if (pilotLimitReached(state.entries, cfg.maxDailyEntries)) return 'copy pilot daily entry limit';
  if (quota) {
    if (state.byHorizon[horizon] + state.unclassified >= quota.maxDailyEntries) return `copy pilot ${horizon} daily entry limit`;
    const used = held.filter(p => pilotHorizon(p.tf) === horizon).length;
    if (used >= quota.maxOpenPositions) return `copy pilot ${horizon} open position limit (${used}/${quota.maxOpenPositions})`;
  }
  if (pilotLimitReached(held.length, cfg.maxOpenPositions)) return 'copy pilot open position limit';
  return null;
}

/** Accepted pending orders reserve daily allowance once; cancellation never refunds it. */
export function reservePilotEntry(usage: PilotUsage, tf: string): Required<PilotUsage> {
  const next = pilotUsage(usage, usage.day), horizon = pilotHorizon(tf);
  if (!horizon) throw new Error('Cannot reserve an unknown pilot timeframe');
  next.entries++; next.byHorizon[horizon]++;
  return next;
}
