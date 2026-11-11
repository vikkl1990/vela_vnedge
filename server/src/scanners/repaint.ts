/**
 * Prefix honesty (decisions 85, 87). A script run on bars[0..n-cut] must raise the same entries, on the
 * same bars, as the run on all n bars, for every bar before the cut. A script whose earlier entries move
 * or vanish when later bars are hidden is reading the future; its history is not what a live run saw.
 */
import type { WorkerResult } from '../pine/worker.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScannerConfig } from '../config.ts';
import { applyRules } from './rules.ts';
import { extractEvents,type ScanEvent } from './extractor.ts';
import { readingOf } from './reading.ts';

export const REPAINT_CUT = Number(process.env.REPAINT_CUT ?? 60);
export const REPAINT_MAX_SHARE = 0.10;

export interface RepaintCheck {
 version:2;prefix:number;changed:number;share:number;repaints:boolean;
 coverage:'sufficient'|'insufficient';timingChanged:number;planChanged:number;exitChanged:number;exits:number;
}

/** Entries up to `cutAt`, as "barTime:side" keys, read the way the scanner's config reads them. */
export function readPrefix(res: WorkerResult, bars: Bar[], scannerId: string, sc: Partial<ScannerConfig>, cutAt: number,source?:string,variantOf?:string): ScanEvent[] {
  const READ = readingOf(sc, scannerId, bars.length > 1 ? bars[1].time - bars[0].time : undefined,source,variantOf);
  const derived = applyRules({ scannerId, alerts: res.alerts, shapes: res.shapes, labels: res.labels, plots: res.plots, rule: sc.rule ?? null, bars, mode: 'backtest', ...READ.rule });
  const events = extractEvents(res.alerts, res.shapes, { barMs: bars.length > 1 ? bars[1].time - bars[0].time : undefined, drawn: res.labels, scannerId, derived, ...READ.extract });
  return events.filter(e => e.kind !== 'info' && e.barTime <= cutAt);
}

const difference=(a:Set<string>,b:Set<string>)=>[...a].filter(k=>!b.has(k)).length+[...b].filter(k=>!a.has(k)).length;
const planKey=(e:ScanEvent)=>JSON.stringify([e.barTime,e.side??null,e.kind,e.exitType??null,e.price??null,e.sl??null,e.tp,e.score??null]);
/** Keep the existing sample/share thresholds and timing check; additional outputs cannot dilute it. */
export function compareEventPlans(full:ScanEvent[],part:ScanEvent[]):RepaintCheck {
 const entries=(es:ScanEvent[])=>es.filter(e=>e.kind==='entry'),exits=(es:ScanEvent[])=>es.filter(e=>e.kind==='exit');
 const timing=(es:ScanEvent[])=>new Set(entries(es).map(e=>`${e.barTime}:${e.side}`));
 const a=timing(full),b=timing(part),prefix=Math.max(a.size,b.size),timingChanged=difference(a,b);
 const plans=(es:ScanEvent[])=>new Set(entries(es).map(planKey));
 const pa=plans(full),pb=plans(part),planChanged=difference(pa,pb);
 const exitPlans=(es:ScanEvent[])=>new Set(exits(es).map(planKey));
 const ea=exitPlans(full),eb=exitPlans(part),exitChanged=difference(ea,eb),exitN=Math.max(ea.size,eb.size);
 const share=Math.max(prefix?timingChanged/prefix:0,Math.max(pa.size,pb.size)?planChanged/Math.max(pa.size,pb.size):0,exitN?exitChanged/exitN:0);
 return {version:2,prefix,changed:Math.max(timingChanged,planChanged)+exitChanged,share,
  repaints:prefix>=5&&share>REPAINT_MAX_SHARE,coverage:prefix>=5?'sufficient':'insufficient',timingChanged,planChanged,exitChanged,exits:exitN};
}

/** Compare the full run with the run on the shortened history (the same script, the same reading). */
export function compareRepaint(full: WorkerResult, bars: Bar[], part: WorkerResult, partBars: Bar[], scannerId: string, sc: Partial<ScannerConfig>,source?:string,variantOf?:string): RepaintCheck {
  const cutAt = partBars.at(-1)?.time??-Infinity;
  return compareEventPlans(readPrefix(full,bars,scannerId,sc,cutAt,source,variantOf),readPrefix(part,partBars,scannerId,sc,cutAt,source,variantOf));
}

export const repaintReason = (c: RepaintCheck) => `repaints: ${c.timingChanged} entry timing/direction, ${c.planChanged} entry-plan and ${c.exitChanged} exit-plan key differences across ${c.prefix} entries/${c.exits} exits when the last ${REPAINT_CUT} bars were hidden`;
