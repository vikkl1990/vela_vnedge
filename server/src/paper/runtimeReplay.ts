/** Replays accepted execution inputs through the real account and risk managers.
 * Scanner extraction/ML eligibility must be supplied as recorded decisions; this is not
 * a claim that historical allocation, order-book depth or exchange queues were reconstructed. */
import {Db} from '../db.ts';
import {PaperEngine,type EntryContext} from './engine.ts';
import {RiskManager} from '../risk/manager.ts';
import {MarkStore} from '../data/marks.ts';
import {TF_SECONDS,type AppConfig} from '../config.ts';
import {lastAtr} from '../data/indicators.ts';
import {trendSide} from './logic.ts';
import type {Bar} from '../data/candleStore.ts';
import type {ScanEvent} from '../scanners/extractor.ts';

export type ReplayEvent = {at:number;sequence:number} & (
 | {kind:'entry';event:ScanEvent;context:Omit<EntryContext,'at'>}
 | {kind:'bar';symbol:string;bar:Bar;historical?:boolean}
 | {kind:'context';symbol:string;tf:string;bar:Bar}
 | {kind:'quote';symbol:string;bid:number;ask:number;exchangeAt:number}
 | {kind:'trade';symbol:string;price:number;qty:number;exchangeAt:number}
 | {kind:'exit';scannerId:string;symbol:string;tf:string;exitType:'close'|'tp1'|'tp2'|'tp3'|'sl'|'stop_update';stopPrice?:number}
 | {kind:'funding';symbol:string;ratePct:number;mark:number}
 | {kind:'mark';symbol:string;price:number}
 | {kind:'restart'}
);
export interface ReplayManifest {
 version:1; policyInput:string; dataId:string; sources:Record<string,string>;
 limitations:string[];
}
export function replayRuntime(cfgIn:AppConfig,eventsIn:ReplayEvent[],manifest:ReplayManifest) {
 if(manifest.version!==1||!manifest.policyInput||!manifest.dataId)throw Error('versioned policy and data manifest required');
 const cfg=structuredClone(cfgIn);if(cfg.execution.mode!=='paper')throw Error('runtime replay is paper-only');
 const events=[...eventsIn].sort((a,b)=>a.at-b.at||a.sequence-b.sequence);
 const identities=new Set<string>();
 for(const e of events){const key=`${e.at}:${e.sequence}`;if(!Number.isFinite(e.at)||!Number.isInteger(e.sequence)||identities.has(key))throw Error('invalid or duplicate replay event ordering');identities.add(key);}
 let now=events[0]?.at??0;const db=new Db(':memory:'),marks=new MarkStore();
 const history=new Map<string,Bar[]>();const candles={get:(symbol:string,tf:string,opts?:{limit?:number})=>(history.get(`${symbol}|${tf}`)??[]).slice(-(opts?.limit??Infinity))};
 let paper:PaperEngine,risk:RiskManager;
 const start=()=>{
  paper=new PaperEngine(db,()=>cfg,{now:()=>now});paper.sourceHashFor=id=>manifest.sources[id]??null;
  paper.quotes=marks;paper.alignmentBars=(s,t)=>candles.get(s,t);
  paper.atrFor=(s,t)=>lastAtr(candles.get(s,t),14);
  paper.trendFor=(s,t,len=20)=>{const closes=candles.get(s,t).map(b=>b.close);return closes.length>=len?trendSide(closes,len):undefined;};
  risk=new RiskManager({db,paper,candles:candles as any,cfgRef:()=>cfg,now:()=>now});paper.risk=risk;
 };
 const decisions:Array<{at:number;sequence:number;action:string;reason?:string;positionId?:number}>=[];
 try{
  start();
  for(const e of events){now=e.at;
   switch(e.kind){
    case 'context': {
      if(!TF_SECONDS[e.tf]||e.bar.time+TF_SECONDS[e.tf]*1000>now)throw Error('context bar is not closed before observation');
      const key=`${e.symbol}|${e.tf}`,rows=history.get(key)??[];
      if(rows.at(-1)?.time===e.bar.time)rows[rows.length-1]=e.bar;else if(!rows.length||rows.at(-1)!.time<e.bar.time)rows.push(e.bar);
      history.set(key,rows);break;
    }
    case 'mark':paper!.onMarkPrice(e.symbol,e.price,now);break;
    case 'quote':marks.setQuotes(e.symbol,e.bid,e.ask,now,e.exchangeAt);break;
    case 'entry': {
      const d=paper!.commitDecision(()=>paper!.onEntry(e.event,{...e.context,at:now}));
      decisions.push({at:now,sequence:e.sequence,action:d.action,reason:d.reason,positionId:d.position?.id??d.pendingId});break;
    }
    case 'bar':paper!.onBar(e.symbol,e.bar,now,{historical:e.historical});break;
    case 'trade':paper!.onTrade(e.symbol,e.price,e.qty,e.exchangeAt,now);break;
    case 'exit':paper!.commitDecision(()=>paper!.onScriptExit(e.scannerId,e.symbol,e.tf,e.exitType,e.exitType==='stop_update'?e.stopPrice:undefined,now,'both'));break;
    case 'funding':paper!.reconcileFunding(e.symbol,e.ratePct,e.mark,now);break;
    case 'restart':paper!.removeAllListeners();start();break;
   }
  }
  const trades=paper!.trades({limit:100000});
  for(const t of trades)if(t.exitAt!<t.entryAt||t.fills.some(f=>f.at<t.entryAt)||t.qty!==Math.floor(t.qty))throw Error(`invalid runtime trade chronology/quantity #${t.id}`);
  const expected=paper!.initialEquity+paper!.realizedPnl()+paper!.unrealizedPnl();
  if(Math.abs(paper!.equity()-expected)>1e-8)throw Error('runtime account does not reconcile');
  return {manifest,decisions,trades,open:paper!.openPositions().map(p=>paper!.view(p)),pending:paper!.pendingEntries(),
    finalEquity:paper!.equity(),realized:paper!.realizedPnl(),orders:paper!.orders(100000)};
 }finally{db.db.close();}
}
