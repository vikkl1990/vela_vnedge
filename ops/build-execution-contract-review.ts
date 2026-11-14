/** Build a review queue and contract manifests. No enabling, Pine runs, config changes, or promotion. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {ScannerRegistry} from '../server/src/scanners/registry.ts';
import {ContractRegistry} from '../server/src/scanners/contracts.ts';
import {authorReview,authorReviewCatalog} from '../server/src/library/authorReview.ts';
import {createContractManifest,assessContract,type ContractProof} from '../server/src/research/contractManifest.ts';
import {buildGapQueue,type GapDecision,type ReviewedProfile,type GapClaim} from '../server/src/research/gapReview.ts';
import {digest,verifyEvidenceSnapshot,type ExecutionEvidence} from '../server/src/research/executionEvidence.ts';
import {sourceHash} from '../server/src/paper/fingerprint.ts';
import {planSnapshot} from '../server/src/paper/executionPlans.ts';
import type {AppConfig} from '../server/src/config.ts';
/** A mechanics receipt is bound to reader/execution implementation as well as Pine bytes.
 * Research-only: changing this hash never resets the bot's existing trade evidence. */
function implementationHash(){
 const root=fileURLToPath(new URL('..',import.meta.url));
 const files:string[]=[];
 const collect=(dir:string)=>{for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())collect(p);else if(e.name.endsWith('.ts')&&!e.name.endsWith('.test.ts'))files.push(p);}};
 for(const dir of ['server/src/scanners','server/src/paper','server/src/pine','server/src/execution'])collect(dir);
 files.push('package-lock.json','server/src/config.ts');
 return digest(files.sort().map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')]));
}
const escape=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function buildReview(evidence:ExecutionEvidence,cfg:AppConfig,decisions:GapDecision[]=[],proofs:ContractProof[]=[],reviewedAt=evidence.manifest.asOf){
 if(!Number.isSafeInteger(reviewedAt)||reviewedAt<evidence.manifest.asOf)throw Error('Review time must be at or after the evidence cutoff');
 if(!verifyEvidenceSnapshot(evidence))throw Error('Evidence snapshot integrity mismatch');
 const implementation=implementationHash();
 const registry=new ScannerRegistry(),catalog=authorReviewCatalog(),contracts=new ContractRegistry(catalog),profiles:ReviewedProfile[]=[],errors:Array<{profileId:string;error:string}>=[];
 const active=new Set(Object.entries(cfg.scanners).filter(([,s])=>s.enabled).map(([id])=>id));
 for(const c of evidence.allocations)if(['shadow','proposed','live','demote_proposed','tracked'].includes(c.stage))active.add(c.scanner_id);
 const counts=new Map<string,number>();for(const t of evidence.trades)counts.set(t.scannerId,(counts.get(t.scannerId)??0)+1);
 const selected=new Set([...active,...[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,150).map(([id])=>id)]);
 const make=(id:string,plan?:NonNullable<AppConfig['executionPlans']>[number])=>{
  const profileId=plan?.id??id;
  try{
   const s=registry.get(id);if(!s)throw Error('Scanner is absent from the current registry; historical evidence is retained');
   const p=plan?planSnapshot(cfg,plan,sourceHash(s.patched)):undefined;
   const reading=p?.reading??cfg.scanners[id]??{};
   const detail=contracts.get(s,reading,p),review=authorReview(s,reading,catalog);
   const overrides=structuredClone(detail.policy.scannerOverrides);
   // Scanner-wide manifest does not claim cell-specific fee or risk resolution.
   const executionPolicy=p?{planSignature:p.signature,executionVersion:p.executionVersion,paper:p.paper,exitMode:p.exitMode}:
    {scope:'scanner-profile; cell policies remain separately bound in the evidence export',overrides};
   // Existing evidence identity is unaffected; this separate manifest records the proposed contract.
   const manifest=createContractManifest(detail,executionPolicy,implementation);
   const claims:GapClaim[]=(review.contract?.claims??[]).map(c=>({kind:'historical-reader-claim',description:`${c.marker}: ${c.problem}. ${c.evidence}`,sourceLine:c.line}));
   claims.push(...detail.summary.gaps.map(description=>({kind:'current-readiness-gap',description,sourceLine:null as number|null})));
   profiles.push({scannerId:id,profileId,active:plan?Boolean(plan.enabled):active.has(id),manifest,claims});
  }catch(e){errors.push({profileId,error:(e as Error).message});}
 };
 for(const id of [...selected].sort())if(!id.startsWith('plan:'))make(id);
 for(const plan of cfg.executionPlans??[])if(plan.enabled)make(plan.scannerId,plan);
 const queue=buildGapQueue(evidence,profiles,decisions,reviewedAt);
 const manifests=profiles.map(p=>({manifest:p.manifest,assessment:assessContract(p.manifest,proofs,reviewedAt)}));
 return {schema:1,asOf:evidence.manifest.asOf,reviewedAt,inputHash:evidence.manifest.dataHash,configHash:digest(cfg),catalogHash:digest(catalog),scope:'review-only',promotionEligible:false,summary:evidence.summary,errors,queue,manifests,
  notes:['Existing trading behavior and evidence identities are unchanged. These validation states apply to proposed native contract adoption, not holds on current readers.',
   'Historical claims are unknown until an exact-contract review decision supplies supporting evidence and regression coverage.',
   'Scanner-wide manifests do not replace resolved per-cell policies. Research plan fee settings still require product-specific execution validation.',
   'No-claims is not validated. A source-matched review is not executable or profitability evidence.']};
}
export function renderReview(r:ReturnType<typeof buildReview>){
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VN EDGE · Execution contract development</title><style>body{font:15px/1.6 system-ui;background:#0b1020;color:#e8edf8;max-width:1250px;margin:40px auto;padding:0 22px}h1,h2{line-height:1.2}small,p{color:#b7c5de}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #293348;vertical-align:top}code{overflow-wrap:anywhere}summary{cursor:pointer}a{color:#7bb5ff}.scroll{overflow:auto}.card{background:#141d31;padding:20px;border-radius:12px;margin:20px 0}</style><h1>VN EDGE · Execution contract development</h1><p>Evidence window ends ${escape(new Date(r.asOf).toISOString())}. Research only; no trading changes.</p><div class="card"><b>${escape(r.summary.trades)} closed trades · ${escape(r.summary.cells)} cells · ${escape(r.summary.bookCells)} book/cell combinations · ${escape(r.summary.cohorts)} separate policy cohorts</b><p>Top ${r.queue.top} traded scanners cover ${(100*r.queue.coverage).toFixed(1)}% of recorded trades. Active profiles are included regardless of trade count.</p></div>${r.notes.map(n=>`<p>${escape(n)}</p>`).join('')}<h2>Development sequence</h2><ol><li>Correct evidence export and verify high-impact claims (this foundation).</li><li>Bind adapters to executable contracts and collect exact-version mechanics proofs.</li><li>Run causal, cost-aware matched shadow comparisons.</li><li>Collect ordinary prospective shadow evidence under the unchanged qualification rules.</li><li>Consolidate UI readiness, then evaluate advisory ML.</li></ol><h2>Review queue (${r.queue.queue.length} profiles)</h2><div class="scroll"><table><thead><tr><th>Profile</th><th>Priority</th><th>Recorded trades</th><th>Claim disposition</th></tr></thead><tbody>${r.queue.queue.map(p=>`<tr><td>${escape(p.profileId)}<br><small>${escape(p.reviewState)}</small></td><td>${p.active?'Active':'Top activity'}</td><td>${p.trades}</td><td><details><summary>${p.claims.length} claims; ${p.claims.filter(c=>c.status==='unknown').length} awaiting verification</summary>${p.claims.map(c=>`<p><b>${escape(c.status)}</b> · ${escape(c.description)}${c.sourceLine?` (line ${escape(c.sourceLine)})`:''}</p>`).join('')}</details></td></tr>`).join('')}</tbody></table></div><h2>Unavailable or incomplete profiles</h2><pre>${escape(JSON.stringify(r.errors,null,2))}</pre><h2>Snapshot quality issues</h2><pre>${escape(JSON.stringify(r.summary.qualityIssues,null,2))}</pre><p>Missing fees, funding coverage or exit provenance are not converted into zero costs or author-exit claims. Native source fidelity and profitable execution require separate proof.</p><p><a href="review.json">Full manifests, requirements and queue</a></p></html>`;
}
export function main(args=process.argv.slice(2)){
 const values:Record<string,string>={};for(let i=0;i<args.length;i+=2){if(!['--evidence','--config','--out','--decisions','--proofs','--reviewed-at'].includes(args[i])||!args[i+1]||values[args[i]])throw Error('Use --evidence FILE --config FILE --out NEW_DIR [--decisions FILE] [--proofs FILE]');values[args[i]]=args[i+1];}
 for(const k of ['--evidence','--config','--out'])if(!values[k])throw Error(`${k} required`);
 const read=(k:string,fallback:unknown)=>values[k]?JSON.parse(fs.readFileSync(values[k],'utf8')):fallback;
 const report=buildReview(read('--evidence',null),read('--config',null),read('--decisions',[]),read('--proofs',[]),values['--reviewed-at']?Date.parse(values['--reviewed-at']):undefined);
 const out=path.resolve(values['--out']);fs.mkdirSync(out,{recursive:false});
 fs.writeFileSync(path.join(out,'review.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(out,'report.html'),renderReview(report),{flag:'wx',mode:0o600});
 console.log(JSON.stringify({out,profiles:report.manifests.length,errors:report.errors.length,coverage:report.queue.coverage}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main();
