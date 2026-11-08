import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {Journal, journalFilter, csvCell} from './journal.ts';
import {performanceReport} from './performance.ts';

const T=Date.UTC(2026,10,8), H=3600_000;
const filter=(q: Record<string,string>={})=>journalFilter(new URLSearchParams(q));
function fixture(t:any) { const db=new Db(':memory:');t.after(()=>db.db.close());return {db,j:new Journal(db)}; }
function insert(db:Db,over:Record<string,unknown>={}) {
 const r={status:'closed',scanner_id:'s',scanner_name:'Scanner',symbol:'ETHUSD',tf:'15m',side:'long',qty:2,qty_open:0,contract_value:.1,entry_price:100,entry_at:T-H,exit_at:T,exit_reason:'trail',realized_pnl:10,fees:2,risk_amount:5,bt:0,sl:105,sl_original:75,tp:'[125,150]',tp_hit:'[true,false]',fills:JSON.stringify({marginLeverage:5,mlProb:.65,fills:[{at:T-H,price:100,qty:2,reason:'entry',fee:1,pnl:0},{at:T,price:110,qty:2,reason:'trail',fee:1,pnl:12},{at:T,price:110,qty:0,reason:'funding',fee:0,pnl:-2}]}),...over};
 return Number(db.run(`INSERT INTO positions(${Object.keys(r).join(',')}) VALUES(${Object.keys(r).map(()=>'?').join(',')})`,...Object.values(r) as any[]).lastInsertRowid);
}

test('paper and shadow remain separate; all history includes watch and research with explicit scope',t=>{
 const {db,j}=fixture(t);insert(db);insert(db,{bt:2});insert(db,{bt:2,evidence_scope:'tracker'});insert(db,{bt:2,scanner_id:'plan:sample'});insert(db,{bt:1});insert(db,{bt:3});
 assert.equal(j.page(filter()).total,1);assert.equal(j.page(filter({book:'shadow'})).total,3);
 assert.equal(j.page(filter({book:'shadow',scope:'watch'})).total,1);assert.equal(j.page(filter({book:'shadow',scope:'plans'})).total,1);
 const evidence=j.page(filter({book:'shadow',scope:'evidence'}));assert.equal(evidence.total,1);
 assert.equal(evidence.summary.net,performanceReport(db,{},T+1).shadow.net);
});

test('accounting decomposes funding, commission and risk without treating unknowns as zero',t=>{
 const {db,j}=fixture(t);insert(db);
 const r=j.page(filter()).rows[0];assert.equal(r.net,8);assert.equal(r.commission,2);assert.equal(r.funding,-2);assert.equal(r.grossTrading,12);assert.equal(r.r,1.6);
 assert.equal(r.margin,4);assert.equal(r.notional,20);assert.equal(r.marginLeverage,5);assert.equal(r.mlProbability,.65);
 insert(db,{risk_amount:0,fills:'broken'});const s=j.page(filter()).summary;
 assert.equal(s.unknownFunding,1);assert.equal(s.unknownRisk,1);assert.equal(s.avgR,1.6);
 const missing=j.page(filter()).rows[0];assert.equal(missing.margin,null);assert.equal(missing.fills,null);assert.equal(missing.funding,null);
});

test('pending/open rows never inflate closed profit and date basis is explicit',t=>{
 const {db,j}=fixture(t);insert(db);insert(db,{status:'open',exit_at:null,qty_open:2});insert(db,{status:'pending',exit_at:null,qty:0,qty_open:0,entry_at:T+H});
 const all=j.page(filter({status:'all'}));assert.equal(all.total,3);assert.equal(all.summary.closed,1);assert.equal(all.summary.net,8);assert.equal(all.summary.open,1);assert.equal(all.summary.pending,1);
 assert.equal(all.rows.find(r=>r.status==='open')!.net,null);
 assert.equal(j.page(filter({status:'all',from:String(T),to:String(T+2*H),dateBy:'entry'})).total,1);
 assert.equal(j.page(filter({status:'all',from:String(T),to:String(T+2*H),dateBy:'exit'})).total,1);
});

