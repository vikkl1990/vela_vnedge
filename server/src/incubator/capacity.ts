import {admissionEvidence} from './evidencePriority.ts';
import type {PairRow} from './store.ts';
import type { IncubatorConfig } from '../config.ts';

type Cell = { id: number; symbol: string; tf: string };
export type Reservation = NonNullable<IncubatorConfig['admit']['reserve']>[number];
export const matchesReservation = (r: Reservation, c: Pick<Cell, 'symbol' | 'tf'>) =>
  (!r.tfs?.length || r.tfs.includes(c.tf)) && (!r.markets?.length || r.markets.includes(c.symbol));

/** Reservations are additive. One cell consumes at most one slot, in configured reservation order. */
export function shadowCapacity(active: Cell[], inc: Pick<IncubatorConfig, 'maxShadow' | 'admit'>) {
  const reserves = (inc.admit.reserve ?? []).filter(r => r.slots > 0)
    .map(r => ({ ...r, used: 0, free: r.slots }));
  let reserved = 0;
  for (const c of active) {
    const r = reserves.find(r => r.free > 0 && matchesReservation(r, c));
    if (r) { r.used++; r.free--; reserved++; }
  }
  const used = active.length - reserved;
  const general = { slots: inc.maxShadow, used, free: Math.max(0, inc.maxShadow - used) };
  return { total: inc.maxShadow + reserves.reduce((n, r) => n + r.slots, 0), used: active.length,
    free: general.free + reserves.reduce((n, r) => n + r.free, 0),
    overflow: Math.max(0, used - inc.maxShadow), general, reserves };
}

/** One deterministic allocation plan shared by admission and the UI's blocker explanation. */
export function selectAdmissions(active: PairRow[], candidates: PairRow[], inc: IncubatorConfig) {
  const capacity = shadowCapacity(active, inc), selected: PairRow[] = [], ids = new Set<number>();
  const held = new Map<string, number>();
  const key = (r: PairRow) => `${r.scannerId}|${r.tf}`;
  for (const r of active) held.set(key(r), (held.get(key(r)) ?? 0) + 1);
  const marketsFor = (tf: string) => inc.admit.cohortMarkets[tf] ?? inc.admit.cohortMarkets.default ?? 5;
  const capFor = (tf: string) => inc.admit.maxPerScannerTf?.[tf] ?? marketsFor(tf);
  const ranked = [...candidates].sort((a,b)=>admissionEvidence(b,inc).score-admissionEvidence(a,inc).score || a.id-b.id);
  const take = (r: PairRow) => {selected.push(r);ids.add(r.id);held.set(key(r),(held.get(key(r))??0)+1);};
  for (const res of capacity.reserves) {
    let room=res.free;
    for (const r of ranked) {
      if (!room) break;
      if (ids.has(r.id) || !matchesReservation(res,r) || (held.get(key(r))??0)>=capFor(r.tf)) continue;
      take(r);room--;
    }
  }
  let slots=capacity.general.free;
  const remaining=ranked.filter(r=>!ids.has(r.id));
  if (inc.gate.pool !== 'cohort') {
    for (const r of remaining) { if(!slots)break;if((held.get(key(r))??0)>=capFor(r.tf))continue;take(r);slots--; }
  } else {
    const groups=new Map<string,PairRow[]>();
    for(const r of remaining)groups.set(key(r),[...(groups.get(key(r))??[]),r]);
    const cohorts=[...groups.entries()].map(([k,rows])=>({rows,running:held.get(k)??0,score:admissionEvidence(rows[0],inc).score}));
    cohorts.sort((a,b)=>Number(b.running>0)-Number(a.running>0)||Number(b.rows.length>=inc.admit.minCohortMarkets)-Number(a.rows.length>=inc.admit.minCohortMarkets)||b.score-a.score);
    for(const c of cohorts){const room=Math.min(marketsFor(c.rows[0].tf)-c.running,c.rows.length,slots);if(room<=0||(!c.running&&room<Math.min(inc.admit.minCohortMarkets,c.rows.length)))continue;for(const r of c.rows.slice(0,room)){take(r);slots--;}}
  }
  const blockers=new Map<number,'capped'|'noSlot'|'cohort'>();
  for(const r of ranked)if(!ids.has(r.id))blockers.set(r.id,inc.gate.pool==='cohort'?'cohort':(held.get(key(r))??0)>=capFor(r.tf)?'capped':'noSlot');
  return {selected,blockers};
}
