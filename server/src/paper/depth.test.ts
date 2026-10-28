import{test}from'node:test';import assert from'node:assert/strict';import{Db}from'../db.ts';import{DEFAULT_CONFIG}from'../config.ts';import{PaperEngine}from'./engine.ts';
function setup(t:any){const db=new Db(':memory:');t.after(()=>db.db.close());const c=structuredClone(DEFAULT_CONFIG);Object.assign(c.paper,{slippageBps:0,feeRatePct:0,makerFeeRatePct:0,liquidation:false,latencyMs:0,maxStopLossPct:0,maxSignalAgeSec:0,useSpread:false,requireQuote:false,skipScriptStops:false,minRiskFeeRatio:0,sizingMode:'margin',marginPerTrade:150});const e=new PaperEngine(db,()=>c);const event=(side:'long'|'short'='long')=>({kind:'entry',side,price:100,sl:side==='long'?95:105,tp:side==='long'?[110,120,130]:[90,80,70],label:'e',message:'',source:'alert',barTime:0,barIndex:0}as const);const ctx={scannerId:'s',scannerName:'s',symbol:'BTCUSD',tf:'1m',market:{tickSize:.01,contractValue:1},refPrice:100,at:1000,signalId:null,exitMode:'both' as const,atr:10};return{db,c,e,event,ctx};}
test('entry depth sees final sized quantity and rejects larger margin without opening',t=>{const{c,e,event,ctx}=setup(t);let q=0;e.entryDepthGate=r=>{q=r.qty;return r.qty>8?{reject:'risk market: fresh depth expensive'}:{};};assert.equal(e.onEntry(event()as any,ctx).action,'opened');assert.equal(q,7);const other={...ctx,scannerId:'other',symbol:'ETHUSD'};c.paper.marginPerTrade=300;assert.equal(e.onEntry(event()as any,other).action,'rejected');assert.equal(q,15);assert.equal(e.openPositions().length,1);});
test('depth failure on immediate reversal leaves held position open',t=>{const{c,e,event,ctx}=setup(t);Object.assign(c.paper,{allowReversal:true,reversalMinR:0});const p=e.onEntry(event()as any,ctx).position!;e.setMark('BTCUSD',102);e.entryDepthGate=()=>({reject:'risk market: fresh depth missing'});assert.equal(e.onEntry(event('short')as any,{...ctx,at:1100}).action,'rejected');assert.equal(p.status,'open');assert.equal(e.openPositions().length,1);});
test('deferred fill rechecks depth and keeps the held reversal when it fails',t=>{const{c,e,event,ctx}=setup(t);Object.assign(c.paper,{allowReversal:true,reversalMinR:0});const p=e.onEntry(event()as any,ctx).position!;e.setMark('BTCUSD',102);c.paper.fillSource='tape';let veto=false;e.entryDepthGate=()=>veto?{reject:'risk market: fresh depth stale'}:{};assert.equal(e.onEntry(event('short')as any,{...ctx,at:1100}).action,'pending');veto=true;e.onTrade('BTCUSD',100,1,2000,2000);assert.equal(p.status,'open');assert.equal(e.pendingEntries().length,0);});
test('resting maker fill rechecks sized quantity and maker mode after configuration changes',t=>{const{c,e,event,ctx}=setup(t);c.paper.fillSource='tape';c.paper.limitEntry={enabled:true,atr:.1,bars:2,tfs:['1m'],books:['account']};let seen:any[]=[];e.entryDepthGate=r=>{seen.push(r);return r.qty>8?{reject:'risk market: fresh depth size'}:{};};assert.equal(e.onEntry(event()as any,ctx).action,'pending');c.paper.marginPerTrade=300;e.onTrade('BTCUSD',98,1,2000,2000);assert.equal(e.openPositions().length,0);assert.equal(e.pendingEntries().length,0);assert.equal(seen.at(-1).maker,true);assert.ok(seen.at(-1).qty>8);});
test('the unchanged 6x ratio is applied again to actual depth cost',t=>{const{c,e,event,ctx}=setup(t);c.paper.minRiskFeeRatio=6;e.entryDepthGate=()=>({crossingPct:1});const d=e.onEntry(event()as any,ctx);assert.equal(d.action,'rejected');assert.match(d.reason!,/stop too tight for fees/);});

