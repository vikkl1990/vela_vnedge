import {createHash} from 'node:crypto';
import type {TradePolicy} from './tradePolicy.ts';
import type {PaperConfig} from '../config.ts';

export const stablePolicy=(value:unknown):string=>JSON.stringify(value,(_key,v)=>
  v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);

type Strategy=Pick<TradePolicy,'version'|'sim'|'scannerId'|'symbol'|'tf'|'sourceHash'|'reading'|'exitMode'|'paper'|'risk'>;
/** The existing strategy identity, factored without changing any historical hashes. */
export function strategyTerms(p:Strategy){
  const paper=structuredClone(p.paper) as Partial<PaperConfig>;
  for(const k of ['initialEquity','sizingMode','riskPerTradePct','marginPerTrade','marginLeverage','minLeverage','maxLeverage','maxStopLossPct','maxOpenPositions'] as const)delete paper[k];
  if(paper.limitEntry)paper.limitEntry={...paper.limitEntry,books:['account','shadow']};
  return {version:p.version,sim:p.sim,scannerId:p.scannerId,symbol:p.symbol,tf:p.tf,sourceHash:p.sourceHash,reading:p.reading,exitMode:p.exitMode,paper,regime:p.risk.regime};
}
export const strategyIdFor=(p:Strategy)=>createHash('sha256').update(stablePolicy(strategyTerms(p))).digest('hex');
