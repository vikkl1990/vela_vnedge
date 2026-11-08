/** Read-only recorded-event replay. Never imports exchange clients or changes a database. */
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {recentPairStop} from '../risk/reentry.ts';
import {pilotCapacityRefusal, pilotHorizon, pilotUsage, reservePilotEntry, type PilotConfig} from '../paper/pilotCapacity.ts';

type Position = {id:number;bt:number;status:string;scanner_id:string;symbol:string;tf:string;side:string;entry_at:number;exit_at:number|null;exit_reason:string|null;realized_pnl:number;fees:number;risk_amount:number;signal_id:number|null;pilot:number|null};
type Signal = {id:number;at:number;scanner_id:string;symbol:string;tf:string;side:string;action:string;position_id:number|null};
type Admission = {position_id:number|null;scanner_id:string;symbol:string;tf:string;at:number;stage:string};
export type Snapshot = {at:number;positions:Position[];signals:Signal[];shadow_admissions:Admission[];pilot_config:PilotConfig};
const net=(p:Position)=>p.realized_pnl-p.fees;
const r=(p:Position)=>p.risk_amount>0?net(p)/p.risk_amount:0;
const day=(at:number)=>Math.floor(at/86400_000);
const date=(at:number)=>new Date(at).toISOString().slice(0,10);
const stop=(p:Position)=>({symbol:p.symbol,scannerId:p.scanner_id,exitAt:p.exit_at,exitReason:p.exit_reason});
function totals(ps:Position[]) {
 const closed=ps.filter(p=>p.status==='closed');
 let equity=0,peak=0,drawdown=0;
 for(const p of [...closed].sort((a,b)=>a.exit_at!-b.exit_at!||a.id-b.id)){equity+=net(p);peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);}
 return {trades:closed.length,net:closed.reduce((s,p)=>s+net(p),0),netR:closed.reduce((s,p)=>s+r(p),0),wins:closed.filter(p=>net(p)>0).length,stops:closed.filter(p=>p.exit_reason==='sl').length,maxClosedDrawdown:drawdown};
}
/** Only accepted trades whose exits have already happened can start a cooldown. Book resets stay separate. */
export function replayReentry(positions:Position[],minutes=60) {
 const accepted:Position[]=[],removed:Position[]=[];
 for(const p of [...positions].filter(p=>p.status!=='pending').sort((a,b)=>a.entry_at-b.entry_at||a.id-b.id)) {
  const previous=accepted.filter(a=>a.bt===p.bt).map(stop);
  (recentPairStop(previous,p.symbol,p.entry_at,minutes)?removed:accepted).push(p);
 }
 const period=(from:number,to:number)=>{
  const take=(ps:Position[])=>ps.filter(p=>p.exit_at!==null&&p.exit_at>=from&&p.exit_at<to);
  const baseline=totals(take(positions)),changed=totals(take(accepted)),skipped=totals(take(removed));
  return {baseline,changed,skipped,dollarChange:changed.net-baseline.net,rChange:changed.netR-baseline.netR};
 };
 return {accepted,removed,period};
}
export type Candidate={signal:Signal;position:Position;source:'paper'|'shadow'};
/** Exact cell/side plus a unique admission within 5 seconds. No nearest later trade substitution. */
export function matchCandidates(s:Snapshot) {
 const positions=new Map(s.positions.map(p=>[p.id,p])),result:Candidate[]=[],unmatched:Signal[]=[];
 const signals=s.signals.filter(x=>x.action==='opened'||/^rejected:copy pilot (?:open position|daily entry) limit/.test(x.action));
 for(const signal of signals) {
  const actual=positions.get(signal.position_id??-1);
  if(actual?.pilot===1&&actual.signal_id===signal.id) {result.push({signal,position:actual,source:'paper'});continue;}
  const ids=new Set(s.shadow_admissions.filter(a=>a.scanner_id===signal.scanner_id&&a.symbol===signal.symbol&&a.tf===signal.tf&&a.at>=signal.at&&a.at-signal.at<=5000&&a.position_id!==null).map(a=>a.position_id!));
  const matches=[...ids].map(id=>positions.get(id)).filter((p):p is Position=>!!p&&p.side===signal.side&&p.status!=='pending'&&p.entry_at>=signal.at&&(p.exit_at===null||p.exit_at>=p.entry_at));
  if(matches.length===1)result.push({signal,position:matches[0],source:'shadow'});else unmatched.push(signal);
 }
 return {result,unmatched,total:signals.length};
}
/** Capacity only: recorded holding periods, identical candidate stream; no claim of executable P&L. */
export function replayCapacity(candidates:Candidate[],cfg:PilotConfig) {
 let usage=pilotUsage(undefined,0);let held:Candidate[]=[];
 const accepted:Candidate[]=[],rejected:{id:number;reason:string}[]=[];
 for(const c of [...candidates].sort((a,b)=>a.signal.at-b.signal.at||a.signal.id-b.signal.id)) {
  const at=c.signal.at;held=held.filter(p=>p.position.exit_at===null||p.position.exit_at>at);
  usage=pilotUsage(usage,day(at));
  const refusal=pilotCapacityRefusal(cfg,c.signal.tf,held.map(p=>({tf:p.signal.tf,features:{copy_pilot:1}})),usage);
  if(refusal){rejected.push({id:c.signal.id,reason:refusal});continue;}
  usage=reservePilotEntry(usage,c.signal.tf);held.push(c);accepted.push(c);
 }
 const byDay:Record<string,{scalp:number;swing:number}>={};
 for(const c of accepted){const key=date(c.signal.at);byDay[key]??={scalp:0,swing:0};byDay[key][pilotHorizon(c.signal.tf)!]++;}
 return {admitted:accepted.length,scalp:accepted.filter(c=>pilotHorizon(c.signal.tf)==='scalp').length,swing:accepted.filter(c=>pilotHorizon(c.signal.tf)==='swing').length,byDay,
  pathDiagnostics:Object.fromEntries(['paper','shadow'].map(source=>[source,{...totals(accepted.filter(c=>c.source===source).map(c=>c.position)),note:source==='shadow'?'Synthetic shadow dollar totals are not account P&L.':'Observed pilot paths; admission schedule is counterfactual.'}])),
  acceptedIds:accepted.map(c=>c.signal.id),rejected};
}
export function evaluate(s:Snapshot) {
 const paper=s.positions.filter(p=>p.bt===0||p.bt===-1),reentry=replayReentry(paper);
 const matched=matchCandidates(s),split={...s.pilot_config,byHorizon:{scalp:{maxOpenPositions:1,maxDailyEntries:8},swing:{maxOpenPositions:1,maxDailyEntries:2}}};
 return {capturedAt:new Date(s.at).toISOString(),reentry:{all:reentry.period(0,s.at+1),beforeNovember:reentry.period(0,Date.UTC(2026,10,1)),november:reentry.period(Date.UTC(2026,10,1),s.at+1),november8:reentry.period(Date.UTC(2026,10,8),Date.UTC(2026,10,9)),removedIds:reentry.removed.map(p=>p.id)},
  capacity:{eligibleEvents:matched.total,matched:matched.result.length,unmatched:matched.unmatched.length,unmatchedByDay:Object.fromEntries([...new Set(matched.unmatched.map(x=>date(x.at)))].map(d=>[d,matched.unmatched.filter(x=>date(x.at)===d).length])),baseline:replayCapacity(matched.result,s.pilot_config),split:replayCapacity(matched.result,split)},
  limitations:['Recorded paper trade replay keeps original prices, fees, funding, size and exits; replacement opportunities and portfolio interactions are not reconstructed.','Historical policies changed; November is a later chronological diagnostic, not untouched out-of-sample validation.','Capacity replay omits unmatched events and uses observed paper or uniquely matched shadow holding paths. It does not rerun account economics, liquidity, risk or signal gates for rejected candidates.','Shadow synthetic dollars are not paper returns. Capacity outcome diagnostics cannot establish a profitability improvement.','Admission uses only time-ordered closes. Holding paths are revealed only when their recorded exit time arrives. No outcome ranking or parameter search.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: node reentryPilotReplay.ts snapshot.json results.json');
 const result=evaluate(JSON.parse(readFileSync(input,'utf8')));writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({reentry:result.reentry,capacity:{...result.capacity,baseline:{...result.capacity.baseline,acceptedIds:undefined,rejected:undefined},split:{...result.capacity.split,acceptedIds:undefined,rejected:undefined}}},null,2));
}
