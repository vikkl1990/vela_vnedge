import {plotLifecycle} from '../scanners/plotLifecycle.ts';
import {BASKET_SCANNER,BASKET_ACCOUNTING_VERSION} from './basket.ts';
/** Versioned, explicit research plans. One source event feeds every plan in a cell. */
import {withProductFees,type ProductFees} from './productFees.ts';
import { createHash } from 'node:crypto';
import type { AppConfig, PaperConfig, ExitMode, ScannerConfig } from '../config.ts';
import {readerContractError,labelStyleContractError} from '../scanners/readerFixes.ts';
import {willyNativeReady} from '../scanners/willyContracts.ts';
import {CAUSAL_EXIT_VERSION} from './exitExecution.ts';
import {scannerEntryConfig} from './entryProtection.ts';
import {protectEntry} from './entryProtection.ts';
import type { Bar } from '../data/candleStore.ts';
import type { ScanEvent } from '../scanners/extractor.ts';
import { exitConfigFor } from './logic.ts';
import { scannerExitPolicy, entryPolicy } from './policy.ts';
import { adaptPlan } from './planStudy.ts';

// Decision 252: two source-pinned lifecycle profiles added to 34 existing experiments; account capacity is separate.
export const MAX_RESEARCH_PLANS = 36;
/** Explicit TP experiment; original stop and sizing stay fixed. Trail changes are opt-in and labeled. */
export interface TakeProfitPlan {
  mode: 'native' | 'r';
  rr?: [number, number, number];
  split: [number, number, number];
  trailAfterR?: number;
}
/** Complete proportional-trail experiment; never inherits earlier floors or stall tightening. */
export interface ProfitCapturePlan {
  afterR: number;
  giveBackPct: number;
  floorAtR: number;
  floorKeepR: number;
}
export interface PlanComparison { group: string; role: 'control' | 'candidate' }
/** Interpretation only: changing Pine inputs or trading rules requires a different experiment. */
export type ReadingOverride = {version:number} & Pick<Partial<ScannerConfig>,'reader'|'sources'|'labels'|'sides'|'labelStyles'|'invert'|'edge'>;
export interface ExecutionPlan {
  basket?: 'rsi-volume-ladder-v1';
  id: string; revision: number; enabled: boolean;
  scannerId: string; symbol: string; tf: string;
  variant: 'current' | 'native' | 'atr';
  /** Independent, fixed starting purse for comparable $150-sized experiments. */
  referenceEquity: number;
  /** Maximum observation window; never an assumed fee-offer eligibility window. */
  maxHoldMinutes?: number;
  takeProfit?: TakeProfitPlan;
  label?: string;
  trailing?: ProfitCapturePlan;
  /** Research sizing may tighten the account ceiling, never relax it. */
  maxStopLossPct?: number;
  comparison?: PlanComparison;
  readingOverride?: ReadingOverride;
}
export interface ExecutionPlanSnapshot {
  basket?: ExecutionPlan['basket'];
  /** Absent on legacy basket cohorts; never reinterpret their recorded R. */
  basketAccountingVersion?:2;
  id: string; revision: number; signature: string; sourceScannerId: string;
  variant: ExecutionPlan['variant']; symbol: string; tf: string;
  sourceHash:string|null; reading:AppConfig['scanners'][string]|null;
  paper: PaperConfig; exitMode: ExitMode; requireAtrStop: boolean;
  referenceEquity: number; maxHoldMinutes?: number;
  takeProfit?: TakeProfitPlan;
  label?: string;
  comparison?: PlanComparison;
  readingOverride?: ReadingOverride;
  /** Absent on historical cohorts: their execution rules remain frozen. */
  executionVersion?: number;
  partialExitVersion?: 1;
  /** Causal close-then-open reversal; scoped to newly validated author profiles. */
  reversalEntryVersion?: 1;
}
export function takeProfitLabel(p: Pick<ExecutionPlanSnapshot,'paper'|'takeProfit'|'basket'> & Partial<Pick<ExecutionPlanSnapshot,'sourceScannerId'>>): string {
  if(plotLifecycle(p.sourceScannerId))return p.sourceScannerId?.startsWith('machine-learning')?'Native Supertrend stop and flip exit · no fixed TP':'Native stop and TP1/TP2 milestones · closes at TP3';
  if(p.basket)return 'Basket: up to 3 entries · $150 total margin · 4% shared target · 3% below lowest fill stop';
  const c=p.paper, ladder=c.fallbackRR.join('/'), allocation=c.tpSplit.map(x=>`${Math.round(x*100)}%`).join('/');
  const trail=c.trailAfterR>0?`trail from ${c.trailAfterR}R · ${c.trailAtrMult>0?`${c.trailAtrMult} ATR distance`:c.trailGiveBackPct>0?`${c.trailGiveBackPct}% peak giveback`:`${c.trailDistanceR||1}R distance`}`:'trail off';
  const floor=c.floorAtR>0?` · floor ${c.floorKeepR}R from ${c.floorAtR}R`:'';
  return `${c.scriptTargets==='ignore'?'R ladder':c.scriptTargets==='widen'?'Native widened':'Native; fallback'} ${ladder}R · ${allocation} · ${trail}${floor}${c.trailSteps?.length?' · stepped tightening':''}${c.trailStall?.minutes?` · tightens after ${c.trailStall.minutes}m without a new peak`:''}`;
}
const stable = (v: unknown) => JSON.stringify(v, (_k,x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))) : x);
export const planScannerId = (p: Pick<ExecutionPlanSnapshot,'id'|'revision'|'signature'>) => `plan:${p.id}:v${p.revision}:${p.signature}`;
export function planSnapshot(cfg: AppConfig, p: ExecutionPlan, sourceHash: string | null = null, fees?:ProductFees): ExecutionPlanSnapshot {
  const original = cfg.scanners[p.scannerId];
  const override={...p.readingOverride};delete override.version;
  const sc=p.readingOverride?{...original,...override}:original;
  const exitMode = p.variant === 'current' ? sc?.exitMode ?? 'both' : 'levels';
  const base = p.variant === 'current' ? scannerExitPolicy(cfg,p.scannerId) : sc?.exit;
  const entry = entryPolicy(cfg,p.tf,'account',{scannerId:p.scannerId});
  const paper = structuredClone(withProductFees(scannerEntryConfig(exitConfigFor(cfg.paper,p.symbol,base,p.tf),original,p.tf),fees,p.symbol));
  // Resolved settings must not be layered a second time in the backtester.
  delete paper.exitBySymbol;delete paper.exitByTf;
  Object.assign(paper, { initialEquity:p.referenceEquity, sizingMode:'margin', maxOpenPositions:100_000,
    // Prospective plan evidence always pays full fees. Account offer settings remain separate.
    scalperOffer:paper.scalperOffer ? {...paper.scalperOffer,enabled:false} : undefined,
    skipScriptStops:p.variant === 'current' && Boolean(cfg.paper.skipScriptStops) && sc?.entryProtection !== 'native',
    limitEntry:entry ? {enabled:true,tfs:[p.tf],books:['shadow'],atr:entry.pullbackAtr,bars:entry.pullbackBars} : undefined });
  if(p.takeProfit)Object.assign(paper,{scriptTargets:p.takeProfit.mode==='native'?'use':'ignore',
    tpSplit:[...p.takeProfit.split],...(p.takeProfit.rr?{fallbackRR:[...p.takeProfit.rr]}:{}),
    ...(p.takeProfit.trailAfterR!==undefined?{trailAfterR:p.takeProfit.trailAfterR}:{})});
  if(p.trailing)Object.assign(paper,{trailAfterR:p.trailing.afterR,trailGiveBackPct:p.trailing.giveBackPct,
    floorAtR:p.trailing.floorAtR,floorKeepR:p.trailing.floorKeepR,trailAtrMult:0,trailDistanceR:0,trailSteps:[],trailStall:undefined});
  if(p.maxStopLossPct!==undefined)paper.maxStopLossPct=paper.maxStopLossPct>0?Math.min(paper.maxStopLossPct,p.maxStopLossPct):p.maxStopLossPct;
  const result = {...(p.basket?{basket:p.basket,basketAccountingVersion:BASKET_ACCOUNTING_VERSION as 2}:{}),id:p.id,revision:p.revision,executionVersion:CAUSAL_EXIT_VERSION,sourceHash,reading:sc?structuredClone(sc):null,sourceScannerId:p.scannerId,variant:p.variant,symbol:p.symbol,tf:p.tf,
    paper,exitMode,requireAtrStop:Boolean(paper.skipScriptStops),referenceEquity:p.referenceEquity,maxHoldMinutes:p.maxHoldMinutes,
    ...(p.takeProfit?{takeProfit:structuredClone(p.takeProfit)}:{}),...(p.label?{label:p.label}:{}),
    ...(p.comparison?{comparison:structuredClone(p.comparison)}:{})};
  if(p.basket && (paper.sizingMode!=='margin'||paper.marginPerTrade!==150||!(paper.maxStopLossPct!>0)||Object.keys(sc?.inputs??{}).length))throw Error('basket requires $150 margin, a stop cap and reviewed default inputs');
  const reversalEntryVersion=sc?.reader===3&&['reactive-trail-system-author-native','reaction-level-matrix-author-native'].includes(p.scannerId)?1 as const:undefined;
  const versioned = {...result,...(sc?.reader===3||p.basket||plotLifecycle(p.scannerId)?{partialExitVersion:1 as const}:{}),...(reversalEntryVersion?{reversalEntryVersion}:{}),...(p.readingOverride?{readingOverride:structuredClone(p.readingOverride)}:{})};
  // Presentation/grouping edits must not reset evidence for an identical policy.
  // A reading experiment chooses its own cell and enabled state. Account allocation edits
  // must not split its evidence or make a held position look like a different policy.
  // Keep full metadata in the snapshot; exclude only these non-behavioural fields from its
  // identity. Legacy exit experiments keep their historical signature convention.
  const readingIdentity=p.readingOverride&&sc?Object.fromEntries(Object.entries(sc).filter(([k])=>!['enabled','hidden','symbols','timeframes','pairs'].includes(k))):sc;
  const identity={...versioned,...(p.readingOverride?{reading:readingIdentity}:{})};delete identity.label;delete identity.comparison;
  const signature = createHash('sha256').update(stable({result:identity,sourceHash,reading:readingIdentity,regime:cfg.risk.regime})).digest('hex').slice(0,12);
  return {...versioned,signature};
}
export function planEvents(events: ScanEvent[], bars: Bar[], p: ExecutionPlanSnapshot): ScanEvent[] {
  return p.variant === 'current' ? events.map(ev=>protectEntry(ev,p.reading?.entryProtection)) : adaptPlan(events,bars,p.variant);
}
export function planBacktest(p: ExecutionPlanSnapshot) {
  if(p.basket)throw Error('basket execution requires stateful shadow replay; single-position candle backtest is unsupported');
  const le=p.paper.limitEntry;
  return {cfg:p.paper,exitMode:p.exitMode,scannerExitResolved:true as const,requireAtrStop:p.requireAtrStop,
    ...(p.reading?.reader===3||plotLifecycle(p.sourceScannerId)?{scriptStopAmendments:'after-close-v1' as const}:{}),
    executionPlan:p,entry:le?.enabled?{pullbackAtr:le.atr,pullbackBars:le.bars,limitWhenFlatOnly:true as const}:undefined};
}
export function validateExecutionPlans(plans: ExecutionPlan[] | undefined, tfs: Record<string,number>, cfg?:AppConfig): string[] {
  if(plans===undefined)return [];
  if(!Array.isArray(plans))return ['executionPlans must be an array'];
  const errors:string[]=[],ids=new Set<string>();
  if(plans.length>MAX_RESEARCH_PLANS)errors.push(`executionPlans supports at most ${MAX_RESEARCH_PLANS} research plans`);
  for(const p of plans){
    if(!p || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(p.id??'') || ids.has(p.id))errors.push('executionPlans requires unique safe ids');
    if(!p)continue;ids.add(p.id);
    // Validate effective basket prerequisites at save time, using the same policy
    // resolver as execution (including symbol/scanner overrides and the plan cap).
    if(p.basket&&cfg){
      try{planSnapshot(cfg,p);}catch(error){errors.push(`executionPlans.${p.id}: ${error instanceof Error?error.message:'invalid effective basket policy'}`);}
    }
    if(p.basket!==undefined&&(p.basket!=='rsi-volume-ladder-v1'||p.scannerId!==BASKET_SCANNER||p.variant!=='current'||!p.readingOverride||p.takeProfit||p.trailing||p.comparison))errors.push(`executionPlans.${p.id}: basket requires its versioned source and unmodified native bracket`);
    if(plotLifecycle(p.scannerId)&&(p.variant!=='current'||!p.readingOverride||p.trailing||p.takeProfit||p.basket||p.readingOverride.invert||p.readingOverride.reader!==undefined&&p.readingOverride.reader!==2))errors.push(`executionPlans.${p.id}: native plot lifecycle requires its versioned current reading and native exit policy`);
    if(p.scannerId===BASKET_SCANNER&&!p.basket)errors.push(`executionPlans.${p.id}: basket source requires its execution adapter`);
    if(p.readingOverride!==undefined){
      const r=p.readingOverride;
      if(!r||!Number.isInteger(r.version)||r.version<1||Object.keys(r).some(k=>!['version','reader','sources','labels','sides','labelStyles','invert','edge'].includes(k))||p.variant!=='current')errors.push(`executionPlans.${p.id}: invalid reading version or override`);
      if(r?.reader===3&&!willyNativeReady(p.scannerId))errors.push(`executionPlans.${p.id}: reader 3 requires a validated Willy adapter or non-trading role`);
      if(r?.reader===3&&r.invert)errors.push(`executionPlans.${p.id}: native reader cannot invert its contract`);
      const readerError=readerContractError(p.scannerId,r?.reader,r?.sides);if(readerError)errors.push(`executionPlans.${p.id}: ${readerError}`);
      const styleError=labelStyleContractError(r?.reader,r?.labelStyles);if(styleError)errors.push(`executionPlans.${p.id}: ${styleError}`);
      if(r?.reader!==undefined&&![1,2,3].includes(r.reader))errors.push(`executionPlans.${p.id}: invalid reader`);
      if(r?.sources!==undefined&&(!Array.isArray(r.sources)||r.sources.some(v=>!['alert','alertcondition','shape','derived','label'].includes(v))))errors.push(`executionPlans.${p.id}: invalid reading sources`);
      if(r?.labels!==undefined&&(!Array.isArray(r.labels)||r.labels.some(v=>typeof v!=='string'||!v.trim())))errors.push(`executionPlans.${p.id}: invalid reading labels`);
      if(r?.sides!==undefined&&(!r.sides||Array.isArray(r.sides)||typeof r.sides!=='object'||Object.values(r.sides).some(v=>!['long','short','none'].includes(v))))errors.push(`executionPlans.${p.id}: invalid reading sides`);
      if(['invert','edge'].some(k=>r?.[k as 'invert'|'edge']!==undefined&&typeof r[k as 'invert'|'edge']!=='boolean'))errors.push(`executionPlans.${p.id}: invalid reading flags`);
    }
    if(typeof p.enabled!=='boolean'||!Number.isInteger(p.revision)||p.revision<1||typeof p.scannerId!=='string'||!p.scannerId||p.scannerId.startsWith('plan:')||typeof p.symbol!=='string'||!p.symbol||!(p.tf in tfs)||!['current','native','atr'].includes(p.variant))errors.push(`executionPlans.${p.id}: invalid cell, version or variant`);
    if(!Number.isFinite(p.referenceEquity)||p.referenceEquity<=0)errors.push(`executionPlans.${p.id}: positive referenceEquity required`);
    if(p.maxHoldMinutes!==undefined&&(!Number.isFinite(p.maxHoldMinutes)||p.maxHoldMinutes<=0))errors.push(`executionPlans.${p.id}: maxHoldMinutes must be positive`);
    if(p.label!==undefined&&(typeof p.label!=='string'||!p.label.trim()||p.label.length>120))errors.push(`executionPlans.${p.id}: label must be 1..120 characters`);
    if(p.maxStopLossPct!==undefined&&(!Number.isFinite(p.maxStopLossPct)||p.maxStopLossPct<=0||p.maxStopLossPct>3))errors.push(`executionPlans.${p.id}: research stop-risk ceiling must be >0 and <=3%`);
    if(p.trailing!==undefined){
      const t=p.trailing;
      if(!t||![t.afterR,t.giveBackPct,t.floorAtR,t.floorKeepR].every(Number.isFinite)||t.afterR<=0||t.afterR>10||t.giveBackPct<=0||t.giveBackPct>=100||t.floorAtR<0||t.floorAtR>10||t.floorKeepR<0||(t.floorAtR===0?t.floorKeepR!==0:t.floorKeepR>=t.floorAtR))errors.push(`executionPlans.${p.id}: invalid profit-capture trail or floor`);
      if(p.takeProfit?.trailAfterR!==undefined)errors.push(`executionPlans.${p.id}: specify trail activation in only one place`);
    }
    if(p.comparison!==undefined&&(!p.comparison||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(p.comparison.group??'')||!['control','candidate'].includes(p.comparison.role)))errors.push(`executionPlans.${p.id}: invalid comparison group or role`);
    if(p.takeProfit!==undefined){
      const tp=p.takeProfit;
      if(!tp||!['native','r'].includes(tp.mode)||p.variant==='current')errors.push(`executionPlans.${p.id}: target experiments require a native/ATR level-exit plan`);
      if(!Array.isArray(tp?.split)||tp.split.length!==3||!tp.split.every(n=>Number.isFinite(n)&&n>=0&&n<=1)||Math.abs(tp.split.reduce((a,b)=>a+b,0)-1)>1e-6)errors.push(`executionPlans.${p.id}: TP split must be three fractions summing to one`);
      if(tp?.mode==='r'&&(!Array.isArray(tp.rr)||tp.rr.length!==3||!tp.rr.every((n,i,a)=>Number.isFinite(n)&&n>0&&(i===0||n>a[i-1]))))errors.push(`executionPlans.${p.id}: TP R ladder must be three increasing positive values`);
      if(tp?.mode==='native'&&tp.rr!==undefined)errors.push(`executionPlans.${p.id}: native targets cannot specify an R ladder`);
      if(tp?.trailAfterR!==undefined&&(!Number.isFinite(tp.trailAfterR)||tp.trailAfterR<0||tp.trailAfterR>10))errors.push(`executionPlans.${p.id}: TP trail activation must be 0..10R`);
    }
  }
  for(const group of new Set(plans.filter(p=>p?.comparison).map(p=>p.comparison!.group))){
    const pair=plans.filter(p=>p?.comparison?.group===group);
    const comparable=(p:ExecutionPlan)=>[p.scannerId,p.symbol,p.tf,p.variant,p.referenceEquity,p.maxStopLossPct,p.maxHoldMinutes,p.enabled,p.takeProfit];
    if(pair.length!==2||new Set(pair.map(p=>p.comparison!.role)).size!==2||stable(comparable(pair[0]))!==stable(comparable(pair[1])))errors.push(`executionPlans comparison ${group}: control and candidate must share source, entry/target policy, sizing and enabled state`);
  }
  return errors;
}
