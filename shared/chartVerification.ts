import type {ChartChannels} from './chartChannels.ts';
export interface SignalReceipt {
 scannerId:string;symbol:string;tf:string;barTime:number;at:number;sourceHash:string|null;
 inputs:Record<string,number|string|boolean>;timezone:string;historyFrom:number;bars:number;historyHash?:string;
 candle:{time:number;open:number;high:number;low:number;close:number;volume:number};
 outputs:Record<string,{kind:'plot'|'shape';value:number|null}>;
 signals:Array<{kind:string;side?:string;label:string;source:string}>;
 signalCoverage:'shape'|'outputs-only';truncated:boolean;signalMetadata?:string;readingHash?:string;channels?:ChartChannels;
}
export interface ChartObservation {
 scannerId:string;symbol:string;tf:string;barTime:number;sourceHash:string|null;historyFrom:number|null;
 inputs:Record<string,number|string|boolean>;inputsChanged:boolean;timezone:string;values:Record<string,number|null>;complete:boolean;historyHash?:string;historyBars?:number;valuesTruncated?:boolean;signalMetadata?:string;readingHash?:string;channels?:ChartChannels;
}
/** Canonical primary closed-bar inputs. Both runtimes hash these bytes with SHA-256.
 * Deliberately excludes the forming bar and non-OHLCV provider metadata. Diagnostic only. */
export function chartHistoryText(bars:readonly {time:number;open:number;high:number;low:number;close:number;volume?:number}[],through:number){
 return JSON.stringify(bars.filter(b=>b.time<=through).map(b=>[b.time,b.open,b.high,b.low,b.close,b.volume]));
}
export function compareChart(o:ChartObservation,r:SignalReceipt|null){
 if(!r||r.barTime!==o.barTime)return {status:'Waiting for matching server bar',differences:[] as string[],comparable:false};
 const inputs=(v:Record<string,number|string|boolean>)=>JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)));
 if(o.symbol!==r.symbol||o.tf!==r.tf||o.scannerId!==r.scannerId||inputs(o.inputs)!==inputs(r.inputs)||!o.complete||o.inputsChanged||!o.sourceHash||o.sourceHash!==r.sourceHash||o.timezone!==r.timezone)
  return {status:'Source, inputs or execution context differs',differences:[],comparable:false};
 if(o.channels?.unavailable)return {status:o.channels.unavailable,differences:[],comparable:false};
 if(o.historyFrom!==r.historyFrom||(o.historyBars!==undefined&&o.historyBars!==r.bars))
  return {status:'History windows differ; outputs not comparable',differences:[],comparable:false};
 if(!o.historyHash||!r.historyHash)return {status:'Candle history unverified; wait for a fresh scan',differences:[],comparable:false};
 if(o.historyHash!==r.historyHash)return {status:'Candle data differs; outputs not comparable',differences:[],comparable:false};
 if(o.valuesTruncated)return {status:'Chart outputs truncated; comparison unavailable',differences:[],comparable:false};
 if(o.channels&&(!r.channels||!r.signalMetadata))return {status:'Server channel receipt unavailable; wait for a fresh scan',differences:[],comparable:false};
 if(o.channels&&(!o.readingHash||o.readingHash!==r.readingHash))return {status:'Reader contract differs or is unverified',differences:[],comparable:false};
 if(r.signalMetadata&&o.signalMetadata!==r.signalMetadata)return {status:'Signal metadata differs; outputs not comparable',differences:[],comparable:false};
 const differences=Object.entries(r.outputs).filter(([key,v])=>{
  if(!(key in o.values))return true;const n=o.values[key];
  if(v.kind==='shape')return Boolean(n)!==Boolean(v.value);
  return n===null||v.value===null?n!==v.value:Math.abs(n-v.value)>Math.max(1e-10,Math.abs(v.value)*1e-7);
 }).map(([k])=>k);
 if(o.channels&&r.channels){
  const a=o.channels,b=r.channels;
  if(a.unavailable)return {status:a.unavailable,differences,comparable:false};
  if(a.truncated||b.truncated||r.truncated)return {status:'Signal channels truncated; comparison unavailable',differences,comparable:false};
  if(JSON.stringify([...a.alerts].sort())!==JSON.stringify([...b.alerts].sort()))differences.push('alert payloads');
  if(a.labelsVerified&&b.labelsVerified&&JSON.stringify([...a.labels].sort())!==JSON.stringify([...b.labels].sort()))differences.push('label state');
  return {status:differences.length?'Closed-bar signal outputs differ':!a.labelsVerified||!b.labelsVerified?'Plots and alerts agree; mixed drawing labels unverified':'Closed-bar plots, alerts and labels agree; bot signals shown',differences,comparable:a.labelsVerified&&b.labelsVerified};
 }
 return {status:!Object.keys(r.outputs).length?'No comparable chart outputs':differences.length?'Closed-bar outputs differ':r.truncated?'Available outputs agree; truncated':r.signalCoverage==='shape'?'Shape outputs agree; bot signals shown':'Outputs agree; other signal channels unverified',
  differences,comparable:!r.truncated&&Object.keys(r.outputs).length>0};
}
export interface FillComparison {
 positionId:number;symbol:string;book:number;
 fills:Array<{id:number;at:number;reason:string;side:string;qty:number;price:number;source:string|null;
  depth:{status:string;price:number|null;deltaBps:number|null;receivedAt:number|null;readyAt:number|null};
  tape:{status:string;first:number|null;vwap:number|null;deltaBps:number|null};maker:string|null}>;
}
