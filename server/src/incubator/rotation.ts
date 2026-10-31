import { TF_SECONDS, type AppConfig } from '../config.ts';
import { shadowCapacity, matchesReservation } from './capacity.ts';
import { admissionEvidence } from './evidencePriority.ts';
import type { IncubatorStore, PairRow } from './store.ts';

const DAY = 86400_000;
export interface RotationState {
  day: number; used: number;
  paused: Record<string, { at: number; until: number; since: number; replacementId: number }>;
  last: Array<{ at: number; out: number; in: number }>;
}
export const emptyRotation = (): RotationState => ({ day: 0, used: 0, paused: {}, last: [] });

/** Only swap never-filled research cells. A timeout is not evidence of a losing strategy. */
export function rotateIdleCells(store: IncubatorStore, cfg: AppConfig, waiting: PairRow[], now: number, unavailable?: (id: string) => string | null): PairRow[] {
  const inc = cfg.incubator, policy = inc.admit.rotation;
  if (!policy?.enabled || inc.gate.pool !== 'pair' || !waiting.length) return [];
  const state = store.rotationState(), day = Math.floor(now / DAY);
  if (state.day !== day) { state.day = day; state.used = 0; }
  if (state.used >= policy.maxPerDay) return [];
  let active = store.list(['shadow', 'proposed']);
  const marks = store.liveMarks() ?? {}, admitted: PairRow[] = [];
  const candidates = [...waiting].sort((a, b) => a.since - b.since || admissionEvidence(b, inc).score - admissionEvidence(a, inc).score || a.id - b.id);
  for (const old of [...active].sort((a, b) => a.since - b.since || a.id - b.id)) {
    if (state.used >= policy.maxPerDay) break;
    const days = policy.idleDaysByTf[old.tf];
    const lastScan = marks[`${old.scannerId}:${old.symbol}:${old.tf}`] ?? 0;
    // Successful, recent execution is required: starvation, failures and downtime are not silence.
    if (old.stage !== 'shadow' || !(days > 0) || now - old.since < days * DAY || unavailable?.(old.scannerId)
      || now - lastScan > Math.max(3600_000, 3 * (TF_SECONDS[old.tf] ?? 0) * 1000)
      || store.shadowHolds(old) || store.shadowLastEntryAt(old, old.since) !== null) continue;
    const before = shadowCapacity(active, inc), remaining = active.filter(r => r.id !== old.id);
    const capacity = shadowCapacity(remaining, inc);
    const next = candidates.find(r => {
      if (r.id === old.id || admitted.some(a => a.id === r.id)) return false;
      const cap = inc.admit.maxPerScannerTf?.[r.tf] ?? inc.admit.cohortMarkets[r.tf] ?? inc.admit.cohortMarkets.default ?? 5;
      if (remaining.filter(a => a.scannerId === r.scannerId && a.tf === r.tf).length >= cap) return false;
      // Don't rotate to fill a slot already available. Normal admission owns that work.
      if (before.general.free || before.reserves.some(x => x.free && matchesReservation(x, r))) return false;
      if (!(capacity.general.free || capacity.reserves.some(x => x.free && matchesReservation(x, r)))) return false;
      return shadowCapacity([...remaining, r], inc).overflow <= before.overflow;
    });
    if (!next) continue;
    state.used++;
    state.paused[old.id] = { at: now, until: now + policy.cooldownDays * DAY, since: old.since, replacementId: next.id };
    state.last = [...state.last, { at: now, out: old.id, in: next.id }].slice(-50);
    // Both moves, their audit events and the daily budget commit together.
    const replacement = store.rotate(old, next, state, now);
    admitted.push(replacement); active = [...remaining, replacement];
  }
  return admitted;
}
