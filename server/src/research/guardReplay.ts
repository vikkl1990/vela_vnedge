/** Read-only price-path diagnostic for refused entries. Minute opens are sampled
 * prices, NOT ticks or executable quotes. No result from this module is evidence
 * for changing a guard, promotion or live readiness. */
import type {TradePolicy} from '../paper/tradePolicy.ts';
import type {ScanEvent} from '../scanners/extractor.ts';
import type {MarketInfo} from '../paper/engine.ts';
import {protectEntry} from '../paper/entryProtection.ts';
import {withProductFees} from '../paper/productFees.ts';
import {resolveLevels,sizeContracts,openPosition,applyTrade,checkRiskVsFees} from '../paper/logic.ts';
export type Minute = [number,number,number,number,number];
export interface GuardObservation {
 id:number;at:number;sc:string;sym:string;tf:string;side:'long'|'short';action:string;
 policy?:TradePolicy|null;
 snapshot?:{policyId:string;signalAt:number;atr:number;market:MarketInfo;event:ScanEvent;sizeScale?:number}|null;
}
export function guardKind(action:string) {
 if(action==='opened')return 'opened';
 if(action.includes('re-entry cooldown'))return 'cooldown';
 if(action.includes('risk burst'))return 'burst';
 if(action.includes('risk regime: choppy (efficiency'))return 'regime-efficiency';
 if(action.includes('risk regime:'))return 'regime-other';
 return 'other';
}
export function replayGuardSample(x:GuardObservation,bars:Minute[],asOf:number,referenceEquity:number,horizonMs=7*86400000){
 const base={id:x.id,group:guardKind(x.action),action:x.action,promotionEligible:false,policyChangeEligible:false,
  executionBasis:'minute-open-sampling' as const,referenceEquity};
 const skip=(reason:string)=>({...base,status:'unverified' as const,reason,net:null,r:null});
 if(!Number.isFinite(asOf)||asOf<x.at||!(referenceEquity>0)||!Number.isFinite(referenceEquity)||!(horizonMs>0))throw Error('invalid replay window or reference equity');
 const s=x.snapshot,p=x.policy;
 if(!s||!p||p.adoptedAt||s.policyId!==p.id||!Number.isFinite(s.signalAt)||s.signalAt<x.at||s.signalAt>asOf||p.scannerId!==x.sc||p.symbol!==x.sym||p.tf!==x.tf)
  return skip('missing or incompatible entry-time policy/context');
 const cfg=withProductFees(p.paper,s.market.productFees,x.sym);
 const le=cfg.limitEntry;
 if((le?.enabled&&le.books.includes('account')&&le.tfs.includes(x.tf))||cfg.makerQuoteCells?.length||cfg.makerTapeCells?.length||cfg.reclaimTrials?.length)
  return skip('resting/reclaim entry requires recorded tape and depth; never converted to market');
 if(p.exitMode==='script')return skip('future author exits are not in this signal export');
 if(![s.market.contractValue,s.market.tickSize,s.atr].every(v=>Number.isFinite(v)&&v>0))return skip('missing market contract or ATR');
 for(let i=0;i<bars.length;i++){
  const b=bars[i];
  if(b.length<5||!b.every(Number.isFinite)||b[0]%60000||b[1]<=0||b[3]<=0||b[2]<Math.max(b[1],b[3],b[4])||b[3]>Math.min(b[1],b[4])||
   (i>0&&b[0]<=bars[i-1][0]))return skip('invalid or unordered minute history');
 }
 // The refusal snapshot is written after the signal journal row. Its admission
 // time, not the earlier journal timestamp, starts execution latency.
 const entryAt=Math.ceil((s.signalAt+Math.max(0,cfg.latencyMs))/60000)*60000;
 const i0=bars.findIndex(b=>b[0]===entryAt);
 if(i0<0||entryAt>asOf)return skip('missing first post-latency minute open');
 const ev=protectEntry(s.event,p.reading.entryProtection);
 if(ev.kind!=='entry'||ev.side!==x.side)return skip('incompatible event');
 const entry=bars[i0][1],levels=resolveLevels({side:x.side,price:entry,sl:ev.sl,tp:ev.tp,atr:s.atr},cfg,s.market.tickSize);
 if('error' in levels)return skip(levels.error);
 const cost=checkRiskVsFees(entry,levels.sl,cfg,x.sym);
 if(cost)return {...base,status:'rejected' as const,reason:cost,net:null,r:null};
 const size=sizeContracts(entry,levels.sl,{cfg,equity:referenceEquity,availableMargin:referenceEquity,contractValue:s.market.contractValue,
  tickSize:s.market.tickSize,maintenanceMarginPct:s.market.maintenanceMarginPct,maxLeverage:s.market.maxLeverage,sizeScale:s.sizeScale});
 if(!size.qty)return {...base,status:'rejected' as const,reason:size.reason,net:null,r:null};
 const pos=openPosition({id:x.id,scannerId:x.sc,scannerName:x.sc,symbol:x.sym,tf:x.tf,side:x.side,qty:size.qty,
  contractValue:s.market.contractValue,entryPrice:entry,at:entryAt,sl:levels.sl,tp:levels.tp,riskAmount:size.riskAmount,
  levelsSource:levels.source,leverage:size.leverage,marginLeverage:size.marginLeverage,cfg,bt:true,signalId:x.id});
 const detail={entryAt,sl:levels.sl,qty:size.qty,riskAmount:size.riskAmount,marginLeverage:size.marginLeverage};
 let previous=entryAt;
 for(let i=i0+1;i<bars.length;i++){
  const b=bars[i];if(b[0]>asOf||b[0]>entryAt+horizonMs)break;
  if(b[0]-previous!==60000)return {...skip('minute gap before exit'),...detail};
  previous=b[0];
  // A stop crossed between observations fills at this observed price, not at
  // the old stop level. Intraminute touches remain explicitly unobserved.
  applyTrade(pos,{time:b[0],price:b[1]},cfg,undefined,s.atr);
  if(pos.status==='closed')return {...base,...detail,status:'sampled-closed' as const,reason:pos.exitReason,exitAt:pos.exitAt,
   net:pos.realizedPnl-pos.fees,r:(pos.realizedPnl-pos.fees)/pos.riskAmount,fees:pos.fees};
 }
 // Never fabricate a horizon/end-of-cache close or call an unfinished trade flat.
 return {...base,...detail,status:previous>=entryAt+horizonMs?'horizon-open' as const:'censored' as const,reason:'position still open at end of observed path',net:null,r:null};
}
