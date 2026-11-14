/** Exact, versioned JSON contracts for three newly imported MarkitTick sources.
 * Their author payload proposes levels at observation time, never a past fill.
 * Other authors and MarkitTick's more complex lifecycle scripts are untouched.
 */
import type {WorkerAlert} from '../pine/worker.ts';
import type {ExtractOptions,ScanEvent} from './extractor.ts';
import {createHash} from 'node:crypto';

export const MARKITTICK_NATIVE:Readonly<Record<string,string>>={
 'mesa-adaptive-cycle-engine-markittick':'ec90bc45c6f7bf383d19ec0afeb46a5b6288b69ade9384aa6c94f9fd74064666',
 'squeeze-bollinger-bands-tracker-markittick':'bfa4f899f3b45bf8bc2e9b31d2c789d81a48e171de15e1c3e35576957d58f239',
 'garch-volumetric-cloud-markittick':'22db7561400bee1289fedc4bf32317d1aaf339ed89eb80e814886c95c68fb8ae',
};
/** A public-source update must be reviewed before its native JSON reader runs. */
export function markitTickSourceError(id:string,source:string):string|null {
 const expected=MARKITTICK_NATIVE[id];
 return expected&&createHash('sha256').update(source).digest('hex')!==expected
  ? 'MarkitTick native source changed; reader and bracket parity must be revalidated' : null;
}
export function readMarkitTick(alerts:WorkerAlert[],opts:ExtractOptions):ScanEvent[]{
 if(opts.reader!==2||opts.invert||opts.sources&&!opts.sources.includes('alert'))return [];
 const out:ScanEvent[]=[],seen=new Set<string>();
 const number=(v:unknown)=> typeof v==='number'&&Number.isFinite(v)&&v>0?v:typeof v==='string'&&v.trim()&&Number.isFinite(Number(v))&&Number(v)>0?Number(v):undefined;
 for(const a of alerts){
  if(a.type!=='alert'||opts.sinceBarTime!==undefined&&a.time<opts.sinceBarTime)continue;
  let j:any;try{j=JSON.parse(a.message);}catch{continue;}
  if(!j||typeof j!=='object'||Array.isArray(j))continue;
  const action=String(j.action??'').toLowerCase();
  const side=action==='long'||action==='buy'?'long':action==='short'||action==='sell'?'short':null;
  if(!side)continue;
  const price=number(j.entry),sl=number(j.sl),tp=number(j.tp);
  // No generic ATR fallback when the author's proposed bracket is missing or inverted.
  if(price===undefined||sl===undefined||tp===undefined||(side==='long'?!(sl<price&&price<tp):!(tp<price&&price<sl)))continue;
  const label=`MarkitTick ${side.toUpperCase()}`;
  if(opts.labels?.length&&!opts.labels.some(l=>label.toLowerCase().startsWith(l.toLowerCase())))continue;
  const key=`${a.time}:${side}`;if(seen.has(key))continue;seen.add(key);
  out.push({kind:'entry',side,price,sl,tp:[tp],label,message:a.message.slice(0,500),source:'alert',barTime:a.time,barIndex:a.barIndex});
 }
 return out;
}
