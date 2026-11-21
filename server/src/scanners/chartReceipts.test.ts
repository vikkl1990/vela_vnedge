import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {recordChartReceipt,chartReceipt} from './chartReceipts.ts';
import {compareChart,type ChartObservation} from '../../../shared/chartVerification.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {resolveTradePolicy} from '../paper/tradePolicy.ts';
import {strategyTerms} from '../paper/strategyIdentity.ts';
const T=1800000000000;
test('receipts retain the confirmed bar, source and pre-gate signals without trading writes',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const bars=[{time:T,open:99,high:101,low:98,close:100,volume:10}];
 const result={id:1,ok:true,ms:1,bars:1,lastBarTime:T,warnings:0,alerts:[],labels:[],plots:[],shapes:[{title:'Buy',times:[T]}]};
 recordChartReceipt(db,'s','SOLUSD','15m','plotshape(true)',{sources:['shape']},bars,result,[{kind:'entry',side:'long',label:'Buy',source:'shape',tp:[],message:'',barTime:T,barIndex:0}]);
 const r=chartReceipt(db,'s','SOLUSD','15m')!;assert.equal(r.outputs.Buy.value,1);assert.equal(r.signals[0].side,'long');
 const o:ChartObservation={scannerId:'s',symbol:'SOLUSD',tf:'15m',barTime:T,sourceHash:r.sourceHash,inputs:{},historyFrom:T,inputsChanged:false,timezone:'UTC',values:{Buy:1},complete:true};
 assert.equal(compareChart(o,r).status,'Shape outputs agree; bot signals shown');
 assert.equal(compareChart({...o,values:{Buy:0}},r).status,'Closed-bar outputs differ');
 assert.equal(compareChart({...o,historyFrom:T-900000},r).comparable,false);
 for(const change of [{sourceHash:'wrong'},{inputs:{Period:20}},{inputsChanged:true},{timezone:'America/New_York'},{complete:false}])assert.equal(compareChart({...o,...change},r).comparable,false);
 assert.equal(compareChart({...o,barTime:T+900000},r).status,'Waiting for matching server bar');
 assert.equal(db.get<any>('SELECT count(*) n FROM positions')!.n,0);assert.equal(db.get<any>('SELECT count(*) n FROM signals')!.n,0);
 recordChartReceipt(db,'s','SOLUSD','15m','alert("Buy")\nplotshape(true)',{sources:['shape']},bars,result,[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.signalCoverage,'outputs-only');
 recordChartReceipt(db,'s','SOLUSD','15m','old',{sources:['shape']},[{...bars[0],time:T-900000}],result,[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.barTime,T,'catch-up must not replace a newer receipt');
 recordChartReceipt(db,'s','SOLUSD','15m','duplicate',{sources:['shape']},bars,{...result,shapes:[...result.shapes,...result.shapes]},[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.truncated,true,'ambiguous titles cannot certify parity');
});
test('new lifecycle identities affect only partial targets or enabled early/stale exits',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.tpSplit=[0,0,1];cfg.paper.earlyCut=undefined;cfg.paper.staleBars=0;
 const cell={scannerId:'s',symbol:'SOLUSD',tf:'15m'};
 const original=resolveTradePolicy(cfg,cell,'hash');assert.equal(original.causalLifecycleVersion,undefined);
 assert.ok(!('causalLifecycleVersion' in strategyTerms(original)));
 for(const patch of [{earlyCut:{minutes:10,r:-.5}},{staleBars:2},{tpSplit:[.5,.25,.25] as [number,number,number]}]){
  const changed=structuredClone(cfg);Object.assign(changed.paper,patch);const p=resolveTradePolicy(changed,cell,'hash');
  assert.equal(p.causalLifecycleVersion,1);assert.notEqual(p.strategyId,original.strategyId);assert.deepEqual(p.risk,original.risk);
 }
 assert.equal(resolveTradePolicy(cfg,cell,'hash').id,original.id);
});
