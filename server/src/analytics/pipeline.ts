import type {Db} from '../db.ts';
export function scannerPipeline(db:Db, cells:Array<{scannerId:string;symbol:string;tf:string}>,now=Date.now()) {
 const since=now-86400000;
 return {at:now,since,cells:cells.map(cell=>{
  const run=db.get<any>('SELECT at,error,funnel FROM scanner_runs WHERE scanner_id=? AND symbol=? AND tf=?',cell.scannerId,cell.symbol,cell.tf);
  const actions=db.all<{action:string;n:number}>("SELECT action,count(*) n FROM signals WHERE scanner_id=? AND symbol=? AND tf=? AND kind='entry' AND at>=? GROUP BY action",cell.scannerId,cell.symbol,cell.tf,since);
  const latest=db.get<any>("SELECT at,action,label FROM signals WHERE scanner_id=? AND symbol=? AND tf=? AND kind='entry' ORDER BY at DESC LIMIT 1",cell.scannerId,cell.symbol,cell.tf);
  const runs=db.get<{n:number;fail:number}>("SELECT count(*) n,coalesce(sum(outcome!='ok'),0) fail FROM scanner_run_log WHERE scanner_id=? AND symbol=? AND tf=? AND at>=?",cell.scannerId,cell.symbol,cell.tf,since);
  let funnel=null;try{funnel=run?.funnel?JSON.parse(run.funnel):null;}catch{ /* advisory legacy data */ }
  return {...cell,lastRun:run?.at??null,error:run?.error??null,funnel,runs:runs?.n??0,failures:runs?.fail??0,entries24h:actions.reduce((s,a)=>s+a.n,0),actions,latest:latest??null};
 })};
}
