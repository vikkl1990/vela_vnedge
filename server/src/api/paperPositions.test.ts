import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {App} from '../app.ts';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {paperPositionViews} from './paperPositions.ts';

for(const source of ['copy','own',undefined] as const)test(`position stream and HTTP retain ${source??'unknown'} admission origin after stop updates`,t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:0,maxStopLossPct:0,maxSignalAgeSec:0,useSpread:false,requireQuote:false,skipScriptStops:false,minRiskFeeRatio:0});
 const paper=new PaperEngine(db,()=>cfg);
 const views=paperPositionViews({db,paper,marks:{mark:()=>101}} as unknown as App);
 const stream:ReturnType<typeof views.one>[]=[];
 paper.on('position',e=>stream.push(views.one(e.position)));
 const ev={kind:'entry',side:'long',price:100,sl:95,tp:[110,120,130],label:'entry',message:'',source:'alert',barTime:0,barIndex:0} as const;
 const result=paper.commitDecision(()=>paper.onEntry({...ev,tp:[...ev.tp]},{scannerId:'s',scannerName:'S',symbol:'BTCUSD',tf:'1m',market:{tickSize:.01,contractValue:1},refPrice:100,at:1000,signalId:null,exitMode:'both',entryOrigin:source,sizeScale:source==='copy'?1/3:1}));
 assert.equal(result.action,'opened');const p=result.position!;
 assert.equal(stream.length,1,'first-fill payload reads the committed receipt');
 assert.equal(stream[0].fleetSource,source??'unknown');assert.equal(stream[0].entrySizeScale,source?(source==='copy'?1/3:1):null);
 assert.deepEqual(views.all()[0],stream[0]);
 // Today's allocation and requested copy scale cannot reclassify a held trade.
 cfg.scanners.s={enabled:true,hidden:false,pairs:[{symbol:'BTCUSD',tf:'1m'}],symbols:null,timeframes:null,exitMode:'both'};
 cfg.incubator.mirror={enabled:true,minTrades:5,minNetR:0,pilot:{sizeScale:.5,maxDailyEntries:10,maxOpenPositions:10}};
 p.sl=99;
 const before=db.get<{n:number}>('SELECT total_changes() n')!.n;
 paper.emit('position',{type:'updated',position:p});
 assert.equal(stream[1].sl,99);assert.equal(stream[1].fleetSource,stream[0].fleetSource);assert.equal(stream[1].entrySizeScale,stream[0].entrySizeScale);
 assert.deepEqual(views.all()[0],stream[1]);
 assert.equal(db.get<{n:number}>('SELECT total_changes() n')!.n,before,'transport reads do not alter trading or evidence');
});
