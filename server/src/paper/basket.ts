/** RSI Volume Ladder v1: one budget, actual-fill basis, one shared bracket.
 * The source's equity-percent sizing is deliberately replaced with the existing margin/risk policy.
 */
import {feeFor,slip,roundTick,leverageForStop,type Position} from './logic.ts';
import type {PaperConfig} from '../config.ts';
export const BASKET_SCANNER='rsi-volume-ladder-basket';
export const BASKET_MARKER='VNEDGE RSI volume candidate';
export interface BasketState {version:1;entries:number;lastEntry:number;lowestEntry:number;marginUsed:number;lastSignalBar:number}
export function basketLevels(price:number,tick:number,held?:Position){
 const lowest=Math.min(price,held?.basket?.lowestEntry??price);
 return {sl:roundTick(lowest*.97,tick),tp:[roundTick(price*1.04,tick)]};
}
export function basketRefusal(held:Position|undefined,price:number,bar:number):string|null{
 if(!Number.isFinite(price)||price<=0)return 'basket: invalid entry price';
 if(!held)return null;
 if(!held.basket)return 'basket: held position has no basket ledger';
 if(held.qtyOpen!==held.qty||held.fills.some(f=>f.reason!=='entry'&&f.reason!=='funding'))return 'basket: additions stop after any exit';
 if(held.basket.entries>=3)return 'basket: three entries already filled';
 if(bar<=held.basket.lastSignalBar)return 'basket: signal already consumed';
 if(price>=held.basket.lastEntry*.985)return 'basket: needs a fresh drop greater than 1.5% from the last fill';
 if(held.sl!==null&&price<=held.sl)return 'basket: existing stop already breached';
 return null;
}
/** Stop cap includes paid entry/funding costs plus adverse stop execution and closing fees. */
export function basketSizing(cfg:PaperConfig,equity:number,sl:number,held?:Position):PaperConfig|null{
 if(cfg.sizingMode!=='margin'||cfg.marginPerTrade!==150||!(cfg.maxStopLossPct!>0))return null;
 let committed=0;
 if(held){
  if(leverageForStop(held.entryPrice,sl,held.marginLeverage!,cfg,held.maintenanceMarginPct)<held.marginLeverage!-1e-9)return null;
  const stop=slip(sl,'sell',cfg,sl*held.qtyOpen*held.contractValue);
  committed=Math.max(0,(held.entryPrice-stop)*held.qtyOpen*held.contractValue)+held.fees-Math.min(0,held.realizedPnl)+feeFor(stop,held.qtyOpen,held.contractValue,cfg);
 }
 const budget=equity*cfg.maxStopLossPct!/100-committed;
 const margin=Math.min(50,150-(held?.basket?.marginUsed??0));
 if(budget<=0||margin<=0)return null;
 return {...cfg,marginPerTrade:margin,maxStopLossPct:budget/equity*100};
}
