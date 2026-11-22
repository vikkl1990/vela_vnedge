import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {MarkStore} from '../data/marks.ts';
import {PaperEngine} from '../paper/engine.ts';
import {EntryDepthGate,wireEntryDepth} from './entryDepth.ts';

function fixture(t:any){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG),marks=new MarkStore();
 let now=1794848400000;
 Object.assign(cfg.paper,{useSpread:true,requireQuote:true,quoteMaxAgeMs:10000,skipScriptStops:false,latencyMs:0,
  initialEquity:1000,slippageBps:0,minRiskFeeRatio:6,maxSignalAgeSec:0,sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,
  limitEntry:{enabled:false,atr:.1,bars:2,tfs:[],books:[]}});
 cfg.risk.marketGate={...cfg.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 let raw:any={timestamp:now*1000,buy:[{price:99.99,size:100}],sell:[{price:100.01,size:100}]};
 const quotes:any[]=[];
 const gate=new EntryDepthGate({cfg:()=>cfg,now:()=>now,book:async()=>raw,quote:q=>{
  quotes.push(q);marks.setQuotes(q.symbol,q.bid,q.ask,q.receivedAt,q.exchangeAt,'rest_depth',
   {bidSize:q.bidSize,askSize:q.askSize,bookAt:q.exchangeAt});
 }});
 const paper=new PaperEngine(db,()=>cfg,{now:()=>now}),shadow=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});
 paper.quotes=shadow.quotes=marks;wireEntryDepth(paper,shadow,gate);
 const ev={kind:'entry',side:'long',price:100,sl:95,tp:[110,120,130],barTime:now-60000,barIndex:1,source:'alert',label:'Long',message:''} as const;
 const ctx={scannerId:'s',scannerName:'S',symbol:'BTCUSD',tf:'1m',market:{contractValue:1,tickSize:.01},at:now,refPrice:100,atr:2,exitMode:'both' as const,signalId:null};
 return {cfg,db,marks,paper,shadow,gate,quotes,ev,ctx,now:()=>now,advance:(ms:number)=>now+=ms,raw:(v:any)=>raw=v};
}

test('fresh validated REST depth supplies a missing executable quote without weakening admission',async t=>{
 const x=fixture(t);assert.equal(x.marks.executable('BTCUSD','buy',10000,x.now()),null);
 await x.paper.prepareEntryDepth!('BTCUSD');
 assert.equal(x.marks.executable('BTCUSD','buy',10000,x.now()),100.01);
 assert.equal(x.marks.markState('BTCUSD')!.quoteSource,'rest_depth');
 const d=x.paper.onEntry(x.ev as any,x.ctx);assert.equal(d.action,'opened');
 assert.equal(d.position!.entryPrice,100.01);assert.ok(d.position!.riskAmount<=30);
 assert.equal(x.db.get<any>("SELECT price_source FROM orders WHERE reason='entry'").price_source,'depth');
 x.advance(10001);assert.equal(x.marks.executable('BTCUSD','buy',10000,x.now()),null);
});

for(const kind of ['stale','future','missing-time','empty','crossed','malformed'] as const)test(`REST ${kind} depth cannot create an executable quote`,async t=>{
 const x=fixture(t),now=x.now();
 const raw:any={timestamp:now*1000,buy:[{price:99.99,size:100}],sell:[{price:100.01,size:100}]};
 if(kind==='stale')raw.timestamp=(now-10001)*1000;
 if(kind==='future')raw.timestamp=(now+2001)*1000;
 if(kind==='missing-time')delete raw.timestamp;
 if(kind==='empty')raw.buy=[];
 if(kind==='crossed')raw.buy[0].price=101;
 if(kind==='malformed')raw.sell[0].size='NaN';
 x.raw(raw);await x.paper.prepareEntryDepth!('BTCUSD');
 assert.equal(x.quotes.length,0);assert.equal(x.paper.onEntry(x.ev as any,x.ctx).action,'rejected');
});

test('REST quotes do not replace a healthy L1 quote or bypass costly depth and risk caps',async t=>{
 const x=fixture(t);x.marks.setQuotes('BTCUSD',99.98,100.02,x.now(),x.now(),'ob_l1');
 await x.paper.prepareEntryDepth!('BTCUSD');assert.equal(x.marks.markState('BTCUSD')!.quoteSource,'ob_l1');
 const expensive=fixture(t);expensive.raw({timestamp:expensive.now()*1000,buy:[{price:99,size:100}],sell:[{price:101,size:100}]});
 await expensive.paper.prepareEntryDepth!('BTCUSD');assert.equal(expensive.paper.onEntry(expensive.ev as any,expensive.ctx).action,'rejected');
 x.paper.risk={gate:()=>({reject:'daily loss limit',leverageMult:1}),exposureCheck:()=>null};
 const d=x.paper.onEntry(x.ev as any,x.ctx);assert.equal(d.action,'rejected');assert.match(d.reason!,/daily loss limit/);
});
