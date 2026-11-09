import {scannerPairs} from './allocation.ts';
import type {Db} from '../db.ts';
import {TF_SECONDS,type AppConfig} from '../config.ts';
import type {CandleStore} from '../data/candleStore.ts';
import type {PaperEngine} from '../paper/engine.ts';
import type {Position} from '../paper/logic.ts';
import type {PinePool} from '../pine/pool.ts';
import type {ScannerRegistry} from './registry.ts';
import {policyReading,stablePolicy,type TradePolicy} from '../paper/tradePolicy.ts';
import {sourceHash} from '../paper/fingerprint.ts';
import {readingOf} from './reading.ts';
import {applyRules,labelKey} from './rules.ts';
import {extractEvents} from './extractor.ts';

export function sameExitSource(policy:TradePolicy|undefined,source:string|null,reading:unknown):boolean {
  return !policy?.sourceHash || (policy.sourceHash===source && stablePolicy(policy.reading)===stablePolicy(reading));
}

/** Only changed/disabled scanners need an extra run. Existing trades retain their old
 * script exits; tape stops and targets continue independently, even when this job fails. */
export class BoundExits {
  private busy=new Set<string>();private stopped=false;
  constructor(privateDeps:{db:Db;books:PaperEngine[];cfg:()=>AppConfig;registry:ScannerRegistry;candles:CandleStore;pool:PinePool;marketInfo:(symbol:string)=>Promise<{tickSize:number}>}){this.d=privateDeps;}
  private d:{db:Db;books:PaperEngine[];cfg:()=>AppConfig;registry:ScannerRegistry;candles:CandleStore;pool:PinePool;marketInfo:(symbol:string)=>Promise<{tickSize:number}>};
  private needed(p:Position,book:PaperEngine){
    if(!p.policy?.sourceHash||p.policy.exitMode==='levels')return false;
    const s=this.d.registry.get(p.scannerId),sc=this.d.cfg().scanners[p.scannerId];
    const allocated=book.book===2 || !!sc?.enabled&&!sc.hidden&&scannerPairs(sc,this.d.cfg().timeframes).some(c=>c.symbol===p.symbol&&c.tf===p.tf);
    return !allocated||!sameExitSource(p.policy,s?sourceHash(s.patched):null,policyReading(sc));
  }
  async run(symbol:string,tf:string){
    for(const book of this.d.books)for(const p of book.openPositions()){
      if(this.stopped||p.symbol!==symbol||p.tf!==tf||!this.needed(p,book))continue;
      const key=`bound-exit:${book.book}:${p.id}:${p.entryAt}`;if(this.busy.has(key))continue;
      this.busy.add(key);
      try{await this.one(book,p,key);}catch(e){this.d.db.kvSet(`${key}:error`,{at:Date.now(),message:String((e as Error).message??e)});}
      finally{this.busy.delete(key);}
    }
  }
  private async one(book:PaperEngine,p:Position,key:string){
    const policy=p.policy!,barMs=(TF_SECONDS[p.tf]??0)*1000;
    const bars=this.d.candles.get(p.symbol,p.tf,{closedOnly:true,limit:this.d.cfg().historyBars});
    const last=bars.at(-1);if(!last||bars.length<50||!barMs)return;
    const saved=this.d.db.kvGet<{bar:number;labels:string[]}>(key);
    if(saved&&saved.bar>=last.time)return;
    const since=Math.max(saved?saved.bar+barMs:Math.floor(p.entryAt/barMs)*barMs,bars[0].time);
    const source=this.d.db.get<{source:string}>('SELECT source FROM scanner_source_versions WHERE hash=?',policy.sourceHash)?.source;
    if(!source)throw Error('bound scanner source missing; price protection remains active');
    const reading=readingOf(policy.reading,p.scannerId,barMs,source,this.d.registry.get(p.scannerId)?.variantOf);
    const result=await this.d.pool.run({scannerId:p.scannerId,source,symbol:p.symbol,tf:p.tf,tickSize:(await this.d.marketInfo(p.symbol)).tickSize,
      bars,tailBars:'all',plotTail:bars.length,inputs:policy.reading.inputs,timezone:policy.reading.timezone},{priority:'live'});
    if(!result.ok)throw Error(result.error??'bound scanner failed');
    if(this.stopped||book.position(p.id)?.status!=='open')return;
    const old=new Set(saved?.labels??[]),fresh=new Set(result.labels.map(labelKey).filter(k=>!old.has(k)));
    const derived=applyRules({scannerId:p.scannerId,...result,bars,mode:'live',newLabelKeys:fresh,...reading.rule});
    const exits=extractEvents(result.alerts,result.shapes,{drawn:result.labels,derived,sinceBarTime:since,...reading.extract})
      .filter(e=>e.kind==='exit'&&e.barTime+barMs>p.entryAt&&e.barTime<=last.time);
    book.commitDecision(()=>{
      for(const e of exits)book.onScriptExit(p.scannerId,p.symbol,p.tf,e.exitType??'close',undefined,Date.now(),policy.exitMode,e.side,{positionId:p.id,pendingIds:[]});
      this.d.db.kvSet(key,{bar:last.time,labels:result.labels.map(labelKey)});
      this.d.db.kvSet(`${key}:error`,null);
    });
  }
  status(){
    const held=this.d.books.flatMap(book=>book.openPositions().filter(p=>this.needed(p,book)).map(p=>({book:book.book,id:p.id,scannerId:p.scannerId,symbol:p.symbol,tf:p.tf,
      error:this.d.db.kvGet<{at:number;message:string}>(`bound-exit:${book.book}:${p.id}:${p.entryAt}:error`)??null})));
    return {held,failures:held.filter(p=>p.error).length};
  }
  stop(){this.stopped=true;}
}
