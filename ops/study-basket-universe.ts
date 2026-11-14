/** Offline research only. Public closed candles are NOT exchange tape or historical depth.
 * Uses the real source, basket engine and unchanged regime/fee/capital rules in disposable databases.
 * Usage: node ops/study-basket-universe.ts /path/to/universe-input.json [SYMBOL ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Db} from '../server/src/db.ts';
import {DEFAULT_CONFIG} from '../server/src/config.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {PinePool} from '../server/src/pine/pool.ts';
import {variantCompatibleSource} from '../server/src/scanners/variantCompat.ts';
import {applyPatches} from '../server/src/pine/patches.ts';
import {extractEvents} from '../server/src/scanners/extractor.ts';
import {BASKET_SCANNER,basketLevels,sizeBasketEntry} from '../server/src/paper/basket.ts';
import {planSnapshot,planScannerId,planEvents,type ExecutionPlan} from '../server/src/paper/executionPlans.ts';
import {productFees} from '../server/src/paper/productFees.ts';
import {freshDepthGate} from '../server/src/risk/entryDepth.ts';
import {regimeRefusal} from '../server/src/risk/manager.ts';
import {atrSeries} from '../server/src/data/indicators.ts';
import {eligibleEvidence} from '../server/src/evidence/trades.ts';
import {toMs} from '../server/src/delta/ws.ts';
import type {Bar} from '../server/src/data/candleStore.ts';
import type {ScanEvent} from '../server/src/scanners/extractor.ts';
import assert from 'node:assert/strict';

const file=path.resolve(process.argv[2]),dir=path.dirname(file),input=JSON.parse(fs.readFileSync(file,'utf8'));
const vm=JSON.parse(fs.readFileSync(path.join(dir,'vm-research-input.json'),'utf8'));
assert.equal(vm.mode,'paper');assert.equal(vm.paper.marginPerTrade,150);assert.equal(vm.paper.maxStopLossPct,3);
const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper=vm.paper;cfg.risk=vm.risk;cfg.execution.mode='paper';
const spec=JSON.parse(fs.readFileSync(new URL('../scripts/specs.json',import.meta.url),'utf8'))[BASKET_SCANNER];
cfg.scanners[BASKET_SCANNER]={symbols:null,timeframes:null,...spec};
const source=applyPatches(variantCompatibleSource(BASKET_SCANNER,fs.readFileSync(new URL('../scripts/pine/XuywwObg-RSI-Volume-Ladder.pine',import.meta.url),'utf8')).source,'XuywwObg-RSI-Volume-Ladder.pine').source;
const hash=createHash('sha256').update(source).digest('hex'),pool=new PinePool(2,60000),minuteMode=process.argv.includes('--minute'),requested=new Set(process.argv.slice(3).filter(x=>x!=='--minute'));
const actualSizeMode=process.argv.includes('--actual-size');requested.delete('--actual-size');
const output=path.join(dir,(minuteMode?'study-minute':'study-results')+(actualSizeMode?'-actual':''));fs.mkdirSync(output,{recursive:true});
const summary=(trades:any[])=>{const net=trades.reduce((n,t)=>n+t.net,0),wins=trades.filter(t=>t.net>0),losses=trades.filter(t=>t.net<0),gp=wins.reduce((n,t)=>n+t.net,0),gl=-losses.reduce((n,t)=>n+t.net,0);return {trades:trades.length,net,pf:gl>0?gp/gl:gp>0?99:0,fees:trades.reduce((n,t)=>n+t.fees,0),funding:trades.reduce((n,t)=>n+t.funding,0),stops:trades.filter(t=>/sl|stop|liquidation/.test(t.reason??'')).length,winRate:trades.length?wins.length/trades.length:0};};
function replay(row:any,bars:Bar[],events:ScanEvent[],halfSpreadBps:number,highFirst=false,exitStressBps=0,minutes?:Bar[]){
 const symbol=row.symbol,product=row.product,market={contractValue:Number(product.contract_value),tickSize:Number(product.tick_size),maintenanceMarginPct:Number(product.maintenance_margin),maxLeverage:100/Number(product.initial_margin),productFees:productFees(product)};
 const plan:ExecutionPlan={id:`basket-study-${symbol.toLowerCase()}`,revision:1,enabled:true,scannerId:BASKET_SCANNER,symbol,tf:'15m',variant:'current',referenceEquity:1000,basket:'rsi-volume-ladder-v1',readingOverride:{version:1,reader:2}};
 cfg.executionPlans=[plan];
 const snap=planSnapshot(cfg,plan,hash,market.productFees),id=planScannerId(snap),db=new Db(':memory:');
 let now=bars[0].time,price=bars[0].close;const e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;e.marketFeesFor=()=>market.productFees;
 const f=halfSpreadBps/10000,exitF=f+exitStressBps/10000,latency=cfg.paper.latencyMs;
 e.quotes={executable:(_s,side)=>price*(side==='buy'?1+f:1-f),markState:()=>({bestBid:price*(1-f),bestAsk:price*(1+f),at:now,quoteAt:now,quoteExchangeAt:now})};
 e.entryDepthGate=req=>{const cost=(req.fees.feeRatePct*2)*(1+(req.fees.feeTaxPct??0)/100)+halfSpreadBps*2/100;return cost>cfg.risk.marketGate.maxBookCostPct! ? {reject:'research modeled crossing exceeds unchanged book cost ceiling'}:{crossingPct:halfSpreadBps*2/100};};
 const byBar=new Map(events.map(ev=>[ev.barTime,ev])),indices=new Map(bars.map((b,i)=>[b.time,i])),atrs=atrSeries(bars,14),actions:Record<string,number>={},tape=minutes??bars;let candidates=0,maxMargin=0,maxRisk=0;
 const offsets=minutes?[0,15000,15000+latency+1,35000,35000+latency+1,60000]:[12000+latency+1,120000,120000+latency+1,360000,360000+latency+1,720000];
 try{
  for(let j=0;j<tape.length;j++){
   const b=tape[j],i=indices.get(Math.floor(b.time/900000)*900000);if(i===undefined||i<60||b.time<input.tradeFrom)continue;
   if(e.openPositions().length||e.pendingEntries().length){
    const points=highFirst?[b.open,b.high,b.high,b.low,b.low,b.close]:[b.open,b.low,b.low,b.high,b.high,b.close];
    for(let k=0;k<points.length;k++){
     // Coarse screening's optimistic intrabar bound: a continuous crossing at the
     // stop, never a repaired opening gap. Any shortlist needs minute/tape checks.
     const held=e.openPositions()[0];
     if(!minutes&&k>0&&held?.sl&&points[k-1]>held.sl&&points[k]<=held.sl){
      price=held.sl;now=b.time+offsets[k]-latency*2-1;
      e.onTrade(symbol,price,Math.max(1,Math.floor(b.volume/6)),now,now,`hypothetical-stop:${b.time}:${k}`);
      const at=now+latency;e.settleExits(symbol,{receivedAt:at,exchangeAt:at,bids:[{price:price*(1-exitF),size:1e9}],asks:[{price:price*(1+exitF),size:1e9}]},at);
     }
     price=points[k];now=b.time+offsets[k];
     if(k===0&&b.time%(8*3600000)===0)e.reconcileFunding(symbol,.03,price,b.time);
     e.onTrade(symbol,price,Math.max(1,Math.floor(b.volume/6)),now,now,`hypothetical:${b.time}:${k}`);
     // Preserve the VM's candles entry mode; both feed paths run in production.
     // This is an explicitly hypothetical partial-minute observation, not recovered live tape.
     if(!minutes||k===5)e.onBar(symbol,minutes?b:{time:Math.floor(now/60000)*60000,open:price,high:price,low:price,close:price,volume:Math.max(1,b.volume/6)},now);
     const at=now+latency;e.settleExits(symbol,{receivedAt:at,exchangeAt:at,bids:[{price:price*(1-exitF),size:1e9}],asks:[{price:price*(1+exitF),size:1e9}]},at);
    }
   }
   if(minutes&&(b.time+60000)%900000!==0)continue;
   const signalBar=bars[i],ev=byBar.get(signalBar.time);if(!ev)continue;candidates++;now=signalBar.time+900000+12000;price=signalBar.close;
   const prior=bars.slice(Math.max(0,i-200),i+1),refusal=regimeRefusal(cfg.risk.regime,BASKET_SCANNER,{at:now,price,atr:atrs[i]},prior);
   if(refusal){const key=refusal.split('(')[0].replace(/[0-9.]+/g,'#');actions[key]=(actions[key]??0)+1;continue;}
   const event=planEvents([ev],prior,snap)[0],d=e.onEntry(event,{scannerId:id,scannerName:'Basket hypothetical screen',symbol,tf:'15m',market,at:now,refPrice:price,atr:atrs[i],signalBar,exitMode:snap.exitMode,signalId:null,executionPlan:snap});
   const key=d.reason??d.action;actions[key]=(actions[key]??0)+1;
   for(const p of e.openPositions()){maxMargin=Math.max(maxMargin,p.basket!.marginUsed);maxRisk=Math.max(maxRisk,p.riskAmount);assert.ok(p.basket!.marginUsed<=150+1e-7);assert.ok(p.riskAmount<=30+1e-7);}
  }
  const positions=db.all<any>("SELECT * FROM positions WHERE bt=2 AND status!='pending'");
  const trades=positions.map(p=>{const j=JSON.parse(p.fills),fills=j.fills??j;return {id:p.id,entryAt:p.entry_at,exitAt:p.exit_at,status:p.status,net:p.realized_pnl-p.fees,fees:p.fees,funding:fills.filter((x:any)=>x.reason==='funding').reduce((n:number,x:any)=>n+x.pnl,0),risk:p.risk_amount,legs:j.basket?.entries??0,reason:p.exit_reason,qty:p.qty_open,entry:p.entry_price,contractValue:p.contract_value};});
  const closed=trades.filter(t=>t.status==='closed'),training=closed.filter(t=>t.entryAt<input.holdoutFrom&&t.exitAt<input.holdoutFrom),holdout=closed.filter(t=>t.entryAt>=input.holdoutFrom);
  const open=trades.filter(t=>t.status==='open').map(t=>({...t,markedNet:t.net+(bars.at(-1)!.close*(1-f)-t.entry)*t.qty*t.contractValue-bars.at(-1)!.close*(1-f)*t.qty*t.contractValue*snap.paper.feeRatePct/100*(1+(snap.paper.feeTaxPct??0)/100)}));
  assert.equal(db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n,0);
  return {resolution:minutes?'1m':'15m',halfSpreadBps,exitStressBps,highFirst,candidates,actions,maxMargin,maxRisk,training:summary(training),holdout:summary(holdout),total:summary(closed),open,trades};
 }finally{db.db.close();}
}
try{
 for(const row of input.rows){
  if(row.exclusions.length||requested.size&&!requested.has(row.symbol))continue;
  const out:any={symbol:row.symbol,at:new Date().toISOString(),sourceHash:hash,dataHash:row.dataHash,exclusions:[],depth:[],assumptions:'Hypothetical OHLC order paths and modeled quotes/depth; current full product commissions + GST; +0.03% funding payment each 8h; not historical execution or promotion evidence.'};
  if(row.error||row.gaps||row.bars<6000){out.exclusions.push(row.error??'insufficient contiguous history for fixed 60-day/30-day split');fs.writeFileSync(path.join(output,row.symbol+'.json'),JSON.stringify(out));continue;}
  const fees=productFees(row.product);assert.ok(fees);const price=Number(row.ticker.mark_price),cv=Number(row.product.contract_value),qty=Math.max(1,Math.floor(750/price/cv));
  const assessment:ExecutionPlan={id:'basket-liquidity-check',revision:1,enabled:true,scannerId:BASKET_SCANNER,symbol:row.symbol,tf:'15m',variant:'current',referenceEquity:1000,basket:'rsi-volume-ladder-v1',readingOverride:{version:1,reader:2}};
  const effective=planSnapshot(cfg,assessment,hash,fees).paper;
  for(const s of row.bookSamples){const b=s.book,ask=Number(b.sell[0]?.price),tick=Number(row.product.tick_size);
   const sized=actualSizeMode?sizeBasketEntry(ask,basketLevels(ask,tick).sl,{cfg:effective,equity:1000,availableMargin:1000,contractValue:cv,tickSize:tick,maintenanceMarginPct:Number(row.product.maintenance_margin),maxLeverage:100/Number(row.product.initial_margin),wantedLeverage:effective.marginLeverage?.base??5,entryExecution:{quoted:true}}):null;
   out.depth.push({...freshDepthGate({now:s.receivedAt,receivedAt:s.receivedAt,exchangeAt:toMs(b.timestamp??b.last_updated_at,0),maxAgeMs:cfg.paper.quoteMaxAgeMs,qty:sized?.qty??qty,contractValue:cv,book:{bids:b.buy.map((l:any)=>[Number(l.price),Number(l.size)*cv]),asks:b.sell.map((l:any)=>[Number(l.price),Number(l.size)*cv])},maxCostPct:cfg.risk.marketGate.maxBookCostPct!,fees:{...fees,feeTaxPct:cfg.paper.feeTaxPct??0}}),checkedQty:sized?.qty??qty,basis:actualSizeMode?'actual rounded first-leg quantity; add-ons recheck depth on arrival':'full-margin $750 liquidity stress'});
  }
  if(out.depth.some((d:any)=>!d.allowed)){out.exclusions.push('one or more current full-basket depth/cost checks failed');fs.writeFileSync(path.join(output,row.symbol+'.json'),JSON.stringify(out));continue;}
  const bars:Bar[]=JSON.parse(fs.readFileSync(path.join(dir,'market-data',row.symbol+'-15m.json'),'utf8')).bars;
  const minuteData=minuteMode?JSON.parse(fs.readFileSync(path.join(dir,'market-data',row.symbol+'-1m.json'),'utf8')):null;
  if(minuteData){
   // No position exists before the first newly closed source bar. A missing
   // prefix strictly before that first possible entry is disclosed, never filled.
   assert.ok(minuteData.gaps===0&&minuteData.bars[0]?.time<=input.tradeFrom+900000&&minuteData.bars.at(-1)?.time===input.historyEndExclusive-60000,'complete post-signal minute history required');
   out.minuteCoverage={bars:minuteData.bars.length,unobservedPrefixMinutes:(minuteData.bars[0].time-input.tradeFrom)/60000,gaps:minuteData.gaps};
  }
  const run=await pool.run({scannerId:BASKET_SCANNER,source,symbol:row.symbol,tf:'15m',tickSize:Number(row.product.tick_size),bars,tailBars:'all',plotTail:0});assert.ok(run.ok,run.error);
  const events=extractEvents(run.alerts,run.shapes,{scannerId:BASKET_SCANNER,...cfg.scanners[BASKET_SCANNER],barMs:900000}).filter(e=>e.kind==='entry');
  const half=Math.max(2,...out.depth.map((d:any)=>d.crossingPct*100/2));
  out.sourceRunMs=run.ms;out.sourceCandidates=events.length;
  out.baseline=replay(row,bars,events,half,false,0,minuteData?.bars);
  out.stress=replay(row,bars,events,half,false,5,minuteData?.bars);
  out.pathCheck=replay(row,bars,events,half,true,5,minuteData?.bars);
  // Predeclared exploratory shortlist, not a new evidence or promotion rule.
  out.shortlist=[out.baseline,out.stress,out.pathCheck].every(x=>x.training.trades>=5&&x.holdout.trades>=5&&x.total.trades>=12&&x.training.net>0&&x.holdout.net>0&&x.training.pf>=1.2&&x.holdout.pf>=1.2&&x.holdout.net+x.open.reduce((n:number,t:any)=>n+Math.min(0,t.markedNet),0)>0);
  fs.writeFileSync(path.join(output,row.symbol+'.json'),JSON.stringify(out));
  console.log(JSON.stringify({symbol:row.symbol,signals:events.length,depth:true,train:out.stress.training,test:out.stress.holdout,shortlist:out.shortlist}));
 }
}finally{pool.stop();}