import{EntryDepthGate,wireEntryDepth}from'../risk/entryDepth.ts';import{bookPaperConfig}from'./policy.ts';
test('production wiring checks shadow synthetic purse at deployable size and uses the larger tier when margin changes',async t=>{
 const{db,c,e,event,ctx}=setup(t);ctx.at=1793034800000;c.risk.marketGate={...c.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25,exempt:[]};
 const shadow=new PaperEngine(db,()=>({...c,paper:bookPaperConfig(c,'shadow')}),{book:2});
 const gate=new EntryDepthGate({cfg:()=>c,now:()=>ctx.at,book:async()=>({timestamp:ctx.at*1000,buy:[{price:99.99,size:8},{price:99,size:100}],sell:[{price:100.01,size:8},{price:101,size:100}]})});
 wireEntryDepth(e,shadow,gate);await shadow.prepareEntryDepth!('BTCUSD');
 const d=shadow.onEntry(event()as any,ctx);assert.equal(d.action,'opened');assert.ok(d.position!.qty>1000,'shadow bookkeeping retains synthetic size');
 const measured=gate.stats.last[0];assert.equal(measured.qty,7);assert.equal(measured.virtualQty,d.position!.qty);assert.equal(measured.book,2);
 c.paper.marginPerTrade=300;await shadow.prepareEntryDepth!('ETHUSD');assert.equal(shadow.onEntry(event()as any,{...ctx,symbol:'ETHUSD'}).action,'rejected');assert.equal(gate.stats.last[0].qty,15);
});
test('quarantined shadow wins cannot raise the account leverage tier',t=>{const{db,c,e}=setup(t);c.paper.marginLeverage={base:5,strong:10,weak:5,strongAboveR:.05,weakBelowR:-.05,minTrades:1,lookback:30};db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,exit_at,realized_pnl,fees,risk_amount,bt) VALUES('closed','s','s','BTCUSD','1m','long',1,0,1,100,100,200,50,0,10,2)");const p=db.get<any>('SELECT id FROM positions')!;assert.equal(e.cellLeverage({scannerId:'s',symbol:'BTCUSD',tf:'1m',at:1000},c.paper).leverage,10);db.run("INSERT INTO evidence_flags VALUES(?,100,'quarantined','invalid fill','test',1000)",p.id);assert.equal(e.cellLeverage({scannerId:'s',symbol:'BTCUSD',tf:'1m',at:1000},c.paper).leverage,5);});
test('account market entry pays depth VWAP, keeps risk sizing and records its price source',t=>{
 const{e,event,ctx,db}=setup(t);e.marketDepthPrice=(_s,side)=>({price:side==='long'?101:99});
 const d=e.onEntry(event()as any,ctx);assert.equal(d.action,'opened');assert.equal(d.position!.entryPrice,101);
 assert.equal(db.get<any>("SELECT price_source FROM orders WHERE reason='entry'")!.price_source,'depth');
 assert.equal(d.position!.riskAmount,(101-95)*d.position!.qty);
});
test('deferred market fill reprices depth and refuses invalidated levels before closing a reversal',t=>{
 const{c,e,event,ctx}=setup(t);c.paper.fillSource='tape';let price=101;e.marketDepthPrice=()=>({price});
 assert.equal(e.onEntry(event()as any,ctx).action,'pending');price=102;e.onTrade('BTCUSD',100,1,2000,2000);
 assert.equal(e.openPositions()[0].entryPrice,102);
 const b=setup(t);b.c.paper.fillSource='tape';b.e.marketDepthPrice=()=>({price:101});b.e.onEntry(b.event()as any,b.ctx);
 b.e.marketDepthPrice=()=>({price:140});b.e.onTrade('BTCUSD',100,1,2000,2000);assert.equal(b.e.openPositions().length,0);assert.equal(b.e.pendingEntries().length,0);
});
test('depth VWAP uses contract quantity and rejects stale or incomplete books',async t=>{
 const{c}=setup(t);let now=1793034800000;c.risk.marketGate={...c.risk.marketGate!,enabled:true,freshDepth:true,maxBookCostPct:.25};c.paper.quoteMaxAgeMs=10000;
 const g=new EntryDepthGate({cfg:()=>c,now:()=>now,book:async()=>({timestamp:now*1000,buy:[{price:99,size:2},{price:98,size:3}],sell:[{price:101,size:2},{price:102,size:3}]})});
 await g.prepare('BTCUSD');assert.equal(g.executionPrice('BTCUSD','long',4).price,101.5);assert.equal(g.executionPrice('BTCUSD','short',4).price,98.5);
 assert.match(g.executionPrice('BTCUSD','long',6).reject!,/insufficient/);now+=10001;assert.match(g.executionPrice('BTCUSD','long',4).reject!,/unavailable/);
});
test('depth repricing respects the stop-risk ceiling and does not reprice resting makers',t=>{
 const a=setup(t);a.c.paper.maxStopLossPct=1;a.e.marketDepthPrice=()=>({price:104});
 const d=a.e.onEntry(a.event()as any,a.ctx);assert.equal(d.action,'opened');assert.ok(d.position!.riskAmount<=a.c.paper.initialEquity*.01+1e-8);
 const b=setup(t);b.c.paper.fillSource='tape';b.c.paper.limitEntry={enabled:true,atr:.1,bars:2,tfs:['1m'],books:['account']};
 b.e.marketDepthPrice=()=>{throw Error('maker must keep its own price');};
 assert.equal(b.e.onEntry(b.event()as any,b.ctx).action,'pending');b.e.onTrade('BTCUSD',98,1,2000,2000);assert.equal(b.e.openPositions()[0].entryPrice,99);
});
test('depth invalidation of a deferred reversal keeps the existing position',t=>{
 const a=setup(t);a.c.paper.allowReversal=true;a.c.paper.reversalMinR=0;
 const held=a.e.onEntry(a.event()as any,a.ctx).position!;a.e.setMark('BTCUSD',102);a.c.paper.fillSource='tape';
 let price=99;a.e.marketDepthPrice=()=>({price});assert.equal(a.e.onEntry(a.event('short')as any,{...a.ctx,at:1100}).action,'pending');
 price=60;a.e.onTrade('BTCUSD',100,1,2000,2000);assert.equal(held.status,'open');assert.equal(a.e.openPositions().length,1);assert.equal(a.e.openPositions()[0].id,held.id);
});
