/** Execution-contract foundation. These records validate research, never enable trading. */
import type {ScannerContractDetail} from '../../../shared/scannerContracts.ts';
import {digest} from './executionEvidence.ts';

export const CONTRACT_CHECKS=['source-parity','closed-bar-causality','lifecycle-accounting','restart-recovery','execution-pricing'] as const;
export type ContractCheck=typeof CONTRACT_CHECKS[number];
export interface ExecutionContractManifest {
 schema:1;id:string;scannerId:string;profileId:string;sourceHash:string;runtimeHash:string;readingHash:string;implementationHash:string;
 role:string;adapter:string;reading:Record<string,unknown>;
 lifecycle:{entry:'configured-reader'|'none';stop:'adapter'|'external-policy';targets:'adapter'|'external-policy';
  quantity:'portfolio-risk-owned';historicalLedger:'reference-only';unsupported:string[]};
 timing:{entry:'confirmed-observation';fill:'after-order-arrival';higherTimeframes:'require-as-of-proof'};
 executionPolicy:Record<string,unknown>;requirements:ContractCheck[];
}
export interface ContractProof {
 contractId:string;check:ContractCheck;passed:boolean;artifactHash:string;command:string;checkedAt:number;
}
const hashPattern=/^[a-f0-9]{64}$/;
/** Display prose and review timestamps do not identify executable behavior.
 * Full research-plan settings remain bound here; existing strategy/allocation identities are untouched. */
export function createContractManifest(detail:ScannerContractDetail,executionPolicy:Record<string,unknown>,implementationHash:string):ExecutionContractManifest {
 const {summary:s}=detail;
 if(!hashPattern.test(s.sourceHash)||!hashPattern.test(s.runtimeHash)||!hashPattern.test(implementationHash))throw Error('Exact source, runtime and implementation hashes required');
 const noEntry=['context','manual','exit'].includes(s.role)||s.adapter==='Context / no entries';
 const native=['MarkitTick native bracket v1','Source-pinned lifecycle v1','Native lifecycle reader','RSI basket adapter'].includes(s.adapter);
 const reading=structuredClone(detail.reading);
 const paper=executionPolicy.paper as Record<string,unknown>|undefined;
 const adapterStop=native&&paper?.skipScriptStops!==true,adapterTargets=native&&paper?.scriptTargets!=='ignore';
 const body={schema:1 as const,scannerId:detail.id,profileId:detail.planId??detail.id,sourceHash:s.sourceHash,runtimeHash:s.runtimeHash,readingHash:digest(reading),
  role:s.role,adapter:s.adapter,implementationHash,reading,lifecycle:{entry:noEntry?'none' as const:'configured-reader' as const,stop:adapterStop?'adapter' as const:'external-policy' as const,targets:adapterTargets?'adapter' as const:'external-policy' as const,
   quantity:'portfolio-risk-owned' as const,historicalLedger:'reference-only' as const,unsupported:[
    ...(s.adapter==='Unsupported native reader'?['No native reader implementation']:[]),
    ...(s.role==='unresolved'?['Author role is unresolved']:[])]},
  timing:{entry:'confirmed-observation' as const,fill:'after-order-arrival' as const,higherTimeframes:'require-as-of-proof' as const},
  executionPolicy:structuredClone(executionPolicy),requirements:[...CONTRACT_CHECKS]};
 return {id:digest(body),...body};
}
export function verifyManifest(value:unknown):value is ExecutionContractManifest {
 if(!value||typeof value!=='object')return false;
 try {
 const {id,...body}=value as ExecutionContractManifest;
 return body.schema===1&&typeof id==='string'&&digest(body)===id&&
  [body.sourceHash,body.runtimeHash,body.readingHash,body.implementationHash].every(x=>typeof x==='string'&&hashPattern.test(x))&&
  digest(body.reading)===body.readingHash&&Array.isArray(body.requirements)&&
  CONTRACT_CHECKS.every(c=>body.requirements.includes(c))&&body.requirements.length===CONTRACT_CHECKS.length&&
  body.lifecycle?.quantity==='portfolio-risk-owned'&&body.lifecycle?.historicalLedger==='reference-only'&&
  ['configured-reader','none'].includes(body.lifecycle?.entry)&&Array.isArray(body.lifecycle?.unsupported)&&
  body.timing?.entry==='confirmed-observation'&&body.timing?.fill==='after-order-arrival'&&body.timing?.higherTimeframes==='require-as-of-proof';
 }catch{return false;}
}
/** Fail closed for a proposed NEW native execution profile. Existing policies are untouched.
 * Proofs certify mechanics only; profitability and ordinary shadow qualification remain separate. */
export function assessContract(manifest:ExecutionContractManifest,proofs:ContractProof[],at:number){
 const reasons:string[]=[];
 if(!verifyManifest(manifest)||!Number.isSafeInteger(at)||at<0)return {state:'invalid' as const,reasons:['Invalid manifest or evaluation time'],paperEligible:false as const};
 reasons.push(...manifest.lifecycle.unsupported);
 if(manifest.lifecycle.entry==='none')reasons.push('This role does not provide autonomous entries');
 for(const check of manifest.requirements){
  const matching=proofs.filter(p=>p.contractId===manifest.id&&p.check===check&&Number.isSafeInteger(p.checkedAt)&&p.checkedAt<=at&&p.checkedAt>=0&&hashPattern.test(p.artifactHash)&&typeof p.command==='string'&&p.command.trim());
  const lastAt=Math.max(-1,...matching.map(p=>p.checkedAt));
  const latest=matching.filter(p=>p.checkedAt===lastAt);
  if(!latest.length||latest.some(p=>p.passed!==true))reasons.push(`${check}: ${latest.length?'failed':'no matching proof'}`);
 }
 return {state:reasons.length?'needs-validation' as const:'shadow-ready' as const,reasons,paperEligible:false as const};
}
