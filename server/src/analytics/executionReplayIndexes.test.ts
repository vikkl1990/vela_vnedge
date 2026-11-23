import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {PaperExitExecution} from '../paper/exitExecution.ts';
import {executionReplaySubject,executionSubjectHash} from './readinessExecutionReplay.ts';

test('indexed exit provenance returns identical subjects without scanning unrelated depth reports',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());new PaperExitExecution(db,0);
 db.db.exec('DROP INDEX paper_exit_intent_position;DROP INDEX paper_exit_report_intent;');
 db.transaction(()=>{for(let i=1;i<=200;i++){
  db.run("INSERT INTO paper_exit_intents VALUES(?,?,0,'AVAXUSD','short','sl',10,11,100,2,2,2,2,'filled',NULL,20)",i,i);
  db.run("INSERT INTO paper_exit_reports VALUES(?,?,20,2,2,101,'book','{}')",i,i);
 }});
 const before=executionReplaySubject(db,75),hash=executionSubjectHash(before);
 new PaperExitExecution(db,0); // Production migration is idempotent.
 const after=executionReplaySubject(db,75);
 assert.deepEqual(after,before);assert.equal(executionSubjectHash(after),hash);
 for(const [sql,index]of [
  ['SELECT * FROM paper_exit_intents WHERE position_id=75 ORDER BY id','paper_exit_intent_position'],
  ['SELECT * FROM paper_exit_reports WHERE intent_id IN (SELECT id FROM paper_exit_intents WHERE position_id=75) ORDER BY at,id','paper_exit_report_intent'],
 ] as const){const plan=db.all<{detail:string}>('EXPLAIN QUERY PLAN '+sql).map(x=>x.detail).join('\n');assert.ok(plan.includes(index),plan);assert.doesNotMatch(plan,/SCAN paper_exit_(?:intents|reports)/);}
});
