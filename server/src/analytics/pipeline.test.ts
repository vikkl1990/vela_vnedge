import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {scannerPipeline} from './pipeline.ts';
test('pipeline distinguishes successful quiet scans from generated refused entries',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 db.run('CREATE TABLE scanner_run_log(scanner_id TEXT,symbol TEXT,tf TEXT,at INTEGER,outcome TEXT)');
 db.run("INSERT INTO scanner_runs(scanner_id,symbol,tf,at,ms,error,bar_time) VALUES('s','BTCUSD','15m',1000,1,NULL,0)");
 db.run("INSERT INTO scanner_run_log VALUES('s','BTCUSD','15m',1000,'ok')");
 const cells=[{scannerId:'s',symbol:'BTCUSD',tf:'15m'}];
 assert.equal(scannerPipeline(db,cells,2000).cells[0].runs,1);
 assert.equal(scannerPipeline(db,cells,2000).cells[0].entries24h,0);
 db.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,side,label,message,source,action) VALUES(1500,0,'s','s','BTCUSD','15m','entry','long','Long','','alert','rejected:costs')");
 const row=scannerPipeline(db,cells,2000).cells[0];assert.equal(row.entries24h,1);assert.equal(row.latest.action,'rejected:costs');assert.equal(row.failures,0);
 assert.equal(scannerPipeline(db,[{...cells[0],symbol:'ETHUSD'}],2000).cells[0].lastRun,null);
});
