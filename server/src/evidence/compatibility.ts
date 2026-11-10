import type {TradePolicy} from '../paper/tradePolicy.ts';
import {stablePolicy,strategyTerms,strategyIdFor} from '../paper/strategyIdentity.ts';
import {offerEffectiveFrom,commissionRatePct} from '../paper/costs.ts';

/** One-way conservative cost comparison, not a generic relaxed policy hash.
 * Only the addition of verified scalper eligibility may differ. Old full commissions
 * remain charged in R; there is no retroactive discount, inferred policy or source reset. */
export function fullFeeCompatible(previous:TradePolicy,current:TradePolicy,at:number):boolean {
  if(!previous.sourceHash||!current.sourceHash||previous.adoptedAt!=null||current.adoptedAt!=null)return false;
  if(previous.version!==1||current.version!==1||!Number.isFinite(at))return false;
  if(strategyIdFor(previous)!==previous.strategyId||strategyIdFor(current)!==current.strategyId)return false;
  const old=previous.paper.scalperOffer,now=current.paper.scalperOffer;
  if(!old?.enabled||old.verification||old.joinedAt!==undefined||offerEffectiveFrom(previous.paper)!==undefined)return false;
  if(!now?.verification||offerEffectiveFrom(current.paper)===undefined||at<now.verification.verifiedAt)return false;
  const a=strategyTerms(previous),b=strategyTerms(current);
  delete b.paper.scalperOffer!.verification;
  return stablePolicy(a)===stablePolicy(b);
}

/** A saved full-fee policy is not sufficient if the journal actually undercharged it.
 * Require complete, consistent commission records; funding P&L is left untouched. */
export function paidFullCommissions(row:{fills:string;fees:number;qty:number;contract_value:number;entry_at:number;exit_at:number},policy:TradePolicy):boolean {
  try {
    const parsed=JSON.parse(row.fills),fills=Array.isArray(parsed)?parsed:parsed.fills;
    if(!Array.isArray(fills)||!fills.length||!(row.qty>0&&row.contract_value>0)||!Number.isFinite(row.fees))return false;
    let entries=0,exits=0,paid=0;
    for(const f of fills){
      if(!Number.isFinite(f.fee)||f.fee<0)return false;
      paid+=f.fee;
      if(f.reason==='funding'){if(f.qty!==0||f.fee!==0)return false;continue;}
      if(!Number.isFinite(f.price)||!(f.price>0)||!Number.isFinite(f.qty)||!(f.qty>0)||!Number.isFinite(f.at)||f.at<row.entry_at||f.at>row.exit_at)return false;
      if(!['maker','taker'].includes(f.liquidity)||f.feeWaived||f.feeDiscount>0)return false;
      const expected=f.price*f.qty*row.contract_value*commissionRatePct(policy.paper,f.liquidity==='maker')/100;
      if(!Number.isFinite(expected)||f.fee+Math.max(1e-8,expected*1e-8)<expected)return false;
      if(f.reason==='entry')entries+=f.qty;else exits+=f.qty;
    }
    const near=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-8,Math.abs(b)*1e-8);
    return near(entries,row.qty)&&near(exits,row.qty)&&near(paid,row.fees);
  }catch{return false;}
}
