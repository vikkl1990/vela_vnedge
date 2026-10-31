import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db.ts';

function pending(db: Db) {
  return Number(db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt) VALUES ('pending','','','','','long',0,0,1,0,0,2)").lastInsertRowid);
}
const scope = (db: Db, id: number) => db.get<{evidence_scope: string | null}>('SELECT evidence_scope FROM positions WHERE id=?',id)!.evidence_scope;

test('pending identity captures scope once; later fill, stage changes and restart preserve it',t=>{
 const dir=mkdtempSync(join(tmpdir(),'vnedge-scope-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'journal.db');let db=new Db(file);
 db.run("INSERT INTO incubator_pairs(scanner_id,symbol,tf,stage,since,updated) VALUES ('s','BTCUSD','1h','tracked',1,1)");
 const id=pending(db);assert.equal(scope(db,id),null);
 db.run("UPDATE positions SET scanner_id='s',symbol='BTCUSD',tf='1h' WHERE id=?",id);
 assert.equal(scope(db,id),'tracker');
 db.run("UPDATE incubator_pairs SET stage='live'");
 db.run("UPDATE positions SET status='open',scanner_id='s' WHERE id=?",id);
 db.db.close();db=new Db(file);assert.equal(scope(db,id),'tracker');
 const ordinary=pending(db);db.run("UPDATE positions SET scanner_id='s',symbol='BTCUSD',tf='1h' WHERE id=?",ordinary);
 assert.equal(scope(db,ordinary),'shadow');
 const plan=pending(db);db.run("UPDATE positions SET scanner_id='plan:trial:v1:abc' WHERE id=?",plan);assert.equal(scope(db,plan),'experiment');
 // Simulate pre-migration rows whose historical role was never captured.
 db.run('UPDATE positions SET evidence_scope=NULL WHERE id=?',ordinary);db.db.close();db=new Db(file);
 assert.equal(scope(db,ordinary),'legacy-shadow');
 db.run("UPDATE incubator_pairs SET stage='tracked'");db.db.close();db=new Db(file);
 assert.equal(scope(db,ordinary),'legacy-shadow');db.db.close();
});