test('all filters precede paging; totals and sorting cover every matching row',t=>{
 const {db,j}=fixture(t);insert(db,{realized_pnl:30});insert(db,{realized_pnl:-20,exit_at:T+1});insert(db,{symbol:'BTCUSD',realized_pnl:1000});insert(db,{scanner_id:'other'});
 const f=filter({scanner:'s',symbol:'ETHUSD',tf:'15m',side:'long',reason:'trail',from:String(T),to:String(T+2),limit:'1',sort:'worst'});
 const p=j.page(f);assert.equal(p.total,2);assert.equal(p.rows.length,1);assert.equal(p.rows[0].net,-22);assert.equal(p.summary.net,6);
 assert.equal(j.page({...f,offset:1}).rows[0].net,28);assert.equal(j.page({...f,offset:99}).rows.length,0);
 assert.equal(j.csv({...f,offset:99}).trim().split('\r\n').length,3,'export ignores pagination');
});

test('deleted pending orders retain cancellations without inventing placement prices or double counting',t=>{
 const {db,j}=fixture(t);const id=insert(db,{status:'pending',exit_at:null,qty:0,qty_open:0});
 db.run('DELETE FROM positions WHERE id=?',id);
 const p=j.page(filter({status:'all'}));assert.equal(p.total,1);assert.equal(p.rows[0].status,'cancelled');assert.equal(p.rows[0].entryAt,null);assert.equal(p.rows[0].entryPrice,null);assert.equal(p.rows[0].risk,null);assert.equal(p.rows[0].net,null);assert.equal(p.summary.closed,0);
 assert.equal(j.detail('paper',id).row.missingPosition,true);assert.throws(()=>j.detail('shadow',id),/not found/);
 db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage,reason) VALUES(?,0,?,'s','ETHUSD','15m','cancelled','duplicate event')",Date.now()+1,id);
 assert.equal(j.page(filter({status:'cancelled'})).total,1);
 assert.equal(j.page(filter({status:'cancelled',dateBy:'entry',from:String(T)})).total,0);
});

test('detail includes signal, fills, timeline, policy, ML and path coverage only for the requested book',t=>{
 const {db,j}=fixture(t);const id=insert(db,{policy_id:'policy-one'});
 db.run("INSERT INTO trade_policies VALUES('policy-one','strategy','hash','{\"tp\":2}')");
 db.run("INSERT INTO position_path(position_id,at,price,r) VALUES(?,?,110,0.4)",id,T);
 db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage,snapshot) VALUES(?,0,?,'s','ETHUSD','15m','entry','{}')",T,id);
 const d=j.detail('paper',id);assert.equal(d.row.fills!.length,3);assert.equal(d.policy!.sourceHash,'hash');assert.equal((d.pathCoverage as any).samples,1);assert.equal(d.decisions.length,1);assert.equal(d.signal,null);
 assert.throws(()=>j.detail('shadow',id),/not found/);assert.throws(()=>j.detail('paper',NaN),/Invalid/);
});

test('exports all fills, including legacy embedded fills, without duplicating the order ledger',t=>{
 const {db,j}=fixture(t);const id=insert(db);
 db.run("INSERT INTO orders(at,position_id,scanner_id,symbol,side,qty,price,fee,reason,bt,price_source) VALUES(?,?,'s','ETHUSD','buy',2,100,1,'entry',0,'quote')",T-H,id);
 const csv=j.csv(filter(),true);assert.equal(csv.trim().split('\r\n').length,4);assert.match(csv,/quote/);assert.match(csv,/position record only/);assert.match(csv,/funding/);
 assert.equal(j.csv(filter({book:'shadow'}),true).trim().split('\r\n').length,1);
});

