import {plotLifecycle,ML_RSI_NATIVE} from './plotLifecycle.ts';
import {createHash} from 'node:crypto';
import {authorReview, authorReviewCatalog, type AuthorReviewCatalog} from '../library/authorReview.ts';
import type {ScannerConfig} from '../config.ts';
import type {LoadedScanner} from './registry.ts';
import {sourceFacts} from './sourceFacts.ts';
import {readingOf} from './reading.ts';
import {willyContract, willyNativeReady} from './willyContracts.ts';
import {readerContractError, labelStyleContractError} from './readerFixes.ts';
import {takeProfitLabel, type ExecutionPlanSnapshot} from '../paper/executionPlans.ts';
import type {ScannerRole, ScannerContractDetail} from '../../../shared/scannerContracts.ts';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x instanceof Set?[...x].sort():x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);

/** Exact reviewed categories only. A missing/mismatched source cannot inherit a prose role. */
export function contractRole(review:ReturnType<typeof authorReview>):ScannerRole {
  if(!review.contract)return 'unresolved';
  const role=review.descriptionStatus==='reviewed'?review.publication?.role?.trim().toLowerCase():null;
  if(role==='manual / restricted'||role==='manual')return 'manual';
  if(review.contract.type==='context-only')return 'context';
  if(role==='exit tool'||role==='exit-only')return 'exit';
  if(role==='trade setup'||role==='setup detector')return 'setup';
  return review.contract.type==='complete-strategy'?'strategy':review.contract.type==='signal-tool'?'entry':'unresolved';
}

/** Single interpretation record for base scanners and effective research readings.
 * It describes implementation; it neither rewrites readings nor certifies profitability. */
