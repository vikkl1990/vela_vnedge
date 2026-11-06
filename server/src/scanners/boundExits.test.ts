import test from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {sourceHash} from '../paper/fingerprint.ts';
import {BoundExits,sameExitSource} from './boundExits.ts';
import {policyReading} from '../paper/tradePolicy.ts';
test('changed scanner exits use archived source and stop on the target position exactly once',async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{fillSource:'candles',latencyMs:0,minRiskFeeRatio:0,requireQuote:false,skipScriptStops:false,limitEntry:undefined});
 cfg.scanners.s={enabled:true,symbols:['BTCUSD'],timeframes:['1h'],exitMode:'both'};
 const old='//@version=5\nindicator("old")',current='//@version=5\nindicator("new")';
 const paper=new PaperEngine(db,()=>cfg);paper.sourceCodeFor=()=>old;paper.sourceHashFor=()=>sourceHash(old);
 const at=Date.now()-3600000;
 const p=paper.onEntry({kind:'entry',side:'long',price:100,sl:99,tp:[101,102,103],barTime:at-3600000,barIndex:0,label:'long',message:'',source:'alert'},
  {scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1h',market:{tickSize:.01,contractValue:1},refPrice:100,at,signalId:null,exitMode:'both'}).position!;
 assert.ok(p);assert.equal(sameExitSource(p.policy,sourceHash(current),policyReading(cfg.scanners.s)),false);
 let runs=0;const bars=Array.from({length:60},(_,i)=>({time:at-(59-i)*3600000,open:100,high:101,low:99,close:100,volume:1}));
 const deps={db,books:[paper],cfg:()=>cfg,registry:{get:()=>({patched:current})} as any,candles:{get:()=>bars} as any,marketInfo:async()=>({tickSize:.01}),pool:{run:async(job:any)=>{
   runs++;if(runs===1)return {ok:false,error:'worker unavailable'};assert.equal(job.source,old);assert.equal(job.tickSize,.01);
   return {ok:true,alerts:[{barIndex:59,time:at,type:'alert',title:'strategy',message:'STRATEGY exit long @ 100'}],shapes:[],labels:[],plots:[]};
 }} as any};
 const runner=new BoundExits(deps);await runner.run('BTCUSD','1h');
 assert.equal(paper.openPositions().length,1);assert.equal(runner.status().failures,1);
 await runner.run('BTCUSD','1h');
 assert.equal(paper.trades().length,1);assert.equal(paper.trades()[0].exitReason,'script_exit');
 await new BoundExits(deps).run('BTCUSD','1h');assert.equal(runs,2);
});
