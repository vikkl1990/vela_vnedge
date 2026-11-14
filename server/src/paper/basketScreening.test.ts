import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {ScannerEngine} from '../scanners/engine.ts';
import {ValidationService} from '../validation/service.ts';
import {App} from '../app.ts';
import {runBacktest} from './backtest.ts';
import {backtestPolicy} from './policy.ts';
import {BASKET_SCANNER} from './basket.ts';

test('basket cannot activate as an ordinary scanner or perform a candle backtest, even through direct API paths',async()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.scanners[BASKET_SCANNER]={enabled:true,symbols:['ETHUSD'],timeframes:['15m'],exitMode:'both'};
 assert.ok(validateConfig(cfg).some(e=>e.includes(`scanner ${BASKET_SCANNER}: requires an isolated basket`)));
 const s={id:BASKET_SCANNER,status:'ok'},engine={scannerConfig:()=>cfg.scanners[BASKET_SCANNER],health:{isQuarantined:()=>false}};
 assert.equal(ScannerEngine.prototype.isActive.call(engine as any,s as any),false);
 assert.throws(()=>ScannerEngine.prototype.runNow.call({} as any,BASKET_SCANNER),/stateful shadow/);
 await assert.rejects(()=>ScannerEngine.prototype.runBacktestNow.call({} as any,BASKET_SCANNER,'ETHUSD','15m'),/stateful shadow/);
 assert.throws(()=>ValidationService.prototype.jobs.call({} as any,{scanner:BASKET_SCANNER}),/stateful shadow/);
 assert.throws(()=>backtestPolicy(cfg,BASKET_SCANNER,'15m','shadow'),/stateful shadow/);
 assert.throws(()=>runBacktest({scannerId:BASKET_SCANNER} as any),/stateful shadow/);
 assert.throws(()=>runBacktest({scannerId:'plan:basket',executionPlan:{sourceScannerId:BASKET_SCANNER,basket:'rsi-volume-ladder-v1'}} as any),/stateful shadow/);
});
test('author screens retain supported scripts and explicit basket selection explains the unsupported model',()=>{
 const queued:any[]=[];
 const app={registry:{all:()=>[{id:BASKET_SCANNER,status:'ok',author:'Willy'},{id:'rsi-volume-ladder',status:'ok',author:'Willy'}]},screenQueue:{enqueue:(r:any)=>{queued.push(r);return r;}}};
 App.prototype.screenNow.call(app as any,{author:'Willy',tf:'15m'},'test');
 assert.deepEqual(queued[0].ids,['rsi-volume-ladder']);
 assert.throws(()=>App.prototype.screenNow.call(app as any,{ids:[BASKET_SCANNER]},'test'),/stateful shadow/);
 assert.equal(queued.length,1);
});
