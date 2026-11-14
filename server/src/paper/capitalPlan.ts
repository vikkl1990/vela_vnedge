/** Advisory allocation: risk sets quantity; leverage funds that quantity.
 * This module does not select trades, approve evidence or place orders.
 */
import {sizeContracts,slip,impactOnly,feeFor,type SizingInputs} from './logic.ts';

export interface CapitalPreference {
  preferredMargin: number;
  /** Requested range; contract and existing policy ceilings still win. */
  minLeverage: number;
  maxLeverage: number;
  targetRiskPct: number;
  /** Remaining portfolio loss budget after held positions AND pending reservations. */
  remainingRiskUsd: number;
}

export function capitalPlan(entry:number,stop:number,s:SizingInputs,p:CapitalPreference) {
  const invalid=()=>({qty:0,notional:0,margin:0,entryFeeReserve:0,riskAmount:0,marginLeverage:0,reason:'invalid capital planning inputs'});
  if(![p.preferredMargin,p.minLeverage,p.maxLeverage,p.targetRiskPct,p.remainingRiskUsd,s.availableMargin].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0)||p.preferredMargin<=0||p.minLeverage<=0||p.maxLeverage<p.minLeverage||p.targetRiskPct<=0)return invalid();
  const cap=s.cfg.maxStopLossPct;
  if(!(Number.isFinite(cap)&&cap>0)||!(s.equity>0))return invalid();
  const riskPct=Math.min(p.targetRiskPct,cap,p.remainingRiskUsd/s.equity*100);
  if(riskPct<=0)return {...invalid(),reason:'portfolio stop-risk budget exhausted'};
  const ceiling=Math.min(s.cfg.maxLeverage,s.maxLeverage??s.cfg.maxLeverage,p.maxLeverage);
  if(!(ceiling>0))return invalid();
  // Use the existing cost, tick/contract rounding, impact and liquidation sizing model.
  const cfg={...s.cfg,sizingMode:'risk' as const,riskPerTradePct:riskPct,maxLeverage:ceiling,maxStopLossPct:riskPct};
  const initial=sizeContracts(entry,stop,{...s,cfg});
  if(initial.qty<1)return {...initial,notional:0,margin:0,entryFeeReserve:0};
  const rawNotional=initial.qty*entry*s.contractValue;
  const modeledEntry=s.entryExecution?.maker?entry:s.entryExecution?.quoted
    ?impactOnly(entry,stop<entry?'buy':'sell',cfg,rawNotional):slip(entry,stop<entry?'buy':'sell',cfg,rawNotional);
  const notional=initial.qty*modeledEntry*s.contractValue;
  // Prefer the least leverage needed for the preferred margin, never choose size from the score.
  const requested=Math.max(Math.min(p.minLeverage,ceiling),notional/p.preferredMargin);
  const final=sizeContracts(entry,stop,{...s,cfg:{...cfg,maxLeverage:Math.min(ceiling,requested)}});
  const long=stop<entry;
  const cost=(qty:number)=>{
    const quotedNotional=qty*entry*s.contractValue;
    const fill=s.entryExecution?.maker?entry:s.entryExecution?.quoted
      ?impactOnly(entry,long?'buy':'sell',cfg,quotedNotional):slip(entry,long?'buy':'sell',cfg,quotedNotional);
    const stopFill=slip(stop,long?'sell':'buy',cfg,qty*stop*s.contractValue);
    const entryFeeReserve=feeFor(fill,qty,s.contractValue,cfg,s.entryExecution?.maker);
    const notional=qty*fill*s.contractValue,margin=final.marginLeverage>0?notional/final.marginLeverage:0;
    const riskAmount=Math.abs(fill-stopFill)*qty*s.contractValue+entryFeeReserve+feeFor(stopFill,qty,s.contractValue,cfg);
    return {notional,margin,entryFeeReserve,riskAmount};
  };
  let qty=final.qty,budget=cost(qty);
  // Nonlinear impact can increase both entry margin and commission after sizing.
  // Reserve the modeled fill costs, not the unfilled reference price.
  for(let i=0;i<60&&qty>0&&(budget.margin+budget.entryFeeReserve>s.availableMargin!||budget.riskAmount>s.equity*riskPct/100);i++){
    const ratio=Math.min(s.availableMargin!/(budget.margin+budget.entryFeeReserve),s.equity*riskPct/100/budget.riskAmount);
    qty=Math.max(0,Math.min(qty-1,Math.floor(qty*ratio)));budget=cost(qty);
  }
  if(qty<1)return {...invalid(),reason:final.reason??'modeled fill costs exhaust margin or stop budget'};
  return {...final,...budget,qty,leverage:budget.notional/s.equity};
}
