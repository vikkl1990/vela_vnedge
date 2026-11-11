import type {Bar} from '../data/candleStore.ts';
import {advanceReclaim,createReclaim,type ReclaimState} from './reclaim.ts';

export interface ReclaimCheckpoint {version:1;at:number}
const M=60_000;
export const nextReclaimMinute=(s:ReclaimState)=>s.last?s.last.time+M:Math.ceil(s.at/M)*M;

/** Only versioned, committed pre-order progress can survive. No legacy state inference. */
export function reclaimRestoreRefusal(s:ReclaimState,c:ReclaimCheckpoint|undefined,now:number):string|null {
  try {
    if(!c || c.version!==1)return 'no durable reclaim checkpoint';
    if(!['pullback','reclaim'].includes(s.phase) || s.limit!==undefined || s.placedAt!==undefined || s.orderStop!==undefined)return 'reclaim order cannot recover across downtime';
    createReclaim(s,s.options); // validate parameters without changing the saved state
    if(!Number.isFinite(c.at) || c.at<s.at || c.at>now || !Number.isFinite(s.extreme) || s.extreme<=0)return 'invalid reclaim checkpoint';
    if(now>=s.at+s.options.setupMinutes*M+30_000)return 'reclaim setup expired';
    if(s.phase==='reclaim'&&!s.last)return 'invalid reclaim checkpoint';
    if(s.last && (!Number.isFinite(s.last.time) || s.last.time%M!==0 || s.last.time<Math.ceil(s.at/M)*M || s.last.time+M>c.at
      || ![s.last.open,s.last.high,s.last.low,s.last.close].every(Number.isFinite) || s.last.low<=0
      || s.last.low>Math.min(s.last.open,s.last.close) || s.last.high<Math.max(s.last.open,s.last.close)))return 'invalid reclaim checkpoint';
    return null;
  }catch{return 'invalid reclaim checkpoint';}
}

/** History may invalidate or advance a setup, never create an order or a fill. */
export function recoverReclaim(s:ReclaimState,checkpoint:ReclaimCheckpoint,tfMs:number,liveMinute:number,history:Bar[],through:boolean):
  {state:ReclaimState;minutes:number}|{reject:string} {
  const from=nextReclaimMinute(s);
  if(liveMinute<from || !Number.isFinite(liveMinute) || liveMinute%M!==0)return {reject:'invalid recovery minute'};
  // The source scanner might have issued an exit at a missed timeframe close.
  if(!(tfMs>0) || (Math.floor(checkpoint.at/tfMs)+1)*tfMs<=liveMinute)return {reject:'source bar closed during reclaim recovery'};
  const bars=history.filter(b=>b.time>=from&&b.time<liveMinute).sort((a,b)=>a.time-b.time);
  if(bars.length!==(liveMinute-from)/M)return {reject:'minute data gap during reclaim recovery'};
  const copy=structuredClone(s);
  for(const bar of bars){
    if(bar.time!==nextReclaimMinute(copy))return {reject:'minute data gap during reclaim recovery'};
    const step=advanceReclaim(copy,bar,bar.time+M,through);
    if(step.kind==='cancelled')return {reject:`reclaim recovery: ${step.reason}`};
    if(step.kind!=='waiting')return {reject:'reclaim confirmation missed during downtime'};
  }
  return {state:copy,minutes:bars.length};
}
