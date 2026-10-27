import {TF_SECONDS, type PaperConfig} from '../config.ts';
import type {Bar} from '../data/candleStore.ts';
export type AlignmentRule = NonNullable<PaperConfig['entryAlignments']>[number];
export function alignmentRule(cfg:PaperConfig,scannerId:string,symbol:string,tf:string){return cfg.entryAlignments?.find(r=>r.scannerId===scannerId&&r.symbol===symbol&&r.tf===tf);}
/** Only completed, contiguous context bars may establish direction. Missing/stale/flat context refuses entry. */
export function alignmentRefusal(rule:AlignmentRule,side:'long'|'short',bars:Bar[],at:number):string|null {
 const ms=TF_SECONDS[rule.contextTf]*1000;
 const closed=bars.filter(b=>b.time+ms<=at).sort((a,b)=>a.time-b.time);
 const prefix=`entry alignment ${rule.contextTf} EMA${rule.emaLen}`;
 if(closed.length<rule.emaLen+1)return `${prefix}: insufficient closed context`;
 if(closed.at(-1)!.time!==Math.floor(at/ms)*ms-ms)return `${prefix}: stale context`;
 for(let i=1;i<closed.length;i++)if(closed[i].time-closed[i-1].time!==ms||!Number.isFinite(closed[i].close))return `${prefix}: invalid or gapped context`;
 if(!Number.isFinite(closed[0].close))return `${prefix}: invalid context`;
 let ema=closed[0].close,previous=ema;const k=2/(rule.emaLen+1);
 for(let i=1;i<closed.length;i++){previous=ema;ema+=k*(closed[i].close-ema);}
 const last=closed.at(-1)!.close;
 const bullish=last>ema&&ema>previous,bearish=last<ema&&ema<previous;
 return (side==='long'?bullish:bearish)?null:`${prefix}: ${side} requires ${side==='long'?'bullish':'bearish'} context`;
}
/** Backtests without explicit higher-frame history build only complete buckets, never partial bars. */
export function aggregateContext(bars:Bar[],tf:string,contextTf:string):Bar[]{
 const step=TF_SECONDS[tf]*1000,ms=TF_SECONDS[contextTf]*1000,n=ms/step;if(!Number.isInteger(n)||n<2)return [];
 const groups=new Map<number,Bar[]>();for(const b of bars){const t=Math.floor(b.time/ms)*ms;const g=groups.get(t)??[];g.push(b);groups.set(t,g);}
 const out:Bar[]=[];for(const[time,g]of groups){g.sort((a,b)=>a.time-b.time);if(g.length!==n||g.some((b,i)=>b.time!==time+i*step))continue;out.push({time,open:g[0].open,high:Math.max(...g.map(b=>b.high)),low:Math.min(...g.map(b=>b.low)),close:g.at(-1)!.close,volume:g.reduce((a,b)=>a+b.volume,0)});}return out.sort((a,b)=>a.time-b.time);
}
