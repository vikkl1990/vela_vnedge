/** Research-only invalidation hypotheses. These are sampled-price rules, not
 * author-native exits or runtime admission gates. No evidence is enrolled. */
export interface InvalidationInput {
 side:'long'|'short';entryAt:number;entryPrice:number;stop:number;tfMs:number;actualTriggerAt:number;
 signalBar:{time:number;high:number;low:number;close:number};
 samples:Array<{at:number;price:number}>;
}
export const INVALIDATION_CANDIDATES=['signal-wick','signal-wick-confirmed','no-follow-through-2bars'] as const;
export type InvalidationCandidate=typeof INVALIDATION_CANDIDATES[number];
export function invalidationTrigger(input:InvalidationInput,candidate:InvalidationCandidate) {
 const {entryAt,entryPrice,stop,side,tfMs,actualTriggerAt,signalBar:b}=input;
 if(!INVALIDATION_CANDIDATES.includes(candidate)||![entryAt,entryPrice,stop,tfMs,actualTriggerAt,b.time,b.high,b.low,b.close].every(Number.isFinite)
  ||entryPrice<=0||stop<=0||tfMs<=0||actualTriggerAt<entryAt||b.time+tfMs>entryAt||b.low<=0||b.high<b.low||b.close<b.low||b.close>b.high)
  throw Error('invalid or non-causal invalidation input');
 const distance=Math.abs(entryPrice-stop);
 if(!(distance>0))throw Error('zero risk distance');
 const level=side==='long'?b.low:b.high;
 const applicable=side==='long'?level<entryPrice&&level>stop:level>entryPrice&&level<stop;
 if(candidate!=='no-follow-through-2bars'&&!applicable)return {status:'inapplicable' as const,at:null,level,reason:'signal wick is not between entry and original stop'};
 let previous=entryAt,peak=0,confirmation:number|null=null,count=0;
 for(const sample of input.samples) {
  if(!Number.isFinite(sample.at)||!Number.isFinite(sample.price)||sample.price<=0)throw Error('invalid observation');
  if(sample.at<entryAt)continue;
  if(sample.at<previous)throw Error('nonmonotonic observations');
  if(sample.at>=actualTriggerAt)break;
  if(sample.at-previous>120000)return {status:'unverified' as const,at:null,level,reason:'recorded sample gap exceeds two minutes'};
  previous=sample.at;count++;
  const rr=(sample.price-entryPrice)*(side==='long'?1:-1)/distance;
  peak=Math.max(peak,rr);
  const failed=side==='long'?sample.price<level:sample.price>level;
  if(candidate==='signal-wick'&&failed)return {status:'triggered' as const,at:sample.at,level,reason:null};
  if(candidate==='signal-wick-confirmed'){
   if(!failed)confirmation=null;
   else if(confirmation===null)confirmation=sample.at;
   else if(sample.at-confirmation>=30000)return {status:'triggered' as const,at:sample.at,level,reason:null};
  }
  if(candidate==='no-follow-through-2bars'&&sample.at-entryAt>=2*tfMs&&rr<=-.25&&peak<.2)
   return {status:'triggered' as const,at:sample.at,level:null,reason:null};
 }
 if(!count||actualTriggerAt-previous>120000)return {status:'unverified' as const,at:null,level,reason:'incomplete sample coverage'};
 return {status:'unchanged' as const,at:null,level,reason:null};
}
