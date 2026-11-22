import {createHash} from 'node:crypto';
import {stablePolicy} from '../paper/strategyIdentity.ts';
import type {Position} from '../paper/logic.ts';
import {planScannerId,type ExecutionPlan} from '../paper/executionPlans.ts';
import {CAUSAL_EXIT_VERSION} from '../paper/exitExecution.ts';
export const SOL_MAKER_SCANNER='trend-impulse-channels-zeiierman-maker';
export const SOL_MAKER_REFERENCE_ID='sol-maker-half-stop-reference';
export const SOL_MAKER_TICK_REFERENCE_ID='sol-maker-tick-depth-reference';
/** Actual unchanged shadow exits provide the reference. Half-stop remains advisory. */
export const SOL_MAKER_REFERENCE:ExecutionPlan={id:SOL_MAKER_REFERENCE_ID,revision:1,enabled:true,
 scannerId:SOL_MAKER_SCANNER,symbol:'SOLUSD',tf:'15m',variant:'current',referenceEquity:1000,
 label:'SOL maker · current exits · advisory half-stop reference'};
/** Staged candidate; activation is a separate evidence decision. */
export const SOL_MAKER_TICK_REFERENCE:ExecutionPlan={...SOL_MAKER_REFERENCE,id:SOL_MAKER_TICK_REFERENCE_ID,
 enabled:false,makerFill:'tick-depth-v1',label:'SOL maker · tick/depth quantities · current exits'};
export function solMakerReference(p:Position):boolean {
 const x=p.executionPlan;
 return !!x&&((x.id===SOL_MAKER_REFERENCE_ID&&!x.makerFill)||(x.id===SOL_MAKER_TICK_REFERENCE_ID&&x.makerFill==='tick-depth-v1'))&&x.revision===1&&x.sourceScannerId===SOL_MAKER_SCANNER
  &&p.scannerId===planScannerId(x)&&p.symbol==='SOLUSD'&&p.tf==='15m'&&x.symbol===p.symbol&&x.tf===p.tf
  &&x.variant==='current'&&x.referenceEquity===1000&&x.executionVersion!>=CAUSAL_EXIT_VERSION
  &&!x.readingOverride&&!x.basket&&!x.failedTradeExit&&!x.profitFloor&&!x.takeProfit&&!x.exitPolicy&&!x.comparison&&x.maxHoldMinutes===undefined;
}

/** Research plans bind their entire frozen snapshot rather than a promotion policy. */
export function solReferencePolicy(p:Position){
 const x=p.executionPlan;
 return solMakerReference(p)&&x?.sourceHash ? {id:'research:'+createHash('sha256').update(stablePolicy(x)).digest('hex'),sourceHash:x.sourceHash} : null;
}
