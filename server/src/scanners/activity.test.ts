import {test}from'node:test';import assert from'node:assert/strict';import {Db}from'../db.ts';import {scannerWeekFunnel}from'./activity.ts';
test('scanner activity separates fills from pending orders and exposes pilot and protection refusals',t=>{
  const d=new Db(':memory:');t.after(()=>d.db.close());
  const actions=['opened','pending:limit','rejected:copy pilot daily entry limit',"rejected:the scanner's own stop: the account takes only the ATR stop (decision 146)",'rejected:stop too tight for fees','rejected:risk regime: quiet'];
  actions.forEach((a,i)=>d.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,side,label,message,source,action) VALUES(100,?,'s','S','BTCUSD','15m','entry','long',?,'','alert',?)",i,String(i),a));
  const f=scannerWeekFunnel(d,0).get('s')!;assert.equal(f.entries,6);assert.equal(f.opened,1);assert.equal(f.pending,1);assert.equal(f.pilot,1);assert.equal(f.protection,1);assert.equal(f.fee,1);assert.equal(f.regime,1);assert.equal(f.other,0);
  assert.equal(scannerWeekFunnel(d,101).size,0);
});
test('exact refusal markets and times survive the summary without truncating funnel counts',t=>{
  const d=new Db(':memory:');t.after(()=>d.db.close());
  const put=(at:number,symbol:string,action:string,kind='entry')=>d.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,side,label,message,source,action) VALUES(?,?,'s','S',?,'1h',?,'long',?,'','alert',?)",at,at,symbol,kind,String(at),action);
  put(10,'OLDUSD','rejected:old');
  put(101,'ETHUSD','rejected:risk per symbol cap');put(102,'ETHUSD','rejected:risk per symbol cap');
  put(103,'SOLUSD','rejected:risk per symbol cap');put(104,'SOLUSD','rejected:risk burst');
  put(105,'SOLUSD','rejected:another');put(106,'SOLUSD','pending:limit');
  put(107,'SOLUSD','opened');put(108,'SOLUSD','rejected:exit','exit');
  const w=scannerWeekFunnel(d,100).get('s')!;
  assert.equal(w.entries,7);assert.equal(w.opened,1);assert.equal(w.pending,1);
  assert.equal(w.lastEntryAt,107);assert.equal(w.reasons.length,3);
  assert.deepEqual(w.reasons[0],{action:'rejected:risk per symbol cap',symbol:'ETHUSD',tf:'1h',n:2,lastAt:102});
  assert.equal(w.other,4);assert.equal(w.guard,1);
});
