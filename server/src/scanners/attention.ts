import type {IncubatorStore,PairRow} from '../incubator/store.ts';
import type {AppConfig} from '../config.ts';
import type {ScannerWeek} from './activity.ts';

/** Current evidence is separate from the historical entry funnel. This never enrolls or admits a cell. */
export function scannerAttentionReadiness(input:{
 scanners:Array<{id:string;enabled:boolean;hidden?:boolean;scheduledCells:number}>;
 week:Map<string,ScannerWeek>;pairs:PairRow[];store:Pick<IncubatorStore,'copyRefusal'>;
 mirror:AppConfig['incubator']['mirror'];copyEnabled:boolean;at:number;
 turnover:(symbol:string)=>number|null;
}){
 const result=new Map<string,{at:number;copyEnabled:boolean;shadow:number;eligible:number;tracked:number;candidates:number;
   holds:Array<{symbol:string;tf:string;reason:string}>}>();
 const selected=new Set(input.scanners.filter(s=>!s.hidden&&((s.enabled&&s.scheduledCells===0)||
  ((input.week.get(s.id)?.entries??0)>=3&&input.week.get(s.id)?.opened===0))).map(s=>s.id));
 for(const id of selected)result.set(id,{at:input.at,copyEnabled:input.copyEnabled,shadow:0,eligible:0,tracked:0,candidates:0,holds:[]});
 for(const p of input.pairs){
  const r=result.get(p.scannerId);if(!r)continue;
  if(p.stage==='tracked'){r.tracked++;continue;}
  if(p.stage==='candidate'){r.candidates++;continue;}
  if(p.stage!=='shadow'&&p.stage!=='proposed')continue;
  r.shadow++;
  let reason:string|null;
  try{reason=input.store.copyRefusal(p,input.mirror,input.turnover(p.symbol),input.at,{readOnly:true});}
  catch{reason='Eligibility check unavailable; inspect this scanner configuration. This cell is not verified for copying.';}
  if(reason===null)r.eligible++;else if(r.holds.length<3)r.holds.push({symbol:p.symbol,tf:p.tf,reason});
 }
 return result;
}
