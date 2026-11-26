/** Source-pinned opt-in readers. Legacy IDs and their evidence remain byte-for-byte stable. */
import {createHash} from 'node:crypto';
import type {ScannerConfig} from '../config.ts';
import type {ExtractOptions,ScanEvent,Side} from './extractor.ts';
import type {WorkerAlert} from '../pine/worker.ts';
export const PRECISION_NATIVE='precision-sniper-v2-3-native';
export const NEO_NATIVE='indicatorneo-v4-native';
export const FISHER_UPDATED='fisher-wpr-upstream-v2';
export const SOURCE_PINS:Record<string,string>={
 [PRECISION_NATIVE]:'73876ae23a12c3aaf01df5f12495c238839b9d5afb7ed36327992342016341be',
 [NEO_NATIVE]:'8a0a2ea1bad385c55029b1699069af5b57013970a0b8405cfa56bfa676e977b8',
 [FISHER_UPDATED]:'06ac9ad2480518eda40c6e30c8a976af181ee0ac89b196804df28c255294a9d5',
};
export const sourceReader=(id:string|undefined)=>id===PRECISION_NATIVE||id===NEO_NATIVE;
export function sourcePinError(id:string,source:string){return SOURCE_PINS[id]&&createHash('sha256').update(source).digest('hex')!==SOURCE_PINS[id]?'Updated source changed: revalidate its versioned reader':null;}
export function sourceReaderConfigError(id:string,sc:Partial<ScannerConfig>){
 if(!sourceReader(id))return null;
 if(sc.reader!==2||sc.invert||sc.rule||sc.edge||sc.entryProtection!=='native'||sc.exitMode!==(id===PRECISION_NATIVE?'script':'levels'))return 'updated native reader requires its reviewed direction, reader, stop and exit contract';
 if(id===PRECISION_NATIVE){
  const i=sc.inputs??{};
  // This deployment validates the author's full-position model. Partials need a separate quantity-aware contract.
  if(i.webhookInput!==true||Object.keys(i).some(k=>k!=='webhookInput'))return 'Precision v2.3 requires JSON batches and reviewed default lifecycle inputs';
 }
 return null;
}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const side=(v:unknown):Side|undefined=>typeof v==='string'&&v.toLowerCase()==='long'?'long':typeof v==='string'&&v.toLowerCase()==='short'?'short':undefined;
const geometry=(s:Side,p:number,sl:number,tp:number[])=>positive(p)&&positive(sl)&&(s==='long'?sl<p:sl>p)&&tp.length>0&&tp.every((v,i)=>positive(v)&&(s==='long'?v>(i?tp[i-1]:p):v<(i?tp[i-1]:p)));
export function sourceGeometryError(id:string|undefined,s:Side,p:number,sl:number|undefined,tp:number[]){
 if(!sourceReader(id))return null;
 return tp.length===(id===PRECISION_NATIVE?3:1)&&sl!==undefined&&geometry(s,p,sl,tp)?null:'native source stop or targets crossed/unavailable';
}
function accepted(e:ScanEvent,opts:ExtractOptions){
 if(e.kind!=='entry')return true;
 const title=e.label.toLowerCase(),mapped=Object.entries(opts.sides??{}).find(([k])=>k.toLowerCase()===title)?.[1];
 const ok=(!opts.sources||opts.sources.includes('alert'))&&(!opts.labels?.length||opts.labels.some(l=>title.startsWith(l.toLowerCase())))&&(mapped===undefined||mapped===e.side);
 if(!ok&&opts.drops)opts.drops['native: entry excluded by reading contract']=(opts.drops['native: entry excluded by reading contract']??0)+1;
 return ok;
}
export function readSourceAlerts(alerts:WorkerAlert[],opts:ExtractOptions):ScanEvent[]{
 if(opts.reader!==2||opts.invert)return [];
 const out:ScanEvent[]=[],seen=new Set<string>();
 const drop=(why:string)=>{if(opts.drops)opts.drops[why]=(opts.drops[why]??0)+1;};
 for(const a of alerts){
  if(a.type!=='alert'||opts.sinceBarTime!==undefined&&a.time<opts.sinceBarTime)continue;
  const base={barTime:a.time,barIndex:a.barIndex,source:'alert' as const,message:a.message.slice(0,500),tp:[] as number[]};
  if(opts.scannerId===NEO_NATIVE){
   const fields=new Map<string,string>();let valid=true;
   for(const segment of a.message.split('|')){const m=segment.trim().match(/^([a-z_]+)=(.+)$/);if(!m||fields.has(m[1])){valid=false;break;}fields.set(m[1],m[2].trim());}
   const dir=fields.get('signal'),s=dir==='long'?'long':dir==='short'?'short':undefined;
   const numeric=(key:string)=>{const v=fields.get(key);return v&&/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v)?Number(v):NaN;};
   const price=numeric('entry'),sl=numeric('stop'),tp=[numeric('target')];
   if(!valid||!s||!geometry(s,price,sl,tp)||!fields.get('market')||fields.get('ref')!=='Support_Resistance_Alerts[neo_gallage]'){drop('native: invalid IndicatorNeo bracket');continue;}
   const key=`${a.time}:${s}`;if(seen.has(key))continue;seen.add(key);
   const e:ScanEvent={...base,kind:'entry',side:s,price,sl,tp,label:`${s.toUpperCase()} native breakout`};if(accepted(e,opts))out.push(e);continue;
  }
  let p:any;try{p=JSON.parse(a.message);}catch{drop('native: Precision requires JSON');continue;}
  if(p?.schema_version!==2||p.script_version!=='2.3.0'||p.execution_model!=='close_entry_old_stop_first_next_bar_trail'||!Array.isArray(p.events)||!opts.barMs||p.events.length>128){drop('native: unsupported Precision schema');continue;}
  // Preserve author order: old-position milestones/amendments/close precede the new entry.
  for(const e of p.events){
   if(!e||typeof e!=='object'||e.bar_time!==a.time||e.time_close!==a.time+opts.barMs||!positive(e.entry)||typeof e.trade_id!=='string'||typeof e.event_id!=='string')continue;
   const s=side(e.direction),match=e.trade_id.match(/:(\d{13})$/),entryAt=match?Number(match[1]):NaN;
   if(!s||!positive(entryAt)||entryAt>e.time_close||e.event_id!==`${e.trade_id}:${e.time_close}:${e.event_type}`)continue;
   const tp=[e.tp1,e.tp2,e.tp3],dir=s==='long'?1:-1;
   if(!geometry(s,e.entry,e.initial_stop,tp))continue;
   const key=e.event_id;if(seen.has(key))continue;
   let event:ScanEvent|undefined;
   const common={...base,side:s,authorEntryAt:entryAt};
   if(e.event_type==='entry'&&entryAt===e.time_close&&e.position_closed===false&&e.remaining===1)event={...common,kind:'entry',price:e.entry,sl:e.initial_stop,tp,label:`${s.toUpperCase()} native entry`};
   else if(e.event_type==='exit'&&e.position_closed===true&&e.remaining===0&&positive(e.level_price))event={...common,kind:'exit',exitType:e.exit_reason==='SL'?'sl':e.exit_reason==='Reversal'?'flip':'close',label:`Precision close ${e.trade_id}`};
   else if(e.event_type==='stop_changed'&&e.stop_effective==='next_bar'&&e.position_closed===false&&e.remaining===1&&positive(e.new_stop)&&e.new_stop===e.stop&&dir*(e.new_stop-e.initial_stop)>=0)event={...common,kind:'exit',exitType:'stop_update',price:e.new_stop,sl:e.new_stop,label:`Precision stop ${e.trade_id}`};
   // TP touches are milestones, not partial/full closes. Only the explicit exit closes the remainder.
   else if(/^tp[123]_hit$/.test(e.event_type))event={...common,kind:'info',label:`Precision milestone ${e.event_type}`};
   if(event){seen.add(key);if(accepted(event,opts))out.push(event);}
  }
 }
 return out;
}
