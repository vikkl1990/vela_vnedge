export interface SignalReceipt {
 scannerId:string;symbol:string;tf:string;barTime:number;at:number;sourceHash:string|null;
 inputs:Record<string,number|string|boolean>;timezone:string;historyFrom:number;bars:number;
 candle:{time:number;open:number;high:number;low:number;close:number;volume:number};
 outputs:Record<string,{kind:'plot'|'shape';value:number|null}>;
 signals:Array<{kind:string;side?:string;label:string;source:string}>;
 signalCoverage:'shape'|'outputs-only';truncated:boolean;
}
export interface ChartObservation {
 scannerId:string;symbol:string;tf:string;barTime:number;sourceHash:string|null;historyFrom:number|null;
 inputs:Record<string,number|string|boolean>;inputsChanged:boolean;timezone:string;values:Record<string,number|null>;complete:boolean;
}
export function compareChart(o:ChartObservation,r:SignalReceipt|null){
 if(!r||r.barTime!==o.barTime)return {status:'Waiting for matching server bar',differences:[] as string[],comparable:false};
 const inputs=(v:Record<string,number|string|boolean>)=>JSON.stringify(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)));
 if(o.symbol!==r.symbol||o.tf!==r.tf||o.scannerId!==r.scannerId||inputs(o.inputs)!==inputs(r.inputs)||!o.complete||o.inputsChanged||!o.sourceHash||o.sourceHash!==r.sourceHash||o.timezone!==r.timezone)
  return {status:'Source, inputs or execution context differs',differences:[],comparable:false};
 const differences=Object.entries(r.outputs).filter(([key,v])=>{
  if(!(key in o.values))return true;const n=o.values[key];
  if(v.kind==='shape')return Boolean(n)!==Boolean(v.value);
  return n===null||v.value===null?n!==v.value:Math.abs(n-v.value)>Math.max(1e-10,Math.abs(v.value)*1e-7);
 }).map(([k])=>k);
 const history=o.historyFrom!==r.historyFrom;
 return {status:!Object.keys(r.outputs).length?'No comparable chart outputs':differences.length?'Closed-bar outputs differ':history?'Outputs agree; history windows differ':r.truncated?'Available outputs agree; truncated':r.signalCoverage==='shape'?'Shape outputs agree; bot signals shown':'Outputs agree; other signal channels unverified',
  differences,comparable:!history&&!r.truncated&&Object.keys(r.outputs).length>0};
}
export interface FillComparison {
 positionId:number;symbol:string;book:number;
 fills:Array<{id:number;at:number;reason:string;side:string;qty:number;price:number;source:string|null;
  depth:{status:string;price:number|null;deltaBps:number|null;receivedAt:number|null;readyAt:number|null};
  tape:{status:string;first:number|null;vwap:number|null;deltaBps:number|null};maker:string|null}>;
}
