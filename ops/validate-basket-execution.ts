/** Offline shadow mechanics validation on saved closed candles. No VM writes or eligibility changes.
 * Usage: node ops/validate-basket-execution.ts /path/ETHUSD-15m.json
 * Synthetic OHLC paths are NOT trade tape, queue proof, or profitability evidence.
 */
import fs from 'node:fs';
import {Db} from '../server/src/db.ts';
import {DEFAULT_CONFIG,type ScannerConfig} from '../server/src/config.ts';
import {PaperEngine} from '../server/src/paper/engine.ts';
import {PlanComparisons} from '../server/src/paper/planComparisons.ts';
import {PinePool} from '../server/src/pine/pool.ts';
import {variantCompatibleSource} from '../server/src/scanners/variantCompat.ts';
import {extractEvents} from '../server/src/scanners/extractor.ts';
import {BASKET_SCANNER} from '../server/src/paper/basket.ts';
import {eligibleEvidence} from '../server/src/evidence/trades.ts';
import type {Bar} from '../server/src/data/candleStore.ts';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),bars:Bar[]=Array.isArray(data)?data:data.bars;
assert.ok(bars.length>100&&bars.every((b,i)=>i===0||b.time-bars[i-1].time===900000),'contiguous closed 15m candles required');
const cfg=structuredClone(DEFAULT_CONFIG);cfg.execution.mode='paper';
Object.assign(cfg.paper,{sizingMode:'margin',marginPerTrade:150,maxStopLossPct:3,initialEquity:1000,latencyMs:100,fillSource:'tape',requireQuote:false,useSpread:false,liquidation:true,slippageBps:2,quotedSlippageBps:0,maxSignalAgeSec:60});
const specs=JSON.parse(fs.readFileSync(new URL('../scripts/specs.json',import.meta.url),'utf8'));
cfg.scanners[BASKET_SCANNER]={symbols:null,timeframes:null,...specs[BASKET_SCANNER]} as ScannerConfig;
cfg.executionPlans=[{id:'basket-validation',revision:1,enabled:true,scannerId:BASKET_SCANNER,symbol:'ETHUSD',tf:'15m',variant:'current',referenceEquity:1000,basket:'rsi-volume-ladder-v1',readingOverride:{version:1}}];
const raw=fs.readFileSync(new URL('../scripts/pine/XuywwObg-RSI-Volume-Ladder.pine',import.meta.url),'utf8'),source=variantCompatibleSource(BASKET_SCANNER,raw).source;
const hash=createHash('sha256').update(source).digest('hex'),pool=new PinePool(1,30000),db=new Db(':memory:');
try{
 const run=async(xs:Bar[])=>{const r=await pool.run({scannerId:BASKET_SCANNER,source,symbol:'ETHUSD',tf:'15m',tickSize:.05,bars:xs,tailBars:'all',plotTail:0});assert.ok(r.ok,r.error);return r;};
 const result=await run(bars),read=(r:typeof result)=>extractEvents(r.alerts,r.shapes,{scannerId:BASKET_SCANNER,...cfg.scanners[BASKET_SCANNER],barMs:900000});
 const events=read(result).filter(e=>e.kind==='entry');let prefixChecks=0;
 for(const ev of events){const end=bars.findIndex(b=>b.time===ev.barTime)+1;if(end<100)continue;
   assert.deepEqual(read(await run(bars.slice(0,end))).filter(e=>e.barTime===ev.barTime),read(result).filter(e=>e.barTime===ev.barTime));prefixChecks++;
 }
 let now=bars[0].time,e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;
 let service=new PlanComparisons(db,()=>cfg,e,()=>hash),restarts=0,maxMargin=0,maxRisk=0;
 for(let i=60;i<bars.length;i++){
  const b=bars[i];
  // Conservative low-before-high path, explicitly synthetic. Six observations per candle.
  for(const [k,price] of [b.open,b.low,b.low,b.high,b.high,b.close].entries()){
   now=b.time+[101,120000,120100,360000,360100,720000][k];e.onTrade('ETHUSD',price,Math.max(1,Math.floor(b.volume/6)),now,now,`synthetic:${i}:${k}`);
   const depth={receivedAt:now+100,exchangeAt:now+100,bids:[{price:price*.9999,size:1000000}],asks:[{price:price*1.0001,size:1000000}]};
   e.settleExits('ETHUSD',depth,now+100);
  }
  now=b.time+900001;
  const prefixResult={...result,lastBarTime:b.time,bars:i+1,alerts:result.alerts.filter(a=>a.time<=b.time),shapes:result.shapes.map(s=>({...s,times:s.times.filter(t=>t<=b.time)})),labels:[],plots:[]};
  service.observeScan({scannerId:BASKET_SCANNER,scannerName:'RSI Volume Ladder',symbol:'ETHUSD',tf:'15m',bars:bars.slice(0,i+1),result:prefixResult,patched:source,since:b.time,newLabelKeys:new Set(),at:now,refPrice:b.close,market:{tickSize:.05,contractValue:.01},refusal:()=>null});
  for(const p of e.openPositions()){assert.ok(p.basket!.marginUsed<=150+1e-8);maxMargin=Math.max(maxMargin,p.basket!.marginUsed);maxRisk=Math.max(maxRisk,p.riskAmount+p.fees);assert.equal(p.qtyOpen,p.qty-p.fills.filter(f=>f.reason!=='entry'&&f.reason!=='funding').reduce((n,f)=>n+f.qty,0));}
  if(i%137===0){e=new PaperEngine(db,()=>cfg,{book:2,now:()=>now});e.causalExits=true;service=new PlanComparisons(db,()=>cfg,e,()=>hash);restarts++;}
 }
 const eventsByAction=db.all('SELECT action,reason,count(*) n FROM execution_plan_events GROUP BY action,reason');
 assert.ok(db.get<any>('SELECT count(*) n FROM paper_basket_entries')!.n>0,'saved-candle simulation must exercise actual basket fills');
 const receipts=db.all<any>('SELECT p.id,p.status,p.qty,p.realized_pnl,p.fees,json_extract(p.fills,\'$.basket.entries\') legs FROM positions p WHERE bt=2 AND status!=\'pending\'');
 // Simulate the crash window between a committed add and the post-commit event notification.
 const added=db.get<any>('SELECT plan_event_id FROM paper_basket_entries WHERE sequence=2 LIMIT 1');
 if(added){db.run("UPDATE execution_plan_events SET action='pending',position_id=-1,filled_at=NULL WHERE id=?",added.plan_event_id);service=new PlanComparisons(db,()=>cfg,e,()=>hash);assert.equal(db.get<any>('SELECT action FROM execution_plan_events WHERE id=?',added.plan_event_id)!.action,'opened');}
 const view=service.view().cohorts[0];assert.equal(view.closed,receipts.filter(p=>p.status==='closed').length);assert.equal(view.filled,receipts.length);
 const eligible=db.get<any>(`SELECT count(*) n FROM positions p LEFT JOIN trade_policies t ON t.id=p.policy_id WHERE ${eligibleEvidence}`)!.n;assert.equal(eligible,0);
 console.log(JSON.stringify({verifiedAt:new Date().toISOString(),scope:'mechanics only: synthetic OHLC tape/depth, NOT profitability or executable historical fills',sourceHash:hash,bars:bars.length,from:bars[0].time,to:bars.at(-1)!.time,candidates:events.length,prefixChecks,restarts,cohort:{filled:view.filled,filledEntries:view.filledEntries,closed:view.closed,open:view.open},orders:db.get<any>('SELECT count(*) n FROM orders')!.n,receipts,eventsByAction,maxMargin,maxRisk,eligible},null,2));
}finally{pool.stop();db.db.close();}
