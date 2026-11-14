import type {ExecutionEvidence} from './executionEvidence.ts';
import type {ExecutionContractManifest} from './contractManifest.ts';
import {digest} from './executionEvidence.ts';
export type GapDisposition='confirmed'|'intentional-variant'|'fixed'|'unsupported'|'unknown';
export interface GapClaim {kind:string;description:string;sourceLine:number|null}
export interface ReviewedProfile {scannerId:string;profileId:string;active:boolean;manifest:ExecutionContractManifest;claims:GapClaim[]}
export interface GapDecision {claimId:string;contractId:string;status:GapDisposition;evidence:string[];regression:string|null;reviewedAt:number}
/** Research claims remain unverified until reviewed against this exact active contract.
 * IDs and lineage are explicit; no prefix matching and no profitability-based approvals. */
export function buildGapQueue(evidence:ExecutionEvidence,profiles:ReviewedProfile[],decisions:GapDecision[],at:number,top=150){
 if(!Number.isSafeInteger(top)||top<1||!Number.isSafeInteger(at))throw Error('Invalid review queue bounds');
 const counts=new Map<string,number>();for(const t of evidence.trades)counts.set(t.scannerId,(counts.get(t.scannerId)??0)+1);
 const ranked=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 const topIds=new Set(ranked.slice(0,top).map(([id])=>id));
 const queue=profiles.filter(p=>p.active||topIds.has(p.scannerId)).map(p=>{
  const claims=p.claims.map(c=>{
   const claimId=digest({scannerId:p.scannerId,profileId:p.profileId,sourceHash:p.manifest.sourceHash,...c});
   const matching=decisions.filter(d=>d.claimId===claimId&&d.contractId===p.manifest.id&&Number.isSafeInteger(d.reviewedAt)&&d.reviewedAt<=at&&d.reviewedAt>=0&&d.evidence.length>0&&d.evidence.every(x=>typeof x==='string'&&x.trim())&&
    ['confirmed','intentional-variant','fixed','unsupported','unknown'].includes(d.status)&&(d.status!=='confirmed'&&d.status!=='fixed'||!!d.regression?.trim())).sort((a,b)=>b.reviewedAt-a.reviewedAt);
   const latest=matching[0],conflict=latest&&matching.some(d=>d.reviewedAt===latest.reviewedAt&&d.status!==latest.status);
   return {claimId,...c,status:conflict?'unknown' as const:latest?.status??'unknown' as const,decision:conflict?null:latest??null};
  });
  return {scannerId:p.scannerId,profileId:p.profileId,active:p.active,contractId:p.manifest.id,trades:counts.get(p.scannerId)??0,claims,
   reviewState:!claims.length?'no-claims-not-validated':claims.some(c=>c.status==='unknown')?'needs-review':'reviewed'};
 }).sort((a,b)=>Number(b.active)-Number(a.active)||b.trades-a.trades||a.profileId.localeCompare(b.profileId));
 const covered=ranked.slice(0,top).reduce((n,[,c])=>n+c,0);
 return {at,scope:'research-only' as const,promotionEligible:false as const,top,coveredTrades:covered,totalTrades:evidence.trades.length,coverage:evidence.trades.length?covered/evidence.trades.length:0,
  missingProfiles:ranked.filter(([id])=>topIds.has(id)&&!profiles.some(p=>p.scannerId===id)).map(([id])=>id),queue};
}
