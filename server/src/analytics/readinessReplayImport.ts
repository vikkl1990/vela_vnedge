import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Db} from '../db.ts';
import {stablePolicy,type TradePolicy} from '../paper/tradePolicy.ts';
import {executionReplayEvidence,executionReplayLedgerHash,recordExecutionReplay,type ExecutionReplayResult} from './readinessExecutionReplay.ts';

/** Offline replay can run beside the bot. Importing receipts must not compete
 * with its SQLite writer, even when each individual transaction is short. */
export function requireReadinessMaintenance(probe=()=>execFileSync('systemctl',['show','vnedge','--property=ActiveState','--value'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']})){
 let state:string;try{state=probe().trim();}catch{throw Error('Cannot verify vnedge is stopped; audit import refused');}
 if(state!=='inactive')throw Error(`Stop vnedge before importing audit receipts (service ${state||'unknown'}); replay without --record can run online`);
}

/** Import already-computed evidence in one offline transaction. The caller
 * verifies maintenance before opening the database as well. No position writes. */
export function importReadinessReceipts(db:Db,results:ExecutionReplayResult[],catalog:Map<number,TradePolicy>,expectedHash:string,assertStopped=requireReadinessMaintenance){
 assertStopped();
 assert.match(expectedHash,/^[a-f0-9]{64}$/);
 assert.equal(createHash('sha256').update(stablePolicy(results)).digest('hex'),expectedHash,'reviewed replay checksum mismatch');
 let retained=0,recorded=0,identical=0;
 const seen=new Set<number>();
 db.transaction(()=>{
  assertStopped();
  for(const result of results){
   assert.ok(!seen.has(result.positionId),'duplicate replay subject');seen.add(result.positionId);
   assert.equal(executionReplayLedgerHash(db,result.positionId),result.ledgerHash,'replay subject changed');
   const current=catalog.get(result.positionId);assert.ok(current,'missing current policy');
   const saved=db.get<{snapshot:string}>('SELECT snapshot FROM trade_policies WHERE id=?',result.previousId);assert.ok(saved,'missing original policy');
   const previous=JSON.parse(saved.snapshot) as TradePolicy;
   if(executionReplayEvidence(db,result.positionId,previous,current)==='identical'){
    assert.equal(result.outcome,'identical','refusing to replace valid evidence with failure');retained++;
   }else{recordExecutionReplay(db,result);recorded++;}
   assert.equal(executionReplayEvidence(db,result.positionId,previous,current),result.outcome,'receipt does not verify against the journal');
   if(result.outcome==='identical')identical++;
  }
 });
 return {recorded,retained,identical};
}
