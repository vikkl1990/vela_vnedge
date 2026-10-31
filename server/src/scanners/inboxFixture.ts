/** Local test fixture: no feed, HTTP or exchange executor. Also used by crash subprocesses. */
import { EventEmitter } from 'node:events';
import { Db } from '../db.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { PaperEngine } from '../paper/engine.ts';
import { ScannerEngine } from './engine.ts';
import type { ScanEvent } from './extractor.ts';

export function inboxFixture(file=':memory:',opts:{limit?:boolean}={}) {
  const db=new Db(file),cfg=structuredClone(DEFAULT_CONFIG);
  Object.assign(cfg.paper,{latencyMs:0,slippageBps:0,fillSource:'candles',minRiskFeeRatio:0,requireQuote:false,skipScriptStops:false,limitEntry:{...cfg.paper.limitEntry,enabled:false}});
  if(opts.limit)cfg.paper.limitEntry={enabled:true,atr:0.1,bars:4,tfs:['15m'],books:['account']};
  cfg.incubator.mirror={enabled:true,minTrades:0,minNetR:0,minTurnoverUsd:0};
  cfg.scanners.s={enabled:true,symbols:['BTCUSD'],timeframes:['15m'],pairs:[{symbol:'BTCUSD',tf:'15m'}],exitMode:'both'};
  const source={id:'s',name:'S',status:'ok',patched:'source v1'} as any;
  const bar={time:Date.now()-901_000,open:100,high:101,low:99,close:100,volume:100};
  const bars=Array.from({length:40},(_,i)=>({...bar,time:bar.time-(39-i)*900_000}));
  const market={contractValue:.01,tickSize:.01},paper=new PaperEngine(db,()=>cfg);
  const engine=new ScannerEngine({db,cfgRef:()=>cfg,paper,candles:Object.assign(new EventEmitter(),{get:()=>bars}) as any,pool:{stats:{queued:0}} as any,
    registry:{all:()=>[source],get:()=>source} as any,rest:{} as any});
  const entry:ScanEvent={kind:'entry',side:'long',price:100,sl:98,tp:[102,104,106],barTime:bar.time,barIndex:39,label:'Long',source:'alert',message:''};
  const exit:ScanEvent={...entry,kind:'exit',exitType:'tp1',price:102,label:'TP1 HIT'};
  const submit=(ev:ScanEvent=entry,copied=false):Promise<void>=>copied?engine.ingestEvent(source,'BTCUSD','15m',ev,bars,market,'both',bar):(engine as any).handleLiveEvent(source,'BTCUSD','15m',ev,bars,market,'both',bar);
  return {db,cfg,paper,engine,source,entry,exit,submit};
}
