import type {PaperConfig} from '../config.ts';
import type {Bar} from '../data/candleStore.ts';

export type ReclaimTrial = NonNullable<PaperConfig['reclaimTrials']>[number];
type Cell = {scannerId:string;symbol:string;tf:string};

/** Selective trials are account-only; callers remove them for shadow/exchange policies. */
export function selectiveReclaimRule(paper:PaperConfig, cell:Cell):ReclaimTrial|undefined {
  return paper.reclaimTrials?.find(r=>r.enabled&&r.minSignalBarAtr!==undefined
    &&r.scannerId===cell.scannerId&&r.symbol===cell.symbol&&r.tf===cell.tf);
}

/** Tighten the cell's loss budget on ordinary entries as well as delayed maker fills. */
export function trialRiskConfig(paper:PaperConfig, rule:ReclaimTrial|undefined):PaperConfig {
  const cap=rule?.maxStopLossPct;
  return cap===undefined?paper:{...paper,maxStopLossPct:paper.maxStopLossPct>0?Math.min(paper.maxStopLossPct,cap):cap};
}

/** Read the completed source candle, independently of optional ML features or the current mark. */
export function expansionRatio(bar:Pick<Bar,'time'|'high'|'low'|'close'>|undefined, signalTime:number, atr:number|undefined):number|null {
  if(!bar||bar.time!==signalTime||!atr||!Number.isFinite(atr)||atr<=0
    ||![bar.high,bar.low,bar.close].every(Number.isFinite)||bar.low<=0||bar.high<bar.low
    ||bar.close<bar.low||bar.close>bar.high)return null;
  return (bar.high-bar.low)/atr;
}
