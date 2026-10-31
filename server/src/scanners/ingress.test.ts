import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {ScannerEngine} from './engine.ts';

for(const copiedFirst of [true,false])test(`direct and copied source events act once, copied first=${copiedFirst}`,async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const c=structuredClone(DEFAULT_CONFIG);
 Object.assign(c.paper,{latencyMs:0,slippageBps:0,fillSource:'candles',minRiskFeeRatio:0,requireQuote:false,skipScriptStops:false});
 c.incubator.mirror={enabled:true,minTrades:0,minNetR:0,minTurnoverUsd:0};
 c.scanners.s={enabled:true,symbols:['BTCUSD'],timeframes:['15m'],pairs:[{symbol:'BTCUSD',tf:'15m'}],exitMode:'both'};
 const paper=new PaperEngine(db,()=>c),bar={time:Date.now()-900000,open:100,high:101,low:99,close:100,volume:100},bars=Array.from({length:40},(_,i)=>({...bar,time:bar.time-(39-i)*900000}));
 const source={id:'s',name:'S',status:'ok',patched:''} as any,market={contractValue:.01,tickSize:.01};
 const engine=new ScannerEngine({db,cfgRef:()=>c,paper,candles:Object.assign(new EventEmitter(),{get:()=>bars}) as any,pool:{stats:{queued:0}} as any,registry:{all:()=>[source]} as any,rest:{} as any});
 const entry={kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],barTime:bar.time,barIndex:39,label:'Long',source:'alert',message:''} as any;
 const submit=(ev:any,copied:boolean)=>copied?engine.ingestEvent(source,'BTCUSD','15m',ev,bars,market,'both',bar):(engine as any).handleLiveEvent(source,'BTCUSD','15m',ev,bars,market,'both',bar);
 // Both producers can resume after the same asynchronous depth request.
 paper.prepareEntryDepth=async()=>{await Promise.resolve();};
 await Promise.all([submit(entry,copiedFirst),submit(entry,!copiedFirst)]);
 assert.equal(db.countSignals('s'),1);assert.equal(paper.openPositions().length,1);
 const pos=paper.openPositions()[0],qty=pos.qty;
 const exit={...entry,kind:'exit',exitType:'tp1',price:102,label:'TP1 HIT'};
 await submit(exit,copiedFirst);const remaining=pos.qtyOpen;assert.ok(remaining<qty&&remaining>0);
 await submit(exit,!copiedFirst);assert.equal(pos.qtyOpen,remaining);assert.equal(db.countSignals('s'),2);
 // Re-delivery after clearing producer memory still consults the persisted journal identity.
 await submit(exit,copiedFirst);assert.equal(pos.qtyOpen,remaining);
});
