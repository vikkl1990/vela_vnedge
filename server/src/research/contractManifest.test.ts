import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContractManifest as create,assessContract,verifyManifest,CONTRACT_CHECKS,type ContractProof} from './contractManifest.ts';
import {digest,type ExecutionEvidence} from './executionEvidence.ts';
import {buildGapQueue} from './gapReview.ts';
import type {ScannerContractDetail} from '../../../shared/scannerContracts.ts';
const detail={id:'s',name:'s',planId:null,summary:{sourceHash:'a'.repeat(64),runtimeHash:'b'.repeat(64),role:'entry',adapter:'Legacy reader'},reading:{extract:{reader:1}},policy:{},author:{}} as unknown as ScannerContractDetail;
const createContractManifest=(d:ScannerContractDetail,p:Record<string,unknown>={})=>create(d,p,'e'.repeat(64));
const proofs=(id:string):ContractProof[]=>CONTRACT_CHECKS.map(check=>({contractId:id,check,passed:true,artifactHash:'c'.repeat(64),command:'node --test verified-case.test.ts',checkedAt:10}));
test('contract identity pins execution, source, reader and runtime, excluding review/display metadata',()=>{
 const a=createContractManifest(detail);assert.ok(verifyManifest(a));assert.notEqual(create(detail,{},'f'.repeat(64)).id,a.id);
 assert.equal(createContractManifest({...detail,name:'new title',sourceReviewedAt:'new date'}).id,a.id);
 for(const d of [{...detail,reading:{extract:{reader:2}}},{...detail,summary:{...detail.summary,runtimeHash:'d'.repeat(64)}}])assert.notEqual(createContractManifest(d).id,a.id);
 assert.notEqual(createContractManifest(detail,{scriptTargets:'ignore'}).id,a.id);
 assert.equal(assessContract(a,[],20).state,'needs-validation');
 assert.equal(assessContract(a,proofs(a.id),20).state,'shadow-ready');assert.equal(assessContract(a,proofs(a.id),20).paperEligible,false);
});
test('new native contract readiness rejects stale, failed, future, conflicting or malformed proofs',()=>{
 const a=createContractManifest(detail),b=createContractManifest({...detail,reading:{reader:2}}),valid=proofs(a.id);
 assert.equal(assessContract(b,valid,20).state,'needs-validation');
 assert.equal(assessContract(a,valid,5).state,'needs-validation');
 assert.equal(assessContract(a,[...valid,{...valid[0],checkedAt:11,passed:false}],20).state,'needs-validation');
 assert.equal(assessContract(a,[...valid,{...valid[0],passed:false}],20).state,'needs-validation');
 assert.equal(assessContract(a,valid.map(p=>({...p,artifactHash:'not-a-hash'})),20).state,'needs-validation');
 for(const invalid of [null,{}, {...a,reading:undefined},{...a,id:'wrong'}])assert.equal(verifyManifest(invalid),false);
 assert.equal(assessContract({...a,id:'wrong'},valid,20).state,'invalid');
});
test('context roles and unsupported adapters cannot become autonomous native entries',()=>{
 for(const summary of [{...detail.summary,role:'context' as const},{...detail.summary,adapter:'Unsupported native reader'}]){
  const a=createContractManifest({...detail,summary});assert.equal(assessContract(a,proofs(a.id),20).state,'needs-validation');
 }
});
test('historical claims require exact contract, explicit evidence and regression; no prefix inference',()=>{
 const manifest=createContractManifest(detail),profile={scannerId:'s',profileId:'s',active:true,manifest,claims:[{kind:'reader',description:'direction',sourceLine:12}]};
 const evidence={trades:[{scannerId:'s'}, {scannerId:'s-extra'}]} as ExecutionEvidence;
 const a=buildGapQueue(evidence,[profile],[],20,1);assert.equal(a.queue[0].claims[0].status,'unknown');assert.equal(a.coverage,.5);
 const claimId=a.queue[0].claims[0].claimId;
 const decision={claimId,contractId:manifest.id,status:'intentional-variant' as const,evidence:['decision 195'],regression:null,reviewedAt:10};
 assert.equal(buildGapQueue(evidence,[profile],[decision],20).queue[0].claims[0].status,'intentional-variant');
 assert.equal(buildGapQueue(evidence,[profile],[{...decision,contractId:'old'}],20).queue[0].claims[0].status,'unknown');
 assert.equal(buildGapQueue(evidence,[profile],[{...decision,status:'fixed'}],20).queue[0].claims[0].status,'unknown');
 assert.equal(buildGapQueue(evidence,[profile],[{...decision,status:'fixed',regression:'reader regression test'}],20).queue[0].claims[0].status,'fixed');
 assert.ok(buildGapQueue(evidence,[profile],[],20).missingProfiles.includes('s-extra'));
 const empty=buildGapQueue(evidence,[{...profile,claims:[]}],[],20);assert.equal(empty.queue[0].reviewState,'no-claims-not-validated');
});
