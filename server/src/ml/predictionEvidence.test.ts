import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {PredictionEvidence} from './predictionEvidence.ts';
import {MlService} from './service.ts';
test('prospective prediction proof rejects missing models, future labels, wrong policies and altered features',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const audit=new PredictionEvidence(db);
 const model=audit.saveModel({weights:[1]},100,90),f={score:.2} as any;
 const add=(id:number,opts:any={})=>{
  const receipt=audit.record('s',f,.6,'scanner:15m',opts.model===undefined?model:opts.model,{symbol:'INITUSD',tf:'15m',book:2,startedAt:110},120);
  db.run("INSERT INTO positions(id,status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,bt,policy_id,fills) VALUES (?,'closed','s','S','INITUSD','15m','long',1,0,1,100,110,200,2,?,?)",id,opts.policy??'policy',JSON.stringify({features:opts.features??f,mlProb:.6}));
  audit.bind(receipt,2,id,'policy',opts.decisionAt??130);
 };
 add(1);add(2,{model:null});add(3,{model:audit.saveModel({},100,150)});add(4,{policy:'changed'});add(5,{features:{score:.9}});add(6,{decisionAt:119});
 assert.deepEqual([...audit.verified(0)],[1]);
 // Restart keeps the receipt and never replaces its original decision binding.
 const again=new PredictionEvidence(db);again.bind('different',2,1,'changed',999);assert.deepEqual([...again.verified(0)],[1]);
});
test('model receipts preserve scoring and survive restart; legacy models cannot invent a cutoff',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const db=new Db(':memory:');t.after(()=>db.db.close());const ml=new MlService(db,()=>({}));
 for(let i=0;i<100;i++)ml.addLiveSample('s','INITUSD','15m',i*1000,{} as any,i%2===0,i%2?1:-1,0,'sl',i*1000+1);
 ml.addLiveSample('future','INITUSD','15m',1,{} as any,true,1,0,'sl',Date.now()+86400000);
 assert.equal(ml.train().samples,100);const before=ml.score('s',{} as any,{tf:'15m',record:false});
 const scored=ml.scoreEntry('s',{} as any,{symbol:'INITUSD',tf:'15m',book:2,startedAt:Date.now()},false)!;
 assert.equal(scored.prob,before!.prob);const row=db.get<any>('SELECT * FROM ml_entry_predictions WHERE id=?',scored.receiptId)!;assert.ok(row.model_id);
 const again=new MlService(db,()=>({}));assert.deepEqual(again.score('s',{} as any,{tf:'15m',record:false}),before);
 const saved=db.kvGet<any>('ml.model');delete saved.evidence;db.kvSet('ml.model',saved);
 const legacy=new MlService(db,()=>({})).scoreEntry('s',{} as any,{symbol:'INITUSD',tf:'15m',book:2,startedAt:Date.now()},false)!;
 assert.equal(db.get<any>('SELECT model_id FROM ml_entry_predictions WHERE id=?',legacy.receiptId)!.model_id,null);
});
