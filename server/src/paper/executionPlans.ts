/** Versioned, explicit research plans. One source event feeds every plan in a cell. */
import { createHash } from 'node:crypto';
import type { AppConfig, PaperConfig, ExitMode } from '../config.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { exitConfigFor } from './logic.ts';
import { scannerExitPolicy, entryPolicy } from './policy.ts';
import { adaptPlan } from './planStudy.ts';

export interface ExecutionPlan {
  id: string; revision: number; enabled: boolean;
  scannerId: string; symbol: string; tf: string;
  variant: 'current' | 'native' | 'atr';
  /** Independent, fixed starting purse for comparable $150-sized experiments. */
  referenceEquity: number;
  /** Maximum observation window; never an assumed fee-offer eligibility window. */
  maxHoldMinutes?: number;
}
export interface ExecutionPlanSnapshot {
  id: string; revision: number; signature: string; sourceScannerId: string;
  variant: ExecutionPlan['variant']; symbol: string; tf: string;
  sourceHash:string|null; reading:AppConfig['scanners'][string]|null;
  paper: PaperConfig; exitMode: ExitMode; requireAtrStop: boolean;
  referenceEquity: number; maxHoldMinutes?: number;
}
const stable = (v: unknown) => JSON.stringify(v, (_k,x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))) : x);
export const planScannerId = (p: Pick<ExecutionPlanSnapshot,'id'|'revision'|'signature'>) => `plan:${p.id}:v${p.revision}:${p.signature}`;
export function planSnapshot(cfg: AppConfig, p: ExecutionPlan, sourceHash: string | null = null): ExecutionPlanSnapshot {
  const sc = cfg.scanners[p.scannerId];
  const exitMode = p.variant === 'current' ? sc?.exitMode ?? 'both' : 'levels';
  const base = p.variant === 'current' ? scannerExitPolicy(cfg,p.scannerId) : sc?.exit;
  const entry = entryPolicy(cfg,p.tf,'account');
  const paper = structuredClone(exitConfigFor(cfg.paper,p.symbol,base,p.tf));
  // Resolved settings must not be layered a second time in the backtester.
  delete paper.exitBySymbol;delete paper.exitByTf;
  Object.assign(paper, { initialEquity:p.referenceEquity, sizingMode:'margin', maxOpenPositions:100_000,
    // Prospective plan evidence always pays full fees. Account offer settings remain separate.
    scalperOffer:paper.scalperOffer ? {...paper.scalperOffer,enabled:false} : undefined,
    skipScriptStops:p.variant === 'current' && Boolean(cfg.paper.skipScriptStops),
    limitEntry:entry ? {enabled:true,tfs:[p.tf],books:['shadow'],atr:entry.pullbackAtr,bars:entry.pullbackBars} : undefined });
  const result = {id:p.id,revision:p.revision,sourceHash,reading:sc?structuredClone(sc):null,sourceScannerId:p.scannerId,variant:p.variant,symbol:p.symbol,tf:p.tf,
    paper,exitMode,requireAtrStop:Boolean(paper.skipScriptStops),referenceEquity:p.referenceEquity,maxHoldMinutes:p.maxHoldMinutes};
  const signature = createHash('sha256').update(stable({result,sourceHash,reading:sc,regime:cfg.risk.regime})).digest('hex').slice(0,12);
  return {...result,signature};
}
export function planEvents(events: ScanEvent[], bars: Bar[], p: ExecutionPlanSnapshot): ScanEvent[] {
  return p.variant === 'current' ? events : adaptPlan(events,bars,p.variant);
}
export function planBacktest(p: ExecutionPlanSnapshot) {
  const le=p.paper.limitEntry;
  return {cfg:p.paper,exitMode:p.exitMode,scannerExitResolved:true as const,requireAtrStop:p.requireAtrStop,
    executionPlan:p,entry:le?.enabled?{pullbackAtr:le.atr,pullbackBars:le.bars,limitWhenFlatOnly:true as const}:undefined};
}
export function validateExecutionPlans(plans: ExecutionPlan[] | undefined, tfs: Record<string,number>): string[] {
  if(plans===undefined)return [];
  if(!Array.isArray(plans))return ['executionPlans must be an array'];
  const errors:string[]=[],ids=new Set<string>();
  if(plans.length>30)errors.push('executionPlans supports at most 30 research plans');
  for(const p of plans){
    if(!p || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(p.id??'') || ids.has(p.id))errors.push('executionPlans requires unique safe ids');
    if(!p)continue;ids.add(p.id);
    if(typeof p.enabled!=='boolean'||!Number.isInteger(p.revision)||p.revision<1||typeof p.scannerId!=='string'||!p.scannerId||p.scannerId.startsWith('plan:')||typeof p.symbol!=='string'||!p.symbol||!(p.tf in tfs)||!['current','native','atr'].includes(p.variant))errors.push(`executionPlans.${p.id}: invalid cell, version or variant`);
    if(!Number.isFinite(p.referenceEquity)||p.referenceEquity<=0)errors.push(`executionPlans.${p.id}: positive referenceEquity required`);
    if(p.maxHoldMinutes!==undefined&&(!Number.isFinite(p.maxHoldMinutes)||p.maxHoldMinutes<=0))errors.push(`executionPlans.${p.id}: maxHoldMinutes must be positive`);
  }
  return errors;
}
