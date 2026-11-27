import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {observeHistoricalRun, profileSignature, ProfileStore, summarizeKind} from './profile.ts';
import {sourceFacts} from './sourceFacts.ts';
import type {WorkerResult} from '../pine/worker.ts';

const s={id:'probe',patched:'indicator("Probe")\nplotshape(close > open, title="Buy Signal")'};
const res:WorkerResult={id:1,ok:true,ms:4,bars:1,lastBarTime:1000,warnings:0,alerts:[],shapes:[{title:'Buy Signal',times:[1000]}],labels:[],plots:[]};
test('profiling honors the production reading, inversion and disabled channels',()=>{
  assert.equal(observeHistoricalRun(s,{sources:['shape'],invert:true},'ETHUSD','15m',[],res,'test').events[0].side,'short');
  assert.equal(observeHistoricalRun(s,{sources:[]},'ETHUSD','15m',[],res,'test').profile.entries,0);
  assert.equal(observeHistoricalRun(s,{sources:['shape'],labels:['Other']},'ETHUSD','15m',[],res,'test').profile.entries,0);
});
test('profile identity tracks source, settings, timeframe and timezone',()=>{
  const base=profileSignature(s,{inputs:{a:1,b:2}},'15m');
  assert.equal(base,profileSignature(s,{inputs:{b:2,a:1}},'15m'));
  for(const x of [profileSignature({...s,patched:s.patched+'\nplot(close)'},{inputs:{a:1,b:2}},'15m'),profileSignature(s,{inputs:{a:2,b:2}},'15m'),profileSignature(s,{inputs:{a:1,b:2}},'1h'),profileSignature(s,{inputs:{a:1,b:2},timezone:'Asia/Kolkata'},'15m')])assert.notEqual(x,base);
});
test('profile metadata survives migration, upsert and failure replacement',()=>{
  const db=new Db(':memory:');try{
    const store=new ProfileStore(db), row=observeHistoricalRun(s,undefined,'ETHUSD','15m',[],res,'screen',123).profile;
    store.save(row);assert.deepEqual(store.forScanner(s.id),[row]);
    store.save(observeHistoricalRun(s,undefined,'ETHUSD','15m',[],{...res,ok:false,error:'timeout'},'screen',124).profile);
    assert.equal(store.all().length,1);assert.equal(store.all()[0].kind,'broken');assert.equal(store.all()[0].entries,0);
  }finally{db.db.close();}
});
test('source inventory ignores comments and strings, preserves conditions and line numbers',()=>{
  const facts=sourceFacts('// alertcondition(fake)\nindicator("plotshape(fake)")\nx=input.int(3)\nalertcondition(ta.crossover(close, ta.sma(close, x)),\n title="Buy Signal", message="go")\nrequest.security(syminfo.tickerid, "1D", close[1], lookahead=barmerge.lookahead_on)');
  assert.equal(facts.calls.length,1);assert.equal(facts.calls[0].line,4);assert.equal(facts.calls[0].title,'"Buy Signal"');
  assert.equal(facts.calls[0].condition,'ta.crossover(close, ta.sma(close, x))');assert.equal(facts.inputs,1);assert.equal(facts.dependencies.length,1);assert.equal(facts.cautions.length,2);
});

test('light summaries preserve ranking, equal-rank insertion order and timeframe counts',()=>{
 const db=new Db(':memory:');try{
  const store=new ProfileStore(db),base=observeHistoricalRun(s,undefined,'ETHUSD','15m',[],res,'test',123).profile;
  for(const row of [
   {...base,scannerId:'a',market:'ZECUSD',kind:'levels' as const},
   {...base,scannerId:'a',market:'BTCUSD',tf:'1h',kind:'exits' as const,at:456},
   {...base,scannerId:'b',market:'ZECUSD',kind:'exits' as const},
   {...base,scannerId:'b',market:'BTCUSD',kind:'levels' as const},
   {...base,scannerId:'c',kind:'silent' as const},
   {...base,scannerId:'c',market:'SOLUSD',kind:'plan' as const},
  ])store.save(row);
  const all=store.all(),expected=new Map();for(const id of ['a','b','c']){const rows=all.filter(r=>r.scannerId===id);expected.set(id,{kind:summarizeKind(rows),at:Math.max(...rows.map(r=>r.at)),tfs:new Set(rows.map(r=>r.tf)).size});}
  assert.deepEqual(store.summaries(),expected);
  assert.equal(store.summaries().get('a')!.kind,'levels');assert.equal(store.summaries().get('b')!.kind,'exits');
 }finally{db.db.close();}
});

test('allocated profile queries retain complete rows and exclude other markets and timeframes',()=>{
 const db=new Db(':memory:');try{
  const store=new ProfileStore(db),base=observeHistoricalRun(s,undefined,'ETHUSD','15m',[],res,'test',123).profile;
  for(const market of ['ETHUSD','SOLUSD','BTCUSD'])for(const tf of ['15m','1h'])store.save({...base,market,tf,labelTexts:['retained label']});
  const cells=[{symbol:'ETHUSD',tf:'15m'},{symbol:'SOLUSD',tf:'1h'},{symbol:'ETHUSD',tf:'15m'}];
  assert.deepEqual(store.forCells(s.id,cells),store.forScanner(s.id).filter(r=>cells.some(c=>c.symbol===r.market&&c.tf===r.tf)));
  assert.deepEqual(store.forCells(s.id,[]),[]);assert.deepEqual(store.forCells('missing',cells),[]);
 }finally{db.db.close();}
});
