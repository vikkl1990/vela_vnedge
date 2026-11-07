import {depthFill} from '../paper/entryExecution.ts';

export interface ExecutionBook {
  receivedAt:number; exchangeAt:number;
  bids:Array<{price:number;size:number}>; asks:Array<{price:number;size:number}>;
}

/** Research only: an exit sells bids for a long, buys asks for a short.
 * A partial book prices only the visible quantity, never a fabricated complete fill.
 * This models a marketable order against observed depth; it is not an exchange fill guarantee.
 */
export function evaluateDepthExit(input:{side:'long'|'short';qty:number;contractValue:number;at:number;maxAgeMs:number;book:ExecutionBook|null;feeRatePct:number;feeTaxPct:number}) {
  const unknown=(reason:string)=>({status:'unpriced' as const,reason,filledQty:0,remainingQty:input.qty,coverage:0,price:null,fee:null});
  const {book,qty,at,maxAgeMs,contractValue,feeRatePct,feeTaxPct}=input;
  if(!Number.isInteger(qty)||qty<=0||!Number.isFinite(contractValue)||contractValue<=0||
    !Number.isFinite(at)||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||
    !Number.isFinite(feeRatePct)||feeRatePct<0||!Number.isFinite(feeTaxPct)||feeTaxPct<0)return unknown('invalid execution inputs');
  if(!book)return unknown('missing or invalidated depth');
  if([book.receivedAt,book.exchangeAt].some(t=>!Number.isFinite(t)||t<=0||t>at||at-t>maxAgeMs))return unknown('non-causal or stale depth');
  if(!book.bids.length||!book.asks.length||[...book.bids,...book.asks].some(l=>!Number.isFinite(l.price)||l.price<=0||!Number.isFinite(l.size)||l.size<=0))return unknown('malformed depth');
  if(Math.max(...book.bids.map(l=>l.price))>=Math.min(...book.asks.map(l=>l.price)))return unknown('locked or crossed depth');
  if([book.bids,book.asks].some(levels=>new Set(levels.map(l=>l.price)).size!==levels.length))return unknown('duplicate depth levels');
  const buying=input.side==='short';
  const result=depthFill(buying?book.asks:book.bids,qty,buying?'long':'short');
  const filledQty=Math.min(qty,Math.round(qty*result.coverage*1e8)/1e8);
  return {status:result.coverage>=1?'complete' as const:'partial' as const,reason:null,
    filledQty,remainingQty:qty-filledQty,coverage:result.coverage,price:result.vwap,
    fee:result.vwap!*filledQty*contractValue*feeRatePct/100*(1+feeTaxPct/100)};
}

/** Quote-only sensitivity at a saved exit time. Size at that quote is unknown, so
 * this cannot certify a fill or replace an execution backtest. Hold fees' effective
 * rate (including any recorded waiver) fixed; entry, trigger and funding are unchanged.
 */
export function quoteExitSensitivity(input:{side:'long'|'short';qty:number;contractValue:number;price:number;fee:number;at:number;bid:number|null;ask:number|null;quoteAt:number|null;maxAgeMs:number}) {
  const {bid,ask,quoteAt,at,maxAgeMs,price,qty,contractValue,fee}=input;
  if(!Number.isFinite(at)||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||quoteAt===null||!Number.isFinite(quoteAt)||quoteAt<=0||quoteAt>at||at-quoteAt>maxAgeMs||
    bid===null||ask===null||![bid,ask,price,qty,contractValue].every(v=>Number.isFinite(v)&&v>0)||bid>ask||!Number.isFinite(fee)||fee<0)return null;
  const replacement=input.side==='long'?bid:ask;
  const feeDelta=fee===0?0:fee*(replacement/price-1);
  const grossDelta=(input.side==='long'?1:-1)*(replacement-price)*qty*contractValue;
  return {price:replacement,ageMs:at-quoteAt,grossDelta,feeDelta,netDelta:grossDelta-feeDelta};
}
