import type {App} from '../app.ts';
import type {PositionsHealth,PositionHealth,ReplayCoverage} from '../../../shared/positionHealth.ts';
import {positionHealth} from '../analytics/positionHealth.ts';
import type {ExitBook} from '../paper/exitExecution.ts';

/** Cached archive metadata; quotes and held exposure are always read afresh. No REST requests. */
export function positionsHealthReader(a:App){
 const inventory=new Map<string,{at:number;value:ReplayCoverage|null}>();
 return ():PositionsHealth=>{
  const at=Date.now(),books=new Map<string,ExitBook|null>(),held=a.paper.openPositions();
  const keys=new Set(held.map(p=>`${p.id}:${p.entryAt}`));
  for(const key of inventory.keys())if(!keys.has(key))inventory.delete(key);
  return {at,positions:held.map(p=>{
   if(!books.has(p.symbol)){
    const candidates=[a.tradeMonitor?.depth.recorder.bookAt(p.symbol,at,10000),a.depthRecorder?.bookAt(p.symbol,at,10000)]
     .filter((b):b is NonNullable<typeof b>=>!!b).sort((x,y)=>Math.min(y.receivedAt,y.exchangeAt)-Math.min(x.receivedAt,x.exchangeAt));
    books.set(p.symbol,candidates[0]??null);
   }
   const key=`${p.id}:${p.entryAt}`,old=inventory.get(key);
   if(!old||at-old.at>=30000)inventory.set(key,{at,value:a.replayArchive?.broad.coverage(p.symbol,p.entryAt,at)??null});
   const row=a.db.get<{at:number;price:number;depth:string|null;limit_observation:string|null}>(
    'SELECT at,price,depth,limit_observation FROM entry_fill_evidence WHERE position_id=? AND book=0',p.id);
   let entry:PositionHealth['coverage']['entry']='missing';
   // A receipt is for the first fill only, not proof of all add-on/partial-fill depth.
   if(row&&row.at===p.fills[0]?.at&&row.price===p.fills[0]?.price){
    entry='receipt-only';
    try{if(row.depth&&JSON.parse(row.depth)?.source==='l2-rest')entry='depth-recorded';
     else if(row.limit_observation&&JSON.parse(row.limit_observation)?.trigger)entry='limit-observation';}catch{/* malformed evidence stays unverified */}
   }
   const cfg=a.paper.advisoryObservation(p).config;
   const pendingFunding=cfg.fundingCharges?a.db.get<{n:number}>(
    "SELECT count(*) n FROM funding_settlements WHERE symbol=? AND at>=? AND at<=? AND status!='applied'",p.symbol,p.entryAt,at)?.n??0:0;
   return positionHealth(p,cfg,books.get(p.symbol)??null,at,{entry,pendingFunding,replay:inventory.get(key)!.value});
  })};
 };
}
