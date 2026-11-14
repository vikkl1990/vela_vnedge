/** RSI Volume Ladder v1: one budget, actual-fill basis, one shared bracket.
 * The source's equity-percent sizing is deliberately replaced with the existing margin/risk policy.
 */
import {feeFor,slip,impactOnly,roundTick,leverageForStop,type Position,type SizingInputs,sizeContracts} from './logic.ts';
import type {PaperConfig} from '../config.ts';
export const BASKET_SCANNER='rsi-volume-ladder-basket';
export const BASKET_MARKER='VNEDGE RSI volume candidate';
export const BASKET_ACCOUNTING_VERSION=2;
export const BASKET_REPLAY_REQUIRED='Basket execution requires stateful shadow replay; single-position candle screening is unsupported';
export function candleReplayBlock(scannerId:string){return scannerId===BASKET_SCANNER?BASKET_REPLAY_REQUIRED:null;}
export interface BasketState {version:1;entries:number;lastEntry:number;lowestEntry:number;marginUsed:number;lastSignalBar:number}
/** Planned cash loss at the shared stop, frozen at the latest confirmed entry.
 * Paid funding debits count; credits do not enlarge the loss budget. Future funding
 * and a gap beyond the modeled stop can still take a result below -1R. */
export function basketStopRisk(cfg:PaperConfig,sl:number,qty:number,cv:number,entryNotional:number,paidFees:number,realizedPnl=0){
 const stop=slip(sl,'sell',cfg,sl*qty*cv);
 return Math.max(0,entryNotional-stop*qty*cv)+paidFees-Math.min(0,realizedPnl)+feeFor(stop,qty,cv,cfg);
}
/** Start with the unchanged margin/cap sizing, then account for ONE combined stop
 * order. Separate leg impact estimates otherwise understate a nonlinear exit. */
export function sizeBasketEntry(price:number,sl:number,s:SizingInputs,held?:Position){
 const budget=basketSizing(s.cfg,s.equity,sl,held);
 if(!budget)return {qty:0,riskAmount:0,leverage:0,marginLeverage:0,reason:'basket: aggregate risk or margin budget exhausted'};
 const size=sizeContracts(price,sl,{...s,cfg:budget});
 if(size.qty<1)return size;
 const execution=s.entryExecution??{},cv=s.contractValue;
 const estimate=(qty:number)=>{
  const entry=execution.maker?price:execution.quoted?impactOnly(price,'buy',s.cfg,price*qty*cv):slip(price,'buy',s.cfg,price*qty*cv);
  const stop=Math.min(sl,basketLevels(entry,s.tickSize,held).sl),fee=feeFor(entry,qty,cv,s.cfg,execution.maker);
  const risk=basketStopRisk(s.cfg,stop,qty+(held?.qtyOpen??0),cv,entry*qty*cv+(held?held.entryPrice*held.qtyOpen*cv:0),fee+(held?.fees??0),held?.realizedPnl);
  return {entry,stop,fee,risk,margin:entry*qty*cv/size.marginLeverage};
 };
 const fits=(qty:number)=>{const x=estimate(qty);return Number.isFinite(x.risk)&&x.risk<=s.equity*s.cfg.maxStopLossPct!/100+1e-8&&x.margin<=budget.marginPerTrade!+1e-8&&(!held||x.entry>held.sl!);};
 let low=0,high=size.qty;
 while(low<high){const mid=Math.ceil((low+high)/2);if(fits(mid))low=mid;else high=mid-1;}
 if(!low)return {...size,qty:0,riskAmount:0,leverage:0,reason:'basket: combined stop costs exceed risk or margin budget'};
 const x=estimate(low);
 return {...size,qty:low,leverage:x.entry*low*cv/s.equity,riskAmount:basketStopRisk(s.cfg,x.stop,low,cv,x.entry*low*cv,x.fee)};
}
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
