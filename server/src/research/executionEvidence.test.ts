import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy,saveTradePolicy} from '../paper/tradePolicy.ts';
import {exportExecutionEvidence,median,levelProvenance,digest,verifyEvidenceSnapshot} from './executionEvidence.ts';
import {exportArgs} from '../../../ops/export-execution-evidence.ts';
const W={from:0,asOf:10_000_000,repositoryCommit:'test-revision'};
function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'execution-evidence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'test.db'),db=new Db(path);t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG),policy=resolveTradePolicy(cfg,{scannerId:'s',symbol:'ETHUSD',tf:'15m'},'a'.repeat(64),2);
 saveTradePolicy(db,policy);let id=0;
 const add=(extra:Record<string,unknown>={})=>{
  const row={scanner_id:'s',scanner_name:'s',symbol:'ETHUSD',tf:'15m',bt:2,status:'closed',side:'long',qty:1,qty_open:0,contract_value:1,entry_price:100,
   entry_at:1000+id++,exit_at:2000,risk_amount:2,realized_pnl:1,fees:.2,levels_source:'script',exit_reason:'sl',policy_id:policy.id,evidence_scope:'shadow',
   fills:JSON.stringify({features:{src_alert:1,src_shape:1},fills:[{at:1000,reason:'entry',fee:.1,feeGross:.1,feeDiscount:0,pnl:0},{at:2000,reason:'sl',fee:.1,feeGross:.1,feeDiscount:0,pnl:1}]}),...extra};
  return Number(db.run(`INSERT INTO positions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);
 };
 const read=()=>{const ro=new DatabaseSync(path,{readOnly:true});try{return exportExecutionEvidence(ro,W);}finally{ro.close();}};
 return {db,path,policy,add,read,cfg};
}
test('snapshot preserves books, policies, experimental scope, boundary and exact medians without writes',t=>{
 const {db,policy,add,read}=fixture(t);
 const current=add({entry_at:1000});add({bt:0,evidence_scope:'account',entry_at:1000,exit_at:61000});
 add({evidence_scope:'tracker'});add({evidence_scope:'experiment'});add({bt:1,evidence_scope:'backtest'});
 add({policy_id:null});add({policy_adopted_at:1000});
 const other={...policy,id:'different',strategyId:'different'};saveTradePolicy(db,other);add({policy_id:other.id});
 const flagged=add();const entry=db.get<any>('SELECT entry_at FROM positions WHERE id=?',flagged).entry_at;
 db.run("INSERT INTO evidence_flags VALUES(?,?,'quarantined','fault','test',1)",flagged,entry);
 add({scanner_id:'plan:old',evidence_scope:'shadow'});
 add({entry_at:0,exit_at:W.asOf}); // exclusive boundary
 add({status:'open'});
 const before=db.db.prepare('SELECT total_changes() n').get()!.n;
 const a=read(),b=read();assert.equal(a.summary.trades,10);assert.equal(a.summary.cells,2);assert.equal(a.summary.bookCells,4);
 assert.deepEqual(a,b);assert.equal(db.db.prepare('SELECT total_changes() n').get()!.n,before);
 assert.equal(a.trades.find(r=>r.positionId===current)!.eligibleByExistingBoundary,true);
 assert.equal(a.summary.eligibleByExistingBoundary,3);assert.equal(a.summary.scopes.quarantined,1);
 assert.equal(a.summary.scopes.experiment,2);
 assert.ok(a.cohorts.some(c=>c.policyId==='different'));assert.ok(a.cohorts.every(c=>!(c.book===2&&c.n>2)));
 assert.deepEqual(a.trades[0].channels,['alert','shape']);
 assert.equal(a.trades[0].exit.owner,'unknown','sl label is not evidence of bot/author ownership');
 assert.equal(a.manifest.promotionEligible,false);assert.equal(a.trades[0].costs.voucherBenefit,null);
 assert.equal(a.manifest.dataHash,digest({policies:a.policies,trades:a.trades,cohorts:a.cohorts,allocations:a.allocations}));
 assert.equal(a.summary.medianHoldMinutes,median(a.trades.map(r=>r.holdMinutes!)));
});
test('bad chronology, malformed snapshots and missing costs remain visible instead of being discarded',t=>{
 const {add,read}=fixture(t);
 add({risk_amount:0,fills:'{broken',policy_id:'missing',entry_at:9000,exit_at:1000});
 add({fees:2,fills:JSON.stringify({fills:[{at:2000,reason:'tp1',fee:.1,pnl:1}]})});
 const r=read();assert.equal(r.summary.trades,2);assert.equal(r.trades[0].r,null);assert.equal(r.trades[0].holdMinutes,null);
 assert.ok(r.trades[0].quality.includes('fill-ledger-invalid'));assert.ok(r.trades[0].quality.includes('policy-invalid'));
 assert.equal(r.trades[1].costs.grossCommission,null);assert.equal(r.trades[1].costs.feeDiscount,null);
 assert.ok(r.trades[1].quality.includes('fees-do-not-reconcile'));assert.equal(r.trades[1].exit.owner,'unknown');
});
test('funding cashflows, gross commissions and discounts remain separate',t=>{
 const {add,read}=fixture(t);
 add({realized_pnl:.7,fees:.1,fills:JSON.stringify({fills:[{at:1000,reason:'entry',fee:.1,feeGross:.1,feeDiscount:0,pnl:0},
  {at:1500,reason:'funding',fee:0,pnl:-.3},{at:2000,reason:'trail',fee:0,feeGross:.1,feeDiscount:.1,pnl:1}]})});
 const r=read().trades[0];assert.ok(Math.abs(r.net!-.6)<1e-9);assert.equal(r.costs.fundingPnl,-.3);
 assert.equal(r.costs.cashCommission,.1);assert.equal(r.costs.grossCommission,.2);assert.equal(r.costs.feeDiscount,.1);
 assert.equal(r.costs.fundingCoverage,'not-certified');assert.deepEqual(r.quality,[]);
});
test('raw medians and level provenance do not repeat the old gap-matrix assumptions',()=>{
 assert.equal(median([1,2,100,200]),51);assert.equal(median([]),null);
 assert.equal(levelProvenance('atr-fallback',{scriptTargets:'use'}).targets.owner,'unknown');
 assert.equal(levelProvenance('mixed',{scriptTargets:'ignore'}).targets.owner,'bot');
 assert.equal(levelProvenance('script',{}).stop.owner,'provided');
 assert.equal(levelProvenance('script',{}).exit.owner,'unknown');
});
test('CLI requires explicit UTC bounds and rejects unknown/duplicate options',()=>{
 assert.throws(()=>exportArgs([]),/required/);assert.throws(()=>exportArgs(['--db','x','--db','y']),/Required/);
 assert.throws(()=>exportArgs(['--db','x','--out','y','--from','2026-11-01','--as-of','now']),/UTC/);
 const a=exportArgs(['--db','x','--out','y','--from','2026-11-01T00:00:00Z','--as-of','2026-11-14T00:00:00Z']);assert.equal(a.from,Date.parse('2026-11-01T00:00:00Z'));
});
test('research plans keep their own frozen policy and never enter promotion evidence',t=>{
 const {add,read}=fixture(t);
 const plan={id:'x',signature:'cohort-1',sourceHash:'version',sourceScannerId:'source',symbol:'ETHUSD',tf:'15m',paper:{scriptTargets:'ignore'}};
 add({scanner_id:'plan:x:cohort-1',policy_id:null,evidence_scope:'experiment',fills:JSON.stringify({executionPlan:plan,fills:[{at:1000,reason:'entry',fee:.1,pnl:0},{at:2000,reason:'tp1',fee:.1,pnl:1}]})});
 const r=read().trades[0];assert.equal(r.policyStatus,'plan-bound');assert.equal(r.eligibleByExistingBoundary,false);assert.equal(r.planSignature,'cohort-1');assert.equal(r.targets.owner,'bot');assert.equal(r.exit.owner,'unknown');assert.ok(!r.quality.includes('policy-missing'));
});
test('empty historical ledger is missing evidence, never zero known fees or funding',t=>{
 const {add,read}=fixture(t);add({fills:'[]'});const r=read().trades[0];
 assert.ok(r.quality.includes('fill-ledger-invalid'));assert.equal(r.costs.cashCommission,null);assert.equal(r.costs.fundingPnl,null);
});

test('snapshot checksum binds the evaluation window and summary as well as individual trades',t=>{
 const {add,read}=fixture(t);add();const r=read();assert.equal(verifyEvidenceSnapshot(r),true);
 assert.equal(verifyEvidenceSnapshot({...r,manifest:{...r.manifest,asOf:r.manifest.asOf+1}}),false);
 assert.equal(verifyEvidenceSnapshot({...r,summary:{...r.summary,trades:999}}),false);
 const altered=structuredClone(r);altered.trades[0].r=100;assert.equal(verifyEvidenceSnapshot(altered),false);
});

test('export CLI writes one private snapshot and refuses to overwrite it or the source DB',t=>{
 const {add,path:dbPath,db}=fixture(t);add();const out=join(dbPath+'-export.json');
 const cli=fileURLToPath(new URL('../../../ops/export-execution-evidence.ts',import.meta.url));
 const args=['--no-warnings',cli,'--db',dbPath,'--from','1970-01-01T00:00:00Z','--as-of','2026-11-14T00:00:00Z','--out',out];
 const run=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
 const bytes=readFileSync(out);assert.equal(verifyEvidenceSnapshot(JSON.parse(bytes.toString())),true);
 assert.equal(statSync(out).mode&0o777,0o600);
 const again=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(again.status,0);assert.match(again.stderr,/Output exists/);assert.deepEqual(readFileSync(out),bytes);
 const dbOverwrite=spawnSync(process.execPath,[...args.slice(0,-1),dbPath],{encoding:'utf8'});assert.notEqual(dbOverwrite.status,0);
 assert.equal(db.get<any>('SELECT count(*) n FROM positions').n,1);
});


test('stop activation receipts export for their position lifetime without inferring a book field',t=>{
 const {db,add,read}=fixture(t);const id=add({entry_at:1000});
 db.db.exec('CREATE TABLE paper_stop_amendments(position_id INTEGER NOT NULL,active_at INTEGER NOT NULL,stop REAL NOT NULL,PRIMARY KEY(position_id,active_at))');
 for(const [at,stop] of [[999,90],[1000,95],[1500,100],[2001,105]])db.run('INSERT INTO paper_stop_amendments VALUES(?,?,?)',id,at,stop);
 const rows=read().trades.find(r=>r.positionId===id)!.receipts.paper_stop_amendments;
 assert.deepEqual(rows.map(r=>[r.active_at,r.stop]),[[1000,95],[1500,100]]);
});


test('checkout dirty detection is bounded for large vendor-source updates',async t=>{
 const{checkoutDirty}=await import('../../../ops/export-execution-evidence.ts');
 const{mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const{tmpdir}=await import('node:os');const{execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'evidence-git-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});git(['init','-q']);writeFileSync(join(root,'large.txt'),'baseline');git(['add','large.txt']);git(['-c','user.name=Evidence Test','-c','user.email=evidence@example.invalid','commit','-qm','fixture']);
 assert.equal(checkoutDirty(root),false);writeFileSync(join(root,'large.txt'),'source'.repeat(400000));assert.equal(checkoutDirty(root),true);
});