test('exports retain more than 5000 records and 200 fills',t=>{
 const {db,j}=fixture(t);db.transaction(()=>{for(let i=0;i<5001;i++)insert(db,{fills:'[]'});});
 assert.equal(j.page(filter({limit:'1'})).summary.closed,5001);assert.equal(j.csv(filter({limit:'1',offset:'50'})).trim().split('\r\n').length,5002);
 const id=insert(db,{symbol:'BTCUSD',fills:JSON.stringify({fills:Array.from({length:201},(_,i)=>({at:T+i,price:100,qty:1,reason:'tp1',fee:.1,pnl:1}))})});
 assert.equal(j.detail('paper',id).row.fills!.length,201);assert.equal(j.csv(filter({symbol:'BTCUSD'}),true).trim().split('\r\n').length,202);
});

test('reset archives are opt-in, retain their original book and link archived fills with original decisions',t=>{
 const {db,j}=fixture(t);insert(db);const archived=insert(db,{bt:-1});insert(db,{bt:-3,evidence_scope:'tracker'});insert(db,{bt:-3,evidence_scope:'shadow'});
 db.run("INSERT INTO orders(at,position_id,scanner_id,symbol,side,qty,price,fee,reason,bt) VALUES(?,?,'s','ETHUSD','buy',2,100,1,'entry',-1)",T-H,archived);
 db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage) VALUES(?,0,?,'s','ETHUSD','15m','entry')",T-H,archived);
 assert.equal(j.page(filter()).total,1);assert.equal(j.page(filter()).summary.archived,0);
 const all=j.page(filter({history:'all'}));assert.equal(all.total,2);assert.equal(all.summary.archived,1);assert.equal(all.summary.net,16);
 const old=j.page(filter({history:'archived'}));assert.equal(old.total,1);assert.equal(old.rows[0].book,'paper');assert.equal(old.rows[0].archived,true);
 const detail=j.detail('paper',archived);assert.equal(detail.orders.length,1);assert.equal(detail.decisions.length,1);assert.throws(()=>j.detail('shadow',archived),/not found/);
 assert.equal(j.page(filter({book:'shadow',history:'archived',scope:'evidence'})).total,1);
 assert.equal(j.page(filter({book:'shadow',history:'archived',scope:'watch'})).total,1);
 assert.equal(j.csv(filter({history:'archived'}),true).trim().split('\r\n').length,4);
});

test('deleted cancellations before a reset appear only in archived history',t=>{
 const {db,j}=fixture(t);db.kvSet('paper.resetAt',T);
 for(const [id,at] of [[900,T-H],[901,T+H]])db.run("INSERT INTO decision_trace(at,book,position_id,scanner_id,symbol,tf,stage) VALUES(?,0,?,'s','ETHUSD','15m','cancelled')",at,id);
 assert.deepEqual(j.page(filter({status:'all'})).rows.map(r=>r.id),[901]);
 assert.deepEqual(j.page(filter({status:'all',history:'archived'})).rows.map(r=>r.id),[900]);
 assert.equal(j.page(filter({status:'all',history:'all'})).total,2);assert.equal(j.detail('paper',900).row.archived,true);
});

test('unsafe filter values are rejected; CSV cells cannot inject formulas or break records',()=>{
 const bad:Record<string,string>[]=[{book:'live'},{status:'bad'},{scope:'wrong'},{history:'wrong'},{dateBy:'bad'},{sort:'wrong'},{limit:'201'},{offset:'-1'},{offset:'1.5'},{from:'NaN'},{side:'both'},{from:'10',to:'9'}];
 for(const q of bad)assert.throws(()=>filter(q));
 assert.equal(csvCell('=SUM(1,2)'), '"\'=SUM(1,2)"');assert.equal(csvCell(' a,"b"\nnext'),'" a,""b""\nnext"');assert.equal(csvCell(-12),'"-12"');assert.equal(csvCell(null),'');
});
