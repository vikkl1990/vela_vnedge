import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {IncubatorStore} from './store.ts';
test('quarantined results do not qualify copying or promotion; identity includes entry time and raw journal remains intact',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db);
 for(const [at,pnl]of [[1000,5],[2000,1]])db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt) VALUES('closed','s','s','BTCUSD','15m','long',1,0,1,100,?,?,?,0,1,2)",at,at+100,pnl);
 const p=db.get<{id:number}>('SELECT id FROM positions WHERE entry_at=1000')!;
 assert.equal(store.trades('s','BTCUSD','15m',2).length,2);
 db.run("INSERT INTO evidence_flags VALUES(?,999,'quarantined','range mismatch','test',3000)",p.id);
 assert.equal(store.trades('s','BTCUSD','15m',2).length,2,'reused position id does not inherit old flags');
 db.run("INSERT INTO evidence_flags VALUES(?,1000,'quarantined','range mismatch','test',3000)",p.id);
 assert.equal(store.trades('s','BTCUSD','15m',2).length,1);assert.equal(db.get<any>('SELECT realized_pnl FROM positions WHERE id=?',p.id).realized_pnl,5);
 db.run("UPDATE evidence_flags SET status='cleared' WHERE position_id=?",p.id);assert.equal(store.trades('s','BTCUSD','15m',2).length,2);
});
