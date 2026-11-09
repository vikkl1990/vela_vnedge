import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {PaperEngine} from '../paper/engine.ts';
import {ScannerEngine} from './engine.ts';

for(const latencyMs of [0,1500])test(`uncapped pilot admissions retain reduced size and the account cap (${latencyMs?'pending':'filled'})`,async t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 cfg.incubator.mirror={enabled:true,pilot:{sizeScale:1/3,maxOpenPositions:0,maxDailyEntries:0}};
 Object.assign(cfg.paper,{latencyMs,requireQuote:false,useSpread:false,minRiskFeeRatio:0,skipScriptStops:false,sizingMode:'margin',marginPerTrade:150,maxOpenPositions:8,maxStopLossPct:3,marginLeverage:{base:5,strong:5,weak:5,strongAboveR:.05,weakBelowR:-.05,minTrades:20,lookback:30},trendGate:{enabled:false,emaLen:50,tf:'',mode:'follow'}});
 cfg.risk.regime.enabled=false;
 const lastClose=Math.floor(Date.now()/60000)*60000;
 const bars=Array.from({length:60},(_,i)=>({time:lastClose-(60-i)*60000,open:100,high:101,low:99,close:100,volume:100}));
 const paper=new PaperEngine(db,()=>cfg),scanner={id:'shadow-only',name:'Shadow only',status:'ok',patched:''};
 const engine=new ScannerEngine({db,cfgRef:()=>cfg,paper,candles:Object.assign(new EventEmitter(),{get:()=>bars})as any,pool:{}as any,registry:{all:()=>[scanner],get:()=>scanner}as any,rest:{}as any});
 t.after(()=>engine.stop());
 db.kvSet('incubator.copyPilot',{day:Math.floor(Date.now()/86400000),entries:10});
 const ev={kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],barTime:bars.at(-1)!.time,barIndex:59,source:'alert',label:'LONG',message:'long'}as any;
 const enter=async(symbol:string)=>{paper.setMark(symbol,100);await engine.ingestEvent(scanner as any,symbol,'1m',ev,bars,{contractValue:1,tickSize:.01},'both',bars.at(-1)!);};
 // The unchanged paper gate must still refuse a signal even though both pilot caps are disabled.
 paper.risk={gate:()=>({reject:'manual halt',leverageMult:1}),exposureCheck:()=>null};
 await enter('HALTUSD');assert.match(db.get<any>("SELECT action FROM signals WHERE symbol='HALTUSD'")!.action,/manual halt/);
 assert.equal(db.kvGet<any>('incubator.copyPilot')!.entries,10);
 paper.risk={gate:()=>({leverageMult:1}),exposureCheck:()=>null};
 for(let i=0;i<9;i++)await enter(`PAIR${i}USD`);
 const held=[...paper.openPositions(),...paper.pendingEntries()];assert.equal(held.length,8);
 assert.match(db.get<any>("SELECT action FROM signals WHERE symbol='PAIR8USD'")!.action,/max open positions \(8\)/);
 assert.equal(db.kvGet<any>('incubator.copyPilot')!.entries,18,'entries continue beyond ten without resetting the counter');
 for(const p of held){
  assert.equal(p.features?.copy_pilot,1);
  const qty='qty' in p?p.qty:p.reservation!.qty;assert.equal(qty,2,'floor(7 normal contracts / 3) stays unchanged');
  const risk='riskAmount' in p?p.riskAmount:p.reservation!.riskAmount;assert.ok(risk<10,'reduced stop risk remains below 1% of starting equity');
 }
});
