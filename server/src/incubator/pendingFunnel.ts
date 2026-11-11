import type {Db} from '../db.ts';

type PendingObservation={key:string;at:number};
type PendingTrace={id:number;at:number;position_id:number;scanner_id:string;symbol:string;tf:string;signal_at:number};
/** Recover only an exact journal link. Never infer a fill from a nearby price/time or a reused ID.
 * This repairs diagnostic counts, not trades, qualifications or fees. */
export function recoverPendingFunnel(db:Db,observations:PendingObservation[],now:number) {
  if(!observations.length)return [];
  const wanted=new Map(observations.map(o=>[`${o.key}@${o.at}`,o]));
  const matches=new Map<string,PendingTrace[]>();
  const rows=db.all<PendingTrace>(`SELECT id,at,position_id,scanner_id,symbol,tf,
    json_extract(snapshot,'$.signalAt') signal_at FROM decision_trace
    WHERE book=2 AND stage='pending' AND position_id IS NOT NULL AND at>=? AND at<=? AND json_valid(snapshot)`,
    Math.min(...observations.map(o=>o.at)),now);
  for(const row of rows){const k=`${row.scanner_id}|${row.symbol}|${row.tf}@${row.signal_at}`;
    if(wanted.has(k))matches.set(k,[...(matches.get(k)??[]),row]);}
  const recovered:Array<PendingObservation&{id:number;kind:'pending'|'opened'|'other'}>=[];
  for(const [k,rs] of matches){
    if(rs.length!==1)continue; // ambiguous observation: retain it for audit
    const r=rs[0],o=wanted.get(k)!;
    const terminal=db.get<{stage:string;at:number}>(`SELECT stage,at FROM decision_trace
      WHERE book=2 AND position_id=? AND id>? AND at<=? AND stage IN ('pending','filled','cancelled') ORDER BY id LIMIT 1`,r.position_id,r.id,now);
    if(terminal?.stage==='cancelled'){recovered.push({...o,id:r.position_id,kind:'other'});continue;}
    if(terminal?.stage==='filled'){
      const fill=db.get(`SELECT 1 FROM orders WHERE bt=2 AND position_id=? AND scanner_id=? AND symbol=?
        AND reason='entry' AND qty>0 AND at>=? AND at<=? LIMIT 1`,r.position_id,r.scanner_id,r.symbol,r.at,terminal.at);
      if(fill)recovered.push({...o,id:r.position_id,kind:'opened'});
      continue;
    }
    if(terminal)continue; // ID reused before a provable terminal state
    const pending=db.get(`SELECT 1 FROM positions WHERE bt=2 AND id=? AND status='pending'
      AND scanner_id=? AND symbol=? AND tf=? AND entry_at=?`,r.position_id,r.scanner_id,r.symbol,r.tf,r.signal_at);
    if(pending)recovered.push({...o,id:r.position_id,kind:'pending'});
  }
  return recovered;
}
