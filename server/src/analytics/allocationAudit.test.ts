import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { allocationAudit } from './allocationAudit.ts';
import { initEntryExecution,depthFill } from '../paper/entryExecution.ts';
test('allocation audit uses exact active tuples, entry-date windows and separate books', t => {
 const db=new Db(':memory:');t.after(()=>db.db.close());initEntryExecution(db);
 const now=1800000000000;
 const add=(symbol:string,tf:string,book:number,days:number,pnl:number,fee:number)=>db.run(`INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,exit_reason,bt,config_fp) VALUES ('closed','s','S',?,?,'long',1,0,1,100,?,?,?, ?,1,'sl',?,'old')`,symbol,tf,now-days*86400000,now-days*86400000+60000,pnl,fee,book);
 add('BTCUSD','1h',0,1,1,.1);add('BTCUSD','1h',0,8,-1,.1);add('BTCUSD','1h',2,1,-1,.2);
 add('ETHUSD','1h',0,1,-100,1);add('BTCUSD','15m',0,1,-100,1);
 const a={scannerId:'s',scannerName:'S',symbol:'BTCUSD',tf:'1h'};
 const out=allocationAudit(db,[a,a],now);assert.equal(out.rows.length,1);
 const r=out.rows[0];assert.equal(r.account.recent.n,1);assert.equal(r.account.recent.netR,.9);assert.equal(r.account.prior.netR,-1.1);
 assert.equal(r.shadow.recent.netR,-1.2);assert.equal(r.account.recent.firstBarStops,1);assert.equal(r.verdict,'insufficient evidence');
});
test('depth uses contract quantity and distinguishes incomplete depth from full coverage',()=>{
 const asks=[{price:'102',size:'1'},{price:'100',size:'1'}];
 assert.deepEqual(depthFill(asks,2,'long'),{coverage:1,vwap:101,impactBps:100.00000000000009});
 const partial=depthFill(asks,4,'long');assert.equal(partial.coverage,.5);
 const short=depthFill([{price:'100',size:1},{price:'98',size:1}],2,'short');assert.equal(short.vwap,99);assert.ok(short.impactBps!>0);
 assert.equal(depthFill([],2,'long').vwap,null);
});
