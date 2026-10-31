import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {App} from '../app.ts';
function setup(t:any,funnel:Record<string,Array<[number,string]>>){
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const app={db,config:{get:()=>({incubator:{tfs:['15m'],admit:{},maxShadow:800}})},incubatorStore:{list:()=>[{symbol:'BTCUSD',tf:'15m',stage:'tracked'}],shadowFunnel:()=>funnel},marketGate:{today:{markets:[{symbol:'BTCUSD',allowed:false,turnoverUsd:1e8,atrPct:.4}]},verdict:()=>({allowed:true})}};
 return {app,db};
}
test('radar includes shadow signals and refusals independently of the account journal',t=>{
 const now=Date.now();const {app,db}=setup(t,{'s|BTCUSD|15m':[[now-1000,'regime'],[now-900,'opened'],[now-8*86400000,'cost'],[now+60000,'cost']],'bad':[[now,'cost']]});
 db.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,side,tp,label,message,source,action) VALUES(?,0,'s','s','BTCUSD','15m','entry','long','[]','e','','alert','rejected:risk burst')",now-500);
 const v=App.prototype.radarView.call(app as any,24,6);const c=v.markets[0].cells['15m']!;
 assert.equal(c.signals,1);assert.equal(c.shadowSignals,2);assert.equal(c.tracked,1);assert.equal(v.totals['15m'].shadowSignals,2);assert.match(c.refusal!,/position caps|shadow regime/);
 assert.equal(v.markets[0].allowed,true,'effective fresh-depth policy replaces the cached screening veto');
});
test('shadow-only market is visible even with no account signals or current assignment',t=>{
 const {app}=setup(t,{'s|SUIUSD|15m':[[Date.now()-1000,'cost']]});
 const v=App.prototype.radarView.call(app as any,24,6);const c=v.markets.find(m=>m.symbol==='SUIUSD')!.cells['15m']!;
 assert.equal(c.signals,0);assert.equal(c.shadowSignals,1);assert.equal(c.refusal,'shadow cost ×1');
});
test('bounded shadow history is marked as a lower bound',t=>{
 const now=Date.now();const {app}=setup(t,{'s|BTCUSD|15m':Array.from({length:120},(_,i)=>[now-1000-i,'regime'])});
 const v=App.prototype.radarView.call(app as any,24,6);assert.equal(v.shadowHistoryCapped,true);assert.equal(v.markets[0].cells['15m']!.shadowHistoryCapped,true);
});
test('radar counts fills, excludes pending/cancelled orders and isolated TP experiments',t=>{
 const {app,db}=setup(t,{}),at=Date.now()-1000;
 for(const [status,sid] of [['open','s'],['closed','s'],['pending','s'],['cancelled','s'],['open','plan:tp:v1:x'],['closed','plan:tp:v1:x']]){
  db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt,exit_at,realized_pnl,risk_amount) VALUES(?,?,'S','BTCUSD','15m','long',1,1,1,100,?,2,?,10,10)",status,sid,at,status==='closed'?at:null);
 }
 const c=App.prototype.radarView.call(app as any,24,6).markets[0].cells['15m']!;
 assert.equal(c.opened,2);assert.equal(c.closes,1);assert.equal(c.netR,1);
});
