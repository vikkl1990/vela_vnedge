import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReview,renderReview} from '../../../ops/build-execution-contract-review.ts';
import {exportExecutionEvidence} from './executionEvidence.ts';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {createContractManifest} from './contractManifest.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {ContractRegistry} from '../scanners/contracts.ts';

test('real registry review includes zero-trade active profiles and does not alter config or account eligibility',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const evidence=exportExecutionEvidence(db.db,{from:0,asOf:100,repositoryCommit:'fixture'});
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners={...cfg.scanners};
 for(const s of Object.values(cfg.scanners))s.enabled=false;
 const id='mesa-adaptive-cycle-engine-markittick';
 cfg.scanners[id]={enabled:true,exitMode:'both',symbols:['ETHUSD'],timeframes:['15m'],reader:2,sources:['alert'],entryProtection:'native',exit:{scriptTargets:'use'}};
 cfg.executionPlans=[];
 const before=JSON.stringify(cfg),r=buildReview(evidence,cfg);
 assert.equal(JSON.stringify(cfg),before);assert.equal(r.errors.length,0);assert.equal(r.manifests.length,1);
 assert.equal(r.queue.queue[0].active,true);assert.equal(r.queue.queue[0].trades,0);
 assert.equal(r.manifests[0].manifest.adapter,'MarkitTick native bracket v1');
 assert.equal(r.manifests[0].assessment.state,'needs-validation','old test totals cannot be assigned to a new exact-contract proof');
 assert.equal(r.promotionEligible,false);
 assert.ok(renderReview(r).includes('no trading changes'));
 assert.throws(()=>buildReview({...evidence,manifest:{...evidence.manifest,dataHash:'tampered'}},cfg),/integrity/);
});
test('native entry adapter can have bot targets in the comparison control',()=>{
 const registry=new ScannerRegistry(),contracts=new ContractRegistry();
 const scanner=registry.get('mesa-adaptive-cycle-engine-markittick')!;
 const detail=contracts.get(scanner,{reader:2,sources:['alert'],entryProtection:'native',exit:{scriptTargets:'use'}});
 const candidate=createContractManifest(detail,{paper:{scriptTargets:'use',skipScriptStops:false}},'e'.repeat(64));
 const control=createContractManifest(detail,{paper:{scriptTargets:'ignore',skipScriptStops:false}},'e'.repeat(64));
 assert.equal(candidate.lifecycle.targets,'adapter');assert.equal(control.lifecycle.targets,'external-policy');
 assert.equal(control.lifecycle.stop,'adapter');assert.notEqual(candidate.id,control.id);
});
