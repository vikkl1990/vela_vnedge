import type {TradePolicy} from '../paper/tradePolicy.ts';
import {tradePolicyIdFor,stablePolicy} from '../paper/tradePolicy.ts';
import {strategyIdFor} from '../paper/strategyIdentity.ts';

/** Readiness-only compatibility for an expansion of account-wide slot capacity.
 * These controls admit additional trades; they do not change a recorded trade's
 * fills, costs, size or exits. Never infer extra trades, reprice history, or reuse
 * this exception for promotion/leverage. Tightening needs a separate replay. */
export function capacityExpansionCompatible(previous:TradePolicy,current:TradePolicy):boolean {
  try {
    for(const p of [previous,current]) {
      if(p.version!==1||!p.sourceHash||p.adoptedAt!=null||tradePolicyIdFor(p)!==p.id||strategyIdFor(p)!==p.strategyId)return false;
    }
    const oldCaps=[previous.paper.maxOpenPositions,previous.sizing.maxOpenPositions,previous.risk.maxPositionsTotal];
    const newCaps=[current.paper.maxOpenPositions,current.sizing.maxOpenPositions,current.risk.maxPositionsTotal];
    const ceiling=(n:number)=>n===0?Infinity:n;
    if([...oldCaps,...newCaps].some(n=>!Number.isSafeInteger(n)||n<0))return false;
    if(oldCaps.some((n,i)=>ceiling(newCaps[i])<ceiling(n)))return false;
    if(oldCaps.every((n,i)=>n===newCaps[i]))return false;
    const terms=(p:TradePolicy)=>{
      const {id,strategyId,adoptedAt,...body}=structuredClone(p);
      // Only these three copies of the two global ceilings may differ.
      body.paper.maxOpenPositions=0;
      body.sizing.maxOpenPositions=0;
      body.risk.maxPositionsTotal=0;
      return stablePolicy(body);
    };
    return terms(previous)===terms(current);
  }catch{return false;} // Missing/corrupt provenance is never compatibility evidence.
}
