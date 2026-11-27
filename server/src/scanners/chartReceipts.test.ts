import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {recordChartReceipt,chartReceipt,chartReadingHash,chartWindow} from './chartReceipts.ts';
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
 const o:ChartObservation={scannerId:'s',symbol:'SOLUSD',tf:'15m',barTime:T,sourceHash:r.sourceHash,inputs:{},historyFrom:T,historyHash:r.historyHash,historyBars:1,inputsChanged:false,timezone:'UTC',values:{Buy:1},complete:true};
 assert.equal(compareChart(o,r).status,'Shape outputs agree; bot signals shown');
 assert.equal(compareChart({...o,values:{Buy:0}},r).status,'Closed-bar outputs differ');
 assert.equal(compareChart({...o,historyFrom:T-900000},r).comparable,false);
 for(const change of [{sourceHash:'wrong'},{inputs:{Period:20}},{inputsChanged:true},{timezone:'America/New_York'},{complete:false}])assert.equal(compareChart({...o,...change},r).comparable,false);
 assert.equal(compareChart({...o,historyHash:'different'},r).status,'Candle data differs; outputs not comparable');
 assert.equal(compareChart({...o,historyHash:undefined},r).comparable,false);
 assert.equal(compareChart({...o,valuesTruncated:true},r).comparable,false);
 assert.equal(compareChart({...o,historyFrom:T-900000,values:{Buy:0}},r).status,'History windows differ; outputs not comparable');
 assert.equal(compareChart({...o,barTime:T+900000},r).status,'Waiting for matching server bar');
 assert.equal(db.get<any>('SELECT count(*) n FROM positions')!.n,0);assert.equal(db.get<any>('SELECT count(*) n FROM signals')!.n,0);
 recordChartReceipt(db,'s','SOLUSD','15m','alert("Buy")\nplotshape(true)',{sources:['shape']},bars,result,[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.signalCoverage,'outputs-only');
 recordChartReceipt(db,'s','SOLUSD','15m','old',{sources:['shape']},[{...bars[0],time:T-900000}],result,[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.barTime,T,'catch-up must not replace a newer receipt');
 recordChartReceipt(db,'s','SOLUSD','15m','duplicate',{sources:['shape']},bars,{...result,shapes:[...result.shapes,...result.shapes]},[]);
 assert.equal(chartReceipt(db,'s','SOLUSD','15m')!.truncated,true,'ambiguous titles cannot certify parity');
 recordChartReceipt(db,'s','SOLUSD','15m','duplicate',{sources:['shape']},bars,{...result,shapes:[{title:'Buy',key:'Buy',times:[T]},{title:'Buy',key:'Buyplotshape#1',times:[]}]},[]);
 const keyed=chartReceipt(db,'s','SOLUSD','15m')!;assert.equal(keyed.truncated,false);assert.equal(keyed.outputs['Buyplotshape#1'].value,0);
 assert.equal(compareChart({...o,sourceHash:keyed.sourceHash,values:{Buy:1,'Buyplotshape#1':1}},keyed).differences[0],'Buyplotshape#1');
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

test('closed alert and label receipts detect missing, extra and changed outputs without creating trades',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const bars=[{time:T,open:99,high:101,low:98,close:100,volume:10}];
 const alerts=[{barIndex:0,time:T,type:'alertcondition' as const,title:'Long',message:'confirmed'}];
 const labels=[{time:T,y:101,text:'Buy',style:'label_up',createdAt:T}];
 const result={id:1,ok:true,ms:1,bars:1,lastBarTime:T,warnings:0,alerts,labels,plots:[],shapes:[],signalMetadata:'metadata-v1'};
 recordChartReceipt(db,'s','SOLUSD','15m','alertcondition(true)\nlabel.new(0,close)',{},bars,result,[]);
 const receipt=chartReceipt(db,'s','SOLUSD','15m')!;
 const o:ChartObservation={scannerId:'s',symbol:'SOLUSD',tf:'15m',barTime:T,sourceHash:receipt.sourceHash,inputs:{},historyFrom:T,historyHash:receipt.historyHash,historyBars:1,inputsChanged:false,timezone:'UTC',values:{},complete:true,readingHash:receipt.readingHash,signalMetadata:receipt.signalMetadata,channels:structuredClone(receipt.channels)};
 assert.equal(compareChart(o,receipt).status,'Closed-bar plots, alerts and labels agree; bot signals shown');
 assert.equal(compareChart({...o,signalMetadata:'other'},receipt).comparable,false);
 assert.ok(compareChart({...o,channels:{...o.channels!,alerts:[]}},receipt).differences.includes('alert payloads'));
 assert.ok(compareChart({...o,channels:{...o.channels!,labels:[]}},receipt).differences.includes('label state'));
 for(const patch of [{truncated:true},{unavailable:'Verification unavailable'},{labelsVerified:false}])assert.equal(compareChart({...o,channels:{...o.channels!,...patch}},receipt).comparable,false);
 assert.equal(compareChart(o,{...receipt,channels:undefined}).comparable,false);
 assert.equal(db.get<any>('SELECT count(*) n FROM positions')!.n,0);
 assert.equal(db.get<any>('SELECT count(*) n FROM signals')!.n,0);
});


test('chart reading identity follows interpretation changes while allocations retain their identity',()=>{
 const initial=chartReadingHash('s',{reader:2,sides:{Buy:'long'}});
 assert.equal(chartReadingHash('s',{reader:2,sides:{Buy:'long'},enabled:true,symbols:['ETHUSD']}),initial);
 assert.notEqual(chartReadingHash('s',{reader:2,sides:{Buy:'short'}}),initial);
 assert.notEqual(chartReadingHash('other',{reader:2,sides:{Buy:'long'}}),initial);
});


test('chart windows retain exactly the scanner inputs without refetch, mutation or fabricated restart recovery',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const bars=[{time:T,open:99,high:101,low:98,close:100,volume:10}];
 const result={id:1,ok:true,ms:1,bars:1,lastBarTime:T,warnings:0,alerts:[],labels:[],plots:[],shapes:[]};
 recordChartReceipt(db,'s','SOLUSD','15m','source',{},bars,result,[]);
 bars[0].close=999;
 const window=chartWindow(db,'s','SOLUSD','15m',T)!;assert.equal(window.bars[0].close,100);
 window.bars[0].close=888;assert.equal(chartWindow(db,'s','SOLUSD','15m',T)!.bars[0].close,100);
 assert.equal(chartWindow(db,'s','SOLUSD','15m',T-900000),null);
 const cold=new Db(':memory:');t.after(()=>cold.db.close());
 const receipt=chartReceipt(db,'s','SOLUSD','15m')!;
 chartReceipt(cold,'s','SOLUSD','15m');cold.run('INSERT INTO chart_signal_receipts VALUES(?,?,?,?,?)','s','SOLUSD','15m',T,JSON.stringify(receipt));
 assert.equal(chartWindow(cold,'s','SOLUSD','15m',T),null);
 assert.equal(db.get<any>('SELECT count(*) n FROM positions')!.n,0);
});
