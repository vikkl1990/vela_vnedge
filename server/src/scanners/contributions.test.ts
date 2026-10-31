import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {ContributionService} from './contributions.ts';
import {ProfileStore,observeHistoricalRun} from './profile.ts';
import {recordScreen,screenVerdict} from '../incubator/cycle.ts';

test('ledger separates source evidence, matching profiles, pending orders, tracker history and allocation',async()=>{
 const db=new Db(':memory:');try{
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.scanners={s:{enabled:true,symbols:['ETHUSD'],timeframes:['15m']},context:{enabled:false,symbols:null,timeframes:null,sources:[]}};
  const base={id:'s',name:'Scanner',author:'LuxAlgo',patched:'indicator("s")\nplotshape(close > open, title="Buy Signal")',source:'',status:'ok',reason:null};
  const other={...base,id:'context',name:'Context',author:'ChartPrime',patched:'indicator("context")\nplot(close)'};
  const registry={all:()=>[base,other],get:(id:string)=>[base,other].find(s=>s.id===id)};
  const profiles=new ProfileStore(db),store=new IncubatorStore(db),now=1_000_000_000;
  const p=observeHistoricalRun(base,cfg.scanners.s,'ETHUSD','15m',[],{id:1,ok:true,ms:2,warnings:0,alerts:[],shapes:[{title:'Buy Signal',times:[1000]}],labels:[],plots:[]},'test',now-1).profile;
  profiles.save(p);profiles.save({...p,market:'BTCUSD',signature:null});profiles.save({...p,market:'SOLUSD',signature:'changed'});
  store.move({scannerId:'s',symbol:'ETHUSD',tf:'15m'},'shadow','test');store.move({scannerId:'s',symbol:'BTCUSD',tf:'15m'},'tracked','test');
  store.setShadowFunnel({'s|ETHUSD|15m':[[now-1,'pending','pending:limit'],[now-2,'opened','opened']],'s|BTCUSD|15m':[[now-1,'opened','opened']]});
  for(const [i,action] of ['pending:limit','opened','rejected:stop too tight'].entries())db.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,label,message,source,action) VALUES(?,?,'s','Scanner','ETHUSD','15m','entry',?,'','shape',?)",now-10-i,now-i,String(i),action);
  const service=new ContributionService({db,registry,config:{get:()=>cfg},profiles,incubatorStore:store,scanners:{isActive:(s:any)=>s.id==='s',pairsFor:()=>[{symbol:'ETHUSD',tf:'15m'}]}} as any);
  const view=await service.view(now),row=view.rows.find(r=>r.id==='s')!;
  assert.equal(row.profiles.matching,1);assert.equal(row.profiles.legacy,1);assert.equal(row.profiles.changed,1);assert.equal(row.role,'signal');
  assert.equal(row.paper.opened,1);assert.equal(row.paper.pending,1);assert.equal(row.paper.blocked,1);assert.equal(row.shadow.signals,2);assert.equal(row.cells.paper,1);assert.equal(row.cells.tracked,1);
  assert.equal(view.rows.find(r=>r.id==='context')!.role,'context / entries disabled');assert.equal(service.detail('s')!.profiles.length,3);
  assert.equal(view.authors.find(a=>a.author==='LuxAlgo')!.matching,1);
  assert.equal(view.summary.unverified,1);
  cfg.scanners.context.hidden=true;
  const refreshed=await service.view(now+61_000);
  assert.equal(refreshed.summary.unverified,0);assert.equal(refreshed.summary.hidden,1);
  assert.equal(refreshed.rows.find(r=>r.id==='context')!.next,'Archived: review before restoring');
 }finally{db.db.close();}
});
test('a completed no-entry re-screen replaces stale passing eligibility without creating silent candidates',()=>{
 const db=new Db(':memory:');try{
  const store=new IncubatorStore(db),cfg=structuredClone(DEFAULT_CONFIG),key={scannerId:'s',symbol:'ETHUSD',tf:'15m'},now=1_000_000_000;
  store.move(key,'candidate','test');store.setScreen(store.find('s','ETHUSD','15m')!.id,{at:now-1,pass:true});
  const bars=Array.from({length:800},(_,i)=>({time:now+i*900_000,open:100,high:101,low:99,close:100,volume:10}));
  const empty=screenVerdict([],[],bars,cfg.incubator,now,0);recordScreen(store,key,empty,cfg.incubator,now);
  assert.equal(store.find('s','ETHUSD','15m')!.screen.pass,false);
  recordScreen(store,{...key,symbol:'BTCUSD'},empty,cfg.incubator,now);assert.equal(store.find('s','BTCUSD','15m'),null);
 }finally{db.db.close();}
});
