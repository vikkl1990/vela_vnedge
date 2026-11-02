import type { Db } from '../db.ts';

export function scannerWeekFunnel(db: Db, since = Date.now() - 7 * 86_400_000) {
  const out = new Map<string, { entries:number; opened:number; pending:number; gate:number; fee:number; regime:number; guard:number; pilot:number; protection:number; other:number }>();
  const rows = db.all<{scanner_id:string;k:string;n:number}>(`SELECT scanner_id, CASE
    WHEN action IN ('opened','reversed') THEN 'opened'
    WHEN action LIKE 'pending%' THEN 'pending'
    WHEN action LIKE 'rejected:copy pilot%' THEN 'pilot'
    WHEN action LIKE 'rejected:the scanner%s own stop:%' THEN 'protection'
    WHEN action LIKE 'rejected:risk market%' THEN 'gate'
    WHEN action LIKE 'rejected:stop too tight%' THEN 'fee'
    WHEN action LIKE 'rejected:risk regime%' OR action LIKE 'rejected:entry alignment%' THEN 'regime'
    WHEN action LIKE 'rejected:risk re-entry%' OR action LIKE 'rejected:risk burst%' THEN 'guard'
    ELSE 'other' END k, COUNT(*) n FROM signals WHERE kind='entry' AND at>? GROUP BY 1,2`,since);
  for (const r of rows) {
    const w=out.get(r.scanner_id)??{entries:0,opened:0,pending:0,gate:0,fee:0,regime:0,guard:0,pilot:0,protection:0,other:0};
    w.entries+=r.n;w[r.k as Exclude<keyof typeof w,'entries'>]+=r.n;out.set(r.scanner_id,w);
  }
  return out;
}
