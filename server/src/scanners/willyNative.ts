/** Reader 3: author-native Willy events. Unknown/context output never becomes an order. */
import type {WorkerAlert,WorkerShape} from '../pine/worker.ts';
import type {ScanEvent,ExtractOptions,ExitType,Side} from './extractor.ts';
import {willyContract,willyNativeReady} from './willyContracts.ts';

const n=(x:unknown):number|undefined=>typeof x==='number'&&Number.isFinite(x)&&x>0?x:undefined;
const sideOf=(x:unknown):Side|undefined=>x===1||x==='long'||x==='bull'||x==='buy'?'long':x===-1||x==='short'||x==='bear'||x==='sell'?'short':undefined;
const clean=(s:string)=>s.replace(/^[^A-Za-z0-9]+/u,'').trim().toLowerCase();
const INFO=/^(?:new (?:bullish|bearish) leg|leg.turn|vwap.cross|close (?:above|below) vwap|setup|candidate|order|cancel|sweep (?:high|low)|pattern|skip|trade.closed|char.flip)/i;
const heads:Record<string,RegExp>={
 'structure-anchored-vwap':/^(long|short)\b/,
 'liquidity-trail-matrix':/^(long|short)\b/,
};

/** Unknown schemas return information; a version number alone never selects another script's adapter. */
export function readWillyNative(alerts:WorkerAlert[],shapes:WorkerShape[],opts:ExtractOptions,
 parse:(a:WorkerAlert,fixed?:boolean)=>ScanEvent[]):ScanEvent[] {
 const contract=willyContract(opts.scannerId);
 if(!contract||!willyNativeReady(opts.scannerId)||opts.invert)return [];
 const baseId=contract.scannerIds[0], contextual=contract.role==='Context'||contract.role==='Manual / restricted';
 const out:ScanEvent[]=[];
 const base=(a:WorkerAlert):ScanEvent=>({kind:'info',tp:[],source:'alert',barTime:a.time,barIndex:a.barIndex,label:'Author context',message:a.message.slice(0,500)});
 const push=(a:WorkerAlert,e:Partial<ScanEvent>)=>out.push({...base(a),...e});
 const entry=(a:WorkerAlert,p:any,side:Side|undefined)=>{
  const price=n(p.entry)??n(p.price)??n(p.fill_price)??n(p.entry_price),sl=n(p.sl)??n(p.stop)??n(p.initial_stop);
  const tp=[p.tp1,p.tp2,p.tp3].map(n).filter((x):x is number=>x!==undefined);
  if(!side||!price||!sl||tp.length!==3||(side==='long'?sl>=price:sl<=price)||tp.some(x=>side==='long'?x<=price:x>=price)){
   push(a,{label:'Author entry rejected: invalid native geometry'});return;
  }
  push(a,{kind:'entry',side,price,sl,tp,score:n(p.score)??n(p.quality),label:side.toUpperCase()});
 };
 const action=(a:WorkerAlert,p:any,verb:string,side?:Side)=>{
  const key=verb.toLowerCase().replace(/[ -]/g,'_');
  if(['buy','sell','entry','trigger_bull','trigger_bear','trap_long','trap_short'].includes(key)){
   entry(a,p,side??sideOf(key)??(/bull|long/.test(key)?'long':/bear|short/.test(key)?'short':undefined));return;
  }
  if(['trade_closed','candidate_cancelled','char_flip','setup_bull','setup_bear','expired','replaced'].includes(key)){
   push(a,{label:`Author context: ${key}`});return;
  }
  if(['break_even','be_moved','stop_changed','be'].includes(key)){
   const stop=n(p.new_sl)??n(p.new_stop)??n(p.stop)??n(p.sl)??n(p.level)??n(p.level_price)??n(p.entry);
   push(a,stop?{kind:'exit',exitType:'stop_update',side,price:stop,sl:stop,label:'Author stop amendment'}:{label:'Invalid author stop amendment'});return;
  }
  const tp=key.match(/^tp([123])(?:_hit|_close)?$/);
  const type:ExitType|undefined=tp?`tp${tp[1]}` as ExitType:['sl','sl_hit','stop_hit'].includes(key)?'sl':
   ['be_stop','be_exit'].includes(key)?'be':['flip','flip_exit','flip_close','reversal'].includes(key)?'flip':
   ['exit','close','timeout','timeout_exit','trade_timeout'].includes(key)?'close':undefined;
  if(type)push(a,{kind:'exit',exitType:type,side,price:n(p.price)??n(p.fill_price)??n(p.level),label:`Author ${key}`});
  else push(a,{label:`Author context: ${key}`});
 };
 for(const a of alerts){
  if(opts.sinceBarTime!==undefined&&a.time<opts.sinceBarTime)continue;
  if(a.type==='alertcondition')continue; // full alert payload owns its lifecycle; shapes below have explicit contracts
  if(contextual){push(a,{});continue;}
  let p:any;try{p=JSON.parse(a.message);}catch{}
  if(p&&typeof p==='object'){
   if(baseId==='synapse-trail-pro'&&p.schema==='stp.events.v1'&&Array.isArray(p.events)){
    for(const e of p.events)if(e&&typeof e==='object')action(a,e,String(e.action??''),sideOf(e.direction));continue;
   }
   if(p.schema||p.schema_version||Array.isArray(p.events)){push(a,{label:'Unsupported author schema'});continue;}
   const verb=String(p.action??'').toLowerCase();
   if(['update','exit','close'].includes(verb)) action(a,p,String(p.event??p.reason??verb),sideOf(p.side??p.dir??p.direction));
   else if(verb==='tp')action(a,p,`tp${p.level}`,sideOf(p.side??p.dir));
   else action(a,p,verb,sideOf(p.side??p.dir??p.direction));
   continue;
  }
  // Synapse's text fallback also contains several complete records, separated by newlines.
  for(const line of a.message.split(/\r?\n/).filter(x=>x.trim())){
   const msg={...a,message:line},head=clean(line.split('|')[0]);
   if(INFO.test(head)||/^(bull flip|bear flip|lvn break)\b/.test(head)){push(msg,{});continue;}
   if(/^break[-_ ]even\b/.test(head)&&!/^break[-_ ]even stop/.test(head)){
    const m=line.match(/(?:SL moved to|new_sl|SL\s*:)\s*([0-9.eE+-]+)/i);
    action(msg,{new_sl:m?Number(m[1]):undefined},'stop_changed');continue;
   }
   if(baseId==='synapse-trail-pro'){
    const values=Object.fromEntries([...line.matchAll(/\b(Price|Entry|SL|TP1|TP2|TP3):\s*([0-9.eE+-]+)/g)].map(m=>[m[1].toLowerCase(),Number(m[2])]));
    const dir=head==='buy'?'long':head==='sell'?'short':undefined;
    action(msg,values,head,dir);continue;
   }
   const parsed=parse(msg,true);
   for(const e of parsed){
    if(e.kind==='entry'){
     if(heads[baseId]?.test(head))entry(msg,{price:e.price,sl:e.sl,tp1:e.tp[0],tp2:e.tp[1],tp3:e.tp[2],score:e.score},e.side);
     else out.push({...e,kind:'info',label:'Not an author entry: '+e.label});
    }else out.push(e);
   }
   // Timeout/early-close strings are management instructions, not direction words.
   if(!parsed.some(e=>e.kind==='exit')&&/^(trade_timeout|timeout|early close)\b/.test(head))action(msg,{},'timeout');
  }
 }
 const keys=new Set<string>();
 return out.filter(e=>{
  const k=`${e.barTime}:${e.kind}:${e.side??''}:${e.exitType??''}`;
  if(e.kind==='entry'){
   const label=e.label.trim().toLowerCase();
   const named=Object.entries(opts.sides??{}).find(([title])=>title.trim().toLowerCase()===label)?.[1];
   // Entry allow-lists still restrict a native contract. A side remap cannot invert native geometry.
   const denied=(opts.sources&&!opts.sources.includes(e.source)) ||
    (opts.labels?.length&&!opts.labels.some(x=>label.startsWith(x.trim().toLowerCase()))) ||
    (named!==undefined&&named!==e.side);
   if(denied){if(opts.drops)opts.drops['native: entry excluded by reading contract']=(opts.drops['native: entry excluded by reading contract']??0)+1;return false;}
  }
  if(e.kind==='info')return true;if(keys.has(k))return false;keys.add(k);return true;
 }).sort((a,b)=>a.barTime-b.barTime||Number(b.kind==='exit')-Number(a.kind==='exit'));
}
