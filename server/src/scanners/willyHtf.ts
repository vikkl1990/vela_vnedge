import type {WorkerAlert} from '../pine/worker.ts';
import type {ScanEvent} from './extractor.ts';

export const WILLY_HTF_MARKET = 'htf-sweep-cisd-market';

/** This reviewed identity accepts market setup intents only. The author's simulator is not our broker. */
export function readWillyHtfAlert(a: WorkerAlert): ScanEvent[] {
  const info = (label: string): ScanEvent[] => [{kind:'info',tp:[],source:'alert',barTime:a.time,
    barIndex:a.barIndex,label,message:String(a.message).slice(0,500)}];
  let p: any;
  try { p = JSON.parse(a.message); } catch { return info('HTF CISD: structured alert required'); }
  if (!p || Array.isArray(p) || p.schema_version !== 1 || p.bar_time !== a.time ||
      !Number.isSafeInteger(a.time) || a.time <= 0) return info('HTF CISD: invalid schema or bar');
  // No fallback to directional words: pending, cancelled and simulated fills/exits are context only.
  if (p.event !== 'order') return info(`HTF CISD: ${String(p.event).slice(0,40)} (script simulation)`);
  if (p.type !== 'market') return info('HTF CISD: limit placement (not a market entry)');
  if (!['long','short'].includes(p.side) || typeof p.order_id !== 'string' || !p.order_id ||
      p.order_id.length > 120 || p.trade_id !== p.order_id || p.event_id !== `${p.order_id}-order-${a.time}`)
    return info('HTF CISD: invalid order identity');
  const values = [p.price,p.entry,p.sl,p.tp1,p.tp2,p.tp3];
  if (!values.every(v=>typeof v === 'number' && Number.isFinite(v) && v>0) || p.entry !== p.price)
    return info('HTF CISD: invalid market levels');
  const sign = p.side === 'long' ? 1 : -1;
  if ((p.entry-p.sl)*sign<=0 || (p.tp1-p.entry)*sign<=0 || (p.tp2-p.tp1)*sign<=0 || (p.tp3-p.tp2)*sign<=0)
    return info('HTF CISD: invalid level direction');
  if (typeof p.score !== 'number' || !Number.isFinite(p.score) || p.score<0 || p.score>100)
    return info('HTF CISD: invalid score');
  return [{kind:'entry',side:p.side,price:p.entry,sl:p.sl,tp:[p.tp1,p.tp2,p.tp3],score:p.score,
    label:`HTF CISD market ${p.side}`,message:a.message.slice(0,500),source:'alert',barTime:a.time,barIndex:a.barIndex}];
}
