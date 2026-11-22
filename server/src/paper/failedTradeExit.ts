import {TF_SECONDS} from '../config.ts';
import type {Position} from './logic.ts';

/** Frozen prospective hypothesis. Never a global paper setting or promotion rule. */
export const TWO_BAR_EXIT='trend-impulse-two-bar-v1' as const;
export function isTwoBarCell(scannerId:string,symbol:string,tf:string){
 return scannerId==='trend-impulse-channels-zeiierman'&&((symbol==='INITUSD'&&tf==='15m')||(symbol==='PARTIUSD'&&tf==='1h'));
}
export function twoBarFailure(p:Position,price:number,at:number):boolean {
 const plan=p.executionPlan;
 if(plan?.failedTradeExit!==TWO_BAR_EXIT||!isTwoBarCell(plan.sourceScannerId,p.symbol,p.tf)||p.status!=='open'
  ||p.qtyOpen!==p.qty||p.fills.filter(f=>f.reason==='entry'&&f.qty>0).length!==1)return false;
 const unit=p.slOriginal==null?0:Math.abs(p.entryPrice-p.slOriginal),barMs=(TF_SECONDS[p.tf]??0)*1000;
 if(![price,at,p.entryAt,p.entryPrice,unit,p.peakR].every(Number.isFinite)||price<=0||unit<=0||barMs<=0||at-p.entryAt<2*barMs)return false;
 // Boundary tolerance only: a mathematical +0.2R has reached the threshold.
 const peak=p.peakR!;if(peak>=.2||.2-peak<=1e-10)return false;
 return (p.side==='long'?1:-1)*(price-p.entryPrice)/unit<=-.5;
}
