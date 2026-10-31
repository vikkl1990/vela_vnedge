import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {observeHistoricalRun, profileSignature, ProfileStore} from './profile.ts';
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
