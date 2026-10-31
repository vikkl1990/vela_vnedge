/** Research-only plan adapters. They never change scanner configuration or paper orders. */
import type {Bar} from '../data/candleStore.ts';
import {atrSeries} from '../data/indicators.ts';
import type {ScanEvent} from '../scanners/extractor.ts';
export type PlanVariant = 'native' | 'atr' | 'structure';
export function adaptPlan(events: ScanEvent[], bars: Bar[], variant: PlanVariant): ScanEvent[] {
  if (variant === 'native') return events.map(e=>({...e,tp:[...e.tp]}));
  const at=new Map(bars.map((b,i)=>[b.time,i])), atr=atrSeries(bars,14);
  return events.flatMap(e=>{
    if(e.kind!=='entry') return [{...e,tp:[...e.tp]}];
    // A replacement stop needs a replacement target ladder; never retain an incompatible native target.
    if(variant==='atr') return [{...e,sl:undefined,tp:[]}];
    const i=at.get(e.barTime);
    if(i===undefined||i<14||!e.side||!atr[i]) return [];
    const window=bars.slice(Math.max(0,i-9),i+1);
    const sl=e.side==='long'?Math.min(...window.map(b=>b.low))-.25*atr[i]:Math.max(...window.map(b=>b.high))+.25*atr[i];
    return [{...e,sl,tp:[]}];
  });
}
/** Compare the actual entry plan, not only its direction, on two runs with different future history. */
export function planPrefixDifference(full:ScanEvent[], prefix:ScanEvent[], before:number) {
  const keys=(es:ScanEvent[])=>new Set(es.filter(e=>e.kind==='entry'&&e.barTime<before).map(e=>JSON.stringify([e.barTime,e.side,e.price??null,e.sl??null,e.tp])));
  const a=keys(full),b=keys(prefix);let changed=0;
  for(const k of a)if(!b.has(k))changed++;
  for(const k of b)if(!a.has(k))changed++;
  return {entries:Math.max(a.size,b.size),changed};
}
