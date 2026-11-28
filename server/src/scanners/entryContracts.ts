/** Explicit research readings. Pins bind the exact installed source, not a same-named publication. */
import {createHash} from 'node:crypto';
import type {ScannerConfig} from '../config.ts';
import type {ExtractOptions,ScanEvent,Side} from './extractor.ts';
import type {WorkerAlert,WorkerShape} from '../pine/worker.ts';
export const ENTRY_CONTRACTS={
 'market-regime-context-v1':{scannerId:'market-regime-engine',source:'7075f38d3c3cce00a4a499384619e1eae640647d4d2eb409f502e8325194c836',runtime:'3b87d46397f35ba835b4565f2f7cb39b4eb0ca9a7a00af937ecb79455b1e9f73'},
 'smart-money-retests-v1':{scannerId:'smart-money-engine',source:'2e38026843a17c92a7ca7358ac54166387fde955691467898647b7fe13ec9eaa',runtime:'71c3fdacebd85b811d6562d555223a49855c3454bc1005e5d13ed70c6fa31c2a'},
 'ml-rsi-classifier-v1':{scannerId:'machine-learning-rsi-ai-classification-ranking-zeiierman',source:'d2d99ab55dc5429b7c77690d120f38aacc90a4eb158426f35396e02a11c70618',runtime:'ca69063e77c5ae1708a624bc1e72b672a55969e74f0b8825851085098bf0cde9'},
} as const;
export type SignalContract=keyof typeof ENTRY_CONTRACTS;
export function entryContractError(id:string,sc:Partial<ScannerConfig>){
 if(sc.signalContract===undefined)return null;
 const c=ENTRY_CONTRACTS[sc.signalContract];
 return !c||c.scannerId!==id||sc.reader!==2||sc.invert||sc.rule||sc.edge?'signal contract requires its reviewed scanner, reader 2 and unchanged source conditions':null;
}
export const contractRuntimeHash=(patched:string)=>createHash('sha256').update(patched).digest('hex');
/** No generic fallback: drawings, changed sources and unknown messages cannot become entries. */
export function readEntryContract(alerts:WorkerAlert[],shapes:WorkerShape[],opts:ExtractOptions):ScanEvent[]{
 const c=opts.signalContract&&ENTRY_CONTRACTS[opts.signalContract],out:ScanEvent[]=[],seen=new Set<string>();
 const drop=(why:string)=>{if(opts.drops)opts.drops[why]=(opts.drops[why]??0)+1;};
 if(!c||c.scannerId!==opts.scannerId||opts.reader!==2||opts.invert||opts.contractSourceHash!==c.runtime){drop('contract: source or reading mismatch');return [];}
 const current=(at:number)=>Number.isFinite(at)&&at>0&&(opts.sinceBarTime===undefined||at>=opts.sinceBarTime);
 const add=(e:ScanEvent)=>{
  if(e.kind==='entry'){
   const name=e.label.toLowerCase(),mapped=Object.entries(opts.sides??{}).find(([k])=>k.toLowerCase()===name)?.[1];
   if(opts.sources&&!opts.sources.includes(e.source)||opts.labels?.length&&!opts.labels.some(l=>name===l.toLowerCase())||mapped!==undefined&&mapped!==e.side){drop('contract: entry excluded by reading');return;}
  }
  const key=JSON.stringify([e.kind,e.barTime,e.side,e.kind==='info'?e.label:'']);if(seen.has(key))return;seen.add(key);out.push(e);
 };
 for(const a of alerts){
  if(!current(a.time))continue;
  const msg=String(a.message??'').trim(),title=String(a.title??'').trim();
  const base={barTime:a.time,barIndex:a.barIndex,source:a.type==='alertcondition'?'alertcondition' as const:'alert' as const,message:msg.slice(0,500),tp:[] as number[]};
  if(opts.signalContract==='market-regime-context-v1'){
   add({...base,kind:'info',label:title||msg.slice(0,60)});drop('contract: regime context is not an entry');continue;
  }
  if(opts.signalContract==='smart-money-retests-v1'){
   // Dynamic alerts preserve the author's grade/proximity toggles. Static flags
   // intentionally ignore those toggles; never use them to bypass the source.
   let side:Side|undefined,price:number|undefined,label:string|undefined;
   if(a.type==='alert'){
    if(msg.startsWith('{')){
     try{const j=JSON.parse(msg);if(j&&typeof j==='object'&&!Array.isArray(j)&&['ob_entry','fvg_entry'].includes(j.event)&&['bull','bear'].includes(j.direction)&&typeof j.ticker==='string'&&j.ticker&&typeof j.price==='number'&&Number.isFinite(j.price)&&j.price>0&&(j.event!=='ob_entry'||['A','B','C'].includes(j.grade))){side=j.direction==='bull'?'long':'short';price=j.price;label=j.event==='ob_entry'?'OB Retest':'FVG Retest';}}catch{/* malformed payload stays context */}
    }else{
     const m=msg.match(/^(🟢|🔴)\s+(?:([ABC])-OB Retest|(FVG Retest))\s*\|\s*[^|]+\s*\|\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i);
     if(m&&Number(m[4])>0&&Number.isFinite(Number(m[4]))){side=m[1]==='🟢'?'long':'short';price=Number(m[4]);label=m[2]?'OB Retest':'FVG Retest';}
    }
   }
   if(side&&label)add({...base,kind:'entry',side,price,label:`${side==='long'?'Long':'Short'} ${label}`});
   else {add({...base,kind:'info',label:title||msg.split('|')[0].slice(0,60)});drop('contract: structure, OTE or non-dynamic retest is context');}
   continue;
  }
  let side:Side|undefined;
  if(a.type==='alertcondition'){if(title==='Long Signal')side='long';if(title==='Short Signal')side='short';}
  else if(a.type==='alert'){
   const m=msg.match(/^(?:🟢\s+LONG|🔴\s+SHORT)\s*\|\s*[^|]+\s+Rank\s+\d+(?:\.\d+)?\s*\/\s*Conf\s+\d+(?:\.\d+)?\s*$/);
   if(m)side=msg.startsWith('🟢')?'long':'short';
  }
  if(side)add({...base,kind:'entry',side,label:side==='long'?'Long':'Short'});
  else {add({...base,kind:'info',label:title||msg.split('|')[0].slice(0,60)});drop('contract: not a classifier entry');}
 }
 if(opts.signalContract==='ml-rsi-classifier-v1')for(const s of shapes){
  if(s.title!=='Long'&&s.title!=='Short'){drop('contract: non-classifier shape');continue;}
  for(const time of s.times)if(current(time))add({kind:'entry',side:s.title==='Long'?'long':'short',label:s.title,message:`plotshape ${s.title}`,source:'shape',barTime:time,barIndex:-1,tp:[]});
 }
 else if(shapes.length||opts.drawn?.length)drop('contract: drawings do not establish an entry');
 return out.sort((a,b)=>a.barTime-b.barTime);
}