export function scannerContract(s:LoadedScanner, sc:Partial<ScannerConfig>, plan?:ExecutionPlanSnapshot,
  catalog:AuthorReviewCatalog=authorReviewCatalog()):ScannerContractDetail {
  const review=authorReview(s,sc,catalog),role=contractRole(review),facts=sourceFacts(s.patched),reader=sc.reader??1;
  const gaps:string[]=[],capabilities:string[]=[];
  if(review.sourceStatus!=='matches')gaps.push(review.sourceStatus==='changed'?'Installed source differs from the reviewed source.':'No source-matched review.');
  if(review.descriptionStatus!=='reviewed')gaps.push(`Author publication: ${review.descriptionStatus}.`);
  const entryOff=Array.isArray(sc.sources)&&sc.sources.length===0;
  const native=willyContract(s.id),nativeReader=reader===3&&willyNativeReady(s.id)&&!sc.invert;
  const plotNative=plotLifecycle(s.id)&&reader===2&&s.patches.includes('native-lifecycle-observations-v1')&&!sc.invert;
  let adapter=reader===1?'Legacy reader':`Reader ${reader}`;
  if(plan?.basket){adapter='RSI basket adapter';capabilities.push('Up to three entries within one $150 basket','Shared stop and target','Durable partial exits');}
  else if(plotNative){
    adapter='Source-pinned lifecycle v1';capabilities.push('Confirmed source signals with validated native stop',s.id===ML_RSI_NATIVE?'Causal Supertrend amendments and opposite-side flip exit; no fixed target':'Native target milestones; full closure at farthest target');
    if(!plan)gaps.push('Validated in experimental shadow only; paper evidence is not established.');
  }
  else if(nativeReader&&native?.role!=='Context'&&native?.role!=='Manual / restricted'){
    adapter='Native lifecycle reader';capabilities.push('Validated native entry geometry','Side-specific exits and stop amendments');
    if(plan?.partialExitVersion)capabilities.push('Durable partial exits');
    else gaps.push('Native partial-exit execution is not selected by this profile.');
    if(plan?.reversalEntryVersion)capabilities.push('Causal close-then-open reversal');
  }else if(nativeReader||entryOff){adapter='Context / no entries';capabilities.push('No entry orders from this reading');}
  else if(reader===3){adapter='Unsupported native reader';gaps.push('No supported native adapter for this scanner and reading.');}
  else capabilities.push('Configured signal extraction');
  const guard=readerContractError(s.id,sc.reader,sc.sides)??labelStyleContractError(sc.reader,sc.labelStyles);
  if(guard)gaps.push(guard);
  if((role==='context'||role==='manual'||role==='exit')&&!entryOff&&!nativeReader)gaps.push('Author role does not establish autonomous entries; audit the active reading.');
  if(!plan?.basket&&!nativeReader&&!plotNative&&review.contract&&(review.contract.stop.has||review.contract.exit.has||review.contract.targets.has))gaps.push('Native lifecycle parity is not certified for this reading; inspect the configured exit policy.');
  if(role==='entry')capabilities.push('Uses a separate bot exit policy');
  if(facts.dependencies.length)gaps.push('Requested external series need data-availability and causal replay checks.');
  if(review.contract?.timing.repaints)gaps.push('Source study reports repainting; require causal prefix evaluation.');
  const read=readingOf(sc,s.id,undefined,s.patched,s.variantOf);
  const reading=JSON.parse(stable(read)) as Record<string,unknown>;
  const runtimeHash=hash(s.patched);
  const scannerOverrides=Object.fromEntries(Object.entries(sc).filter(([k])=>!['enabled','hidden','symbols','timeframes','pairs'].includes(k)));
  // Registry version is descriptive only, deliberately separate from existing evidence identities.
  const contractVersion=hash(stable({schema:1,source:review.sourceHash,runtimeHash,reading,role,scannerOverrides,
    reviewedAt:review.sourceReviewedAt,publicationReviewedAt:review.publication?.reviewedAt,
    execution:plan?{signature:plan.signature,partial:plan.partialExitVersion,reversal:plan.reversalEntryVersion}:null})).slice(0,24);
  return {id:s.id,name:s.name,url:s.url,planId:plan?.id??null,
    summary:{role,sourceStatus:review.sourceStatus,publicationStatus:review.descriptionStatus,sourceHash:review.sourceHash,runtimeHash,contractVersion,reader,adapter,capabilities,gaps,
      intent:review.contract?.idea??'Source intent requires review.'},
    sourceReviewedAt:review.sourceReviewedAt,publicationReviewedAt:review.publication?.reviewedAt??null,variant:review.variant,
    author:{entries:review.contract?.entries??[],nonEntries:review.contract?.notEntries??[],stop:review.contract?.stop??null,targets:review.contract?.targets??null,exit:review.contract?.exit??null,timing:review.contract?.timing??null,requirements:review.descriptionStatus==='reviewed'?review.publication?.requirements??null:null},
    reading,policy:{exitMode:plan?.exitMode??sc.exitMode??'both',entryProtection:sc.entryProtection??'inherit',takeProfit:plan?takeProfitLabel(plan):null,inputs:sc.inputs??{},timezone:sc.timezone??'Etc/UTC',scannerOverrides},
    dependencies:facts.dependencies,cautions:facts.cautions,historicalNotes:review.integrationNotes};
}

/** Cache only immutable source/reading records, never runtime evidence or eligibility. */
export class ContractRegistry {
  private cache=new Map<string,{key:string;detail:ScannerContractDetail}>();
  constructor(privateCatalog?:AuthorReviewCatalog){this.catalog=privateCatalog??authorReviewCatalog();}
  private catalog:AuthorReviewCatalog;
  get(s:LoadedScanner,sc:Partial<ScannerConfig>,plan?:ExecutionPlanSnapshot){
    const id=plan?`plan:${plan.id}`:s.id;
    const key=hash(stable({source:s.source,patched:s.patched,id:s.id,file:s.file,variantOf:s.variantOf,variantReason:s.variantReason,sc,plan}));
    const old=this.cache.get(id);if(old?.key===key)return old.detail;
    const detail=scannerContract(s,sc,plan,this.catalog);this.cache.set(id,{key,detail});return detail;
  }
}
