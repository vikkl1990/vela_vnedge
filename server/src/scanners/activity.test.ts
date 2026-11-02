import {test}from'node:test';import assert from'node:assert/strict';import {Db}from'../db.ts';import {scannerWeekFunnel}from'./activity.ts';
test('scanner activity separates fills from pending orders and exposes pilot and protection refusals',t=>{
  const d=new Db(':memory:');t.after(()=>d.db.close());
  const actions=['opened','pending:limit','rejected:copy pilot daily entry limit',"rejected:the scanner's own stop: the account takes only the ATR stop (decision 146)",'rejected:stop too tight for fees','rejected:risk regime: quiet'];
  actions.forEach((a,i)=>d.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,side,label,message,source,action) VALUES(100,?,'s','S','BTCUSD','15m','entry','long',?,'','alert',?)",i,String(i),a));
  const f=scannerWeekFunnel(d,0).get('s')!;assert.equal(f.entries,6);assert.equal(f.opened,1);assert.equal(f.pending,1);assert.equal(f.pilot,1);assert.equal(f.protection,1);assert.equal(f.fee,1);assert.equal(f.regime,1);assert.equal(f.other,0);
  assert.equal(scannerWeekFunnel(d,101).size,0);
});
