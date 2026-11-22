import type { Db } from '../db.ts';

export interface ScannerWeek {
 entries:number; opened:number; pending:number; gate:number; fee:number; regime:number; guard:number; pilot:number; protection:number; other:number;
 lastEntryAt:number; reasons:Array<{action:string;symbol:string;tf:string;n:number;lastAt:number}>;
}
export function scannerWeekFunnel(db: Db, since = Date.now() - 7 * 86_400_000) {
  const out = new Map<string, ScannerWeek>();
  const rows = db.all<{scanner_id:string;k:string;action:string;symbol:string;tf:string;n:number;lastAt:number}>(`SELECT scanner_id, action, symbol, tf, MAX(at) lastAt, CASE
    WHEN action IN ('opened','reversed') THEN 'opened'
    WHEN action LIKE 'pending%' THEN 'pending'
    WHEN action LIKE 'rejected:copy pilot%' THEN 'pilot'
    WHEN action LIKE 'rejected:the scanner%s own stop:%' THEN 'protection'
    WHEN action LIKE 'rejected:risk market%' THEN 'gate'
    WHEN action LIKE 'rejected:stop too tight%' THEN 'fee'
    WHEN action LIKE 'rejected:risk regime%' OR action LIKE 'rejected:entry alignment%' THEN 'regime'
    WHEN action LIKE 'rejected:risk re-entry%' OR action LIKE 'rejected:risk burst%' THEN 'guard'
    ELSE 'other' END k, COUNT(*) n FROM signals WHERE kind='entry' AND at>? GROUP BY scanner_id,action,symbol,tf`,since);
  for (const r of rows) {
    const w=out.get(r.scanner_id)??{entries:0,opened:0,pending:0,gate:0,fee:0,regime:0,guard:0,pilot:0,protection:0,other:0,lastEntryAt:0,reasons:[]};
    w.entries+=r.n;w[r.k as 'opened'|'pending'|'gate'|'fee'|'regime'|'guard'|'pilot'|'protection'|'other']+=r.n;
    w.lastEntryAt=Math.max(w.lastEntryAt,r.lastAt);
    if(r.k!=='opened'&&r.k!=='pending')w.reasons.push({action:r.action,symbol:r.symbol,tf:r.tf,n:r.n,lastAt:r.lastAt});
    out.set(r.scanner_id,w);
  }
  // Bound the payload, not the counts: retain the three most frequent exact refusals.
  for(const w of out.values())w.reasons=w.reasons.sort((a,b)=>b.n-a.n||b.lastAt-a.lastAt||a.action.localeCompare(b.action)).slice(0,3);
  return out;
}
