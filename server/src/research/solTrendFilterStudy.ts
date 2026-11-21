import type {ExecutionPlan} from '../paper/executionPlans.ts';
import type {Db} from '../db.ts';
import {SOL_MAKER_FILTER_OFF,SOL_MAKER_FILTER_SOURCE,SOL_FILTER_PLAN_PREFIX} from '../scanners/solMakerExperiment.ts';

export const SOL_FILTER_PLANS:ExecutionPlan[]=['on-candle','off-candle','on-tick','off-tick'].map(arm=>({
 id:SOL_FILTER_PLAN_PREFIX+arm,revision:1,enabled:true,
 scannerId:arm.startsWith('off')?SOL_MAKER_FILTER_OFF:SOL_MAKER_FILTER_SOURCE,
 symbol:'SOLUSD',tf:'15m',variant:'current',referenceEquity:1000,
 ...(arm.endsWith('tick')?{makerFill:'tick-depth-v1' as const}:{}),
 label:`SOL trend filter ${arm.startsWith('on')?'ON':'OFF'} · ${arm.endsWith('tick')?'tick/depth':'current candle'} · current exits`,
}));

/** New study IDs start together. Never pool earlier control history or infer unfilled outcomes. */
export function solFilterResults(db:Pick<Db,'all'>){
 const arms=SOL_FILTER_PLANS.map(p=>{
  const cohorts=db.all<{scanner_id:string}>('SELECT scanner_id FROM execution_plan_cohorts WHERE plan_id=?',p.id);
  const mixedPolicies=cohorts.length>1;
  const scans=db.all<{n:number;last:number|null}>('SELECT count(*) n,max(s.at) last FROM execution_plan_scans s JOIN execution_plan_cohorts c ON c.scanner_id=s.scanner_id WHERE c.plan_id=?',p.id)[0];
  const events=db.all<{source_event:string;action:string;reason:string|null;position_id:number|null;filled_at:number|null;status:string|null;realized_pnl:number|null;fees:number|null;exit_reason:string|null}>(
   'SELECT e.source_event,e.action,e.reason,e.position_id,e.filled_at,p.status,p.realized_pnl,p.fees,p.exit_reason FROM execution_plan_events e LEFT JOIN positions p ON p.id=e.position_id WHERE e.plan_id=? ORDER BY e.at',p.id);
  const positions=[...new Map(events.filter(e=>e.position_id!==null&&['open','closed'].includes(e.status??'')).map(e=>[e.position_id,e])).values()];
  const closed=positions.filter(e=>e.status==='closed');
  const reasons:Record<string,number>={};for(const e of events)if(e.reason)reasons[e.reason]=(reasons[e.reason]??0)+1;
  return {id:p.id,filter:p.id.includes('-off-')?'off':'on',fillModel:p.makerFill?'tick-depth':'candle',
   scans:scans?.n??0,lastScanAt:scans?.last??null,mixedPolicies,cohorts:cohorts.map(c=>c.scanner_id),
   signals:events.length,filled:positions.length,open:positions.filter(e=>e.status==='open').length,
   pending:events.filter(e=>e.action==='pending'||e.status==='pending').length,
   closed:closed.length,net:closed.length&&!mixedPolicies?closed.reduce((s,e)=>s+e.realized_pnl!-e.fees!,0):null,
   stops:closed.length?closed.filter(e=>e.exit_reason==='sl').length:null,reasons,events};
 });
 const comparisons=['candle','tick-depth'].map(fillModel=>{
  const on=arms.find(a=>a.fillModel===fillModel&&a.filter==='on')!,off=arms.find(a=>a.fillModel===fillModel&&a.filter==='off')!;
  const key=(e:typeof on.events[number])=>{const k=JSON.parse(e.source_event);return JSON.stringify(k.slice(1));};
  const a=new Map(on.events.map(e=>[key(e),e])),b=new Map(off.events.map(e=>[key(e),e]));
  const shared=[...a.keys()].filter(k=>b.has(k));
  const mixedPolicies=on.mixedPolicies||off.mixedPolicies;
  const paired=mixedPolicies?[]:shared.map(k=>[a.get(k)!,b.get(k)!]).filter(([a,b])=>a.status==='closed'&&b.status==='closed');
  return {fillModel,mixedPolicies,sharedSignals:shared.length,onOnly:on.signals-shared.length,offOnly:off.signals-shared.length,matchedClosed:paired.length,
   matchedDeltaNet:paired.length?paired.reduce((s,[a,b])=>s+(b.realized_pnl!-b.fees!)-(a.realized_pnl!-a.fees!),0):null,
   matchedStopsOn:paired.filter(([a])=>a.exit_reason==='sl').length,matchedStopsOff:paired.filter(([,b])=>b.exit_reason==='sl').length,
   matchedWinnersCut:paired.filter(([a,b])=>a.realized_pnl!-a.fees!>0&&b.realized_pnl!-b.fees!<a.realized_pnl!-a.fees!-1e-8).length};
 });
 return {arms:arms.map(({events,...a})=>a),comparisons,promotionEligible:false,
  limitations:['Research plans use independent reference purses and full fees; account-level portfolio contention is not reproduced.',
   'Compare on/off within each fill model. Candle fills are not exchange fill proof; tick/depth prints do not establish queue priority.',
   'Unfilled, open or rejected entries have no assumed net outcome. Multiple policy versions are not pooled for profit comparisons. No automatic paper admission.']};
}

