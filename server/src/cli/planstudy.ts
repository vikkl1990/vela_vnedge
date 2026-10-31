import {planSnapshot,planBacktest,planEvents} from '../paper/executionPlans.ts';
import {sourceHash} from '../paper/fingerprint.ts';
/** Paired plan study. Writes only an explicitly supplied local cache and report; no bot configuration/DB mutations.
 * SNAPSHOT=sanitized-vm.json CACHE=work/cache.db OUT=work/results.json node server/src/cli/planstudy.ts
 * Fixed calendar window; 70% development, later 30% holdout, each replay starts flat with indicators warmed up.
 */
import fs from 'node:fs';
import {Db} from '../db.ts';
import {TF_SECONDS,type AppConfig} from '../config.ts';
import {DeltaRest,marketSpec} from '../delta/rest.ts';
import {CandleCache} from '../data/candleCache.ts';
import {ScannerRegistry} from '../scanners/registry.ts';
import {PinePool,processWorker} from '../pine/pool.ts';
import {observeHistoricalRun} from '../scanners/profile.ts';
import {backtestPolicy} from '../paper/policy.ts';
import {runBacktest} from '../paper/backtest.ts';
import {adaptPlan,planPrefixDifference,type PlanVariant} from '../paper/planStudy.ts';
import type {Bar} from '../data/candleStore.ts';
for(const key of ['SNAPSHOT','CACHE','OUT']) if(!process.env[key])throw Error(`${key} is required`);
const snapshot=JSON.parse(fs.readFileSync(process.env.SNAPSHOT!,'utf8')),cfg=snapshot.config as AppConfig;
const end=Date.parse(process.env.END??'2026-10-31T10:00:00Z'),start=Date.parse(process.env.START??'2026-09-01T10:00:00Z'),split=Math.floor((start+.7*(end-start))/3600_000)*3600_000;
if(!(end>start)||end>Date.now())throw Error('invalid study window');
const scannerId=process.env.SCANNER??'liquidity-trail-matrix';
const registry=new ScannerRegistry(),s=registry.get(scannerId);if(!s||s.status!=='ok')throw Error('scanner unavailable');
const sc=cfg.scanners[scannerId],db=new Db(process.env.CACHE!),rest=new DeltaRest(),cache=new CandleCache(db,rest,{concurrency:2,now:()=>end}),pool=new PinePool(2,120000,processWorker);
const markets=(process.env.MARKETS??'BTCUSD,ETHUSD,SOLUSD,AIOTUSD,ONDOUSD').split(',');
const rows:any[]=[];
const report:any={at:Date.now(),start,end,split,scannerId,rows,assumptions:{margin:cfg.paper.marginPerTrade,leverage:cfg.paper.marginLeverage?.base,stopRiskCapPct:cfg.paper.maxStopLossPct,feeRatio:cfg.paper.minRiskFeeRatio,entry:'current account pullback policy; through-price fills; conservative fill-minute stops',variants:'native levels / ATR fallback and regenerated targets / trailing 10 closed bars plus 0.25 ATR and regenerated targets; all experimental plans use bot level exits',costs:'configured maker/taker commissions, tax and slippage; stress adds 5bp per market leg; no historical depth or exact funding settlements available',scope:'isolated cell replays, not a portfolio replay; current product specs and base leverage, no hindsight leverage selection; closed trades only; remaining open positions reported and excluded from qualification',qualification:'at least 20 holdout closes, positive holdout net and stressed net, positive development base and stressed net, no open holdout positions, stable prefix plans, minute coverage >=99.5%; this flags further paper testing, never automatic promotion'}};
if(process.env.REGISTRY==='1')report.assumptions.registry='same versioned plan resolver and fixed reference equity as prospective shadow comparisons; source and policy hashes recorded per row';
const save=()=>fs.writeFileSync(process.env.OUT!,JSON.stringify(report,null,2));
function summary(r:ReturnType<typeof runBacktest>){
 const ts=r.trades;let pnl=0,peak=0,dd=0;for(const t of [...ts].sort((a,b)=>(a.exitAt??0)-(b.exitAt??0))){pnl+=t.pnl;peak=Math.max(peak,pnl);dd=Math.max(dd,peak-pnl);}
 return {trades:ts.length,net:pnl,fees:ts.reduce((a,t)=>a+t.fees,0),sumR:ts.reduce((a,t)=>a+(t.rMultiple??0),0),avgR:ts.length?ts.reduce((a,t)=>a+(t.rMultiple??0),0)/ts.length:0,stops:ts.filter(t=>t.exitReason==='sl').length,closedDrawdown:dd,rejected:r.rejected,costCoverage:r.costCoverage,entryFlow:r.entryFlow,open:r.stats.open};
}
try{
 for(const symbol of markets){
  const product=await rest.product(symbol),market=marketSpec(product);
  console.log(`${symbol}: loading closed minute history`);
  const minutes=await cache.getHistory(symbol,'1m',{from:start,to:end-60000});
  const minuteCoverage=minutes.length/Math.floor((end-start)/60000);
  const tfs=process.env.TFS?process.env.TFS.split(','):['BTCUSD','ETHUSD','SOLUSD'].includes(symbol)?['15m','1h','4h']:['15m'];
  for(const tf of tfs){
   try{
    const ms=TF_SECONDS[tf]*1000,bars=await cache.getHistory(symbol,tf,{from:start-200*ms,to:end-ms});
    const run=async(b:Bar[])=>{const r=await pool.run({scannerId,source:s.patched,symbol,tf,tickSize:market.tickSize,bars:b,tailBars:'all',plotTail:b.length,inputs:sc?.inputs,timezone:sc?.timezone});if(!r.ok)throw Error(r.error);return observeHistoricalRun(s,sc,symbol,tf,b,r,'planstudy');};
    const full=await run(bars),prefixBars=bars.filter(b=>b.time+ms<=split),prefix=await run(prefixBars);
    const honesty=planPrefixDifference(full.events,prefix.events,prefixBars.at(-1)!.time);
    const nativeEntries=full.events.filter(e=>e.kind==='entry'&&e.barTime+ms>=start).length;
    for(const phase of ['development','holdout'] as const){
     const from=phase==='development'?start:split,to=phase==='development'?split:end;
     const b=bars.filter(b=>b.time+ms<=to),source=phase==='development'?prefix.events:full.events;
     const events=source.filter(e=>e.barTime+ms>=from&&e.barTime+ms<to);
     for(const variant of ['current','native','atr','structure'] as const){
      const definition=cfg.executionPlans?.find(p=>p.enabled&&p.scannerId===scannerId&&p.symbol===symbol&&p.tf===tf&&p.variant===variant);
      if(process.env.REGISTRY==='1'&&!definition)continue;
      const plan=process.env.REGISTRY==='1'&&definition?planSnapshot(cfg,definition,sourceHash(s.patched)):undefined;
      const adapted=plan?planEvents(events,b,plan):variant==='current'?events:adaptPlan(events,b,variant as PlanVariant);
      const policy=plan?planBacktest(plan):backtestPolicy(cfg,scannerId,tf,'account');
      for(const stress of [0,5]){
       const result=runBacktest({scannerId,scannerName:s.name,symbol,tf,bars:b,events:adapted,...policy,...market,
        cfg:{...policy.cfg,slippageBps:policy.cfg.slippageBps+stress,quotedSlippageBps:(policy.cfg.quotedSlippageBps??0)+stress},
        requireAtrStop:variant==='current'?policy.requireAtrStop:false,exitMode:variant==='current'?policy.exitMode:'levels',
        subBars:minutes.filter(b=>b.time>=from&&b.time<to),conservativeEntryMinute:true});
       rows.push({plan:plan?{id:plan.id,revision:plan.revision,signature:plan.signature,referenceEquity:plan.referenceEquity}:null,symbol,tf,phase,variant,stress,minuteCoverage,honesty,signature:full.profile.signature,nativeEntries,...summary(result)});
      }
     }
    }
    console.log(`${symbol} ${tf}: ${nativeEntries} entries; ${honesty.changed} changed prefix plans; ${(100*minuteCoverage).toFixed(2)}% minute coverage`);save();
   }catch(e){rows.push({symbol,tf,error:String(e)});save();console.error(symbol,tf,String(e));}
  }
 }
}finally{await pool.stop();db.db.close();save();}

report.qualification=rows.filter(r=>r.phase==='holdout'&&r.stress===0&&r.variant!=='current').map(r=>{
 const same=(x:any)=>x.symbol===r.symbol&&x.tf===r.tf&&x.variant===r.variant;
 const stress=rows.find(x=>same(x)&&x.phase==='holdout'&&x.stress===5),dev=rows.find(x=>same(x)&&x.phase==='development'&&x.stress===0),devStress=rows.find(x=>same(x)&&x.phase==='development'&&x.stress===5);
 const reasons=[r.trades<20?'fewer than 20 holdout closes':null,!(dev?.net>0)?'development net not positive':null,!(devStress?.net>0)?'stressed development net not positive':null,!(r.net>0)?'holdout net not positive':null,!(stress?.net>0)?'stressed holdout net not positive':null,r.open||stress?.open?'unresolved holdout position':null,r.honesty.changed?'prefix plans changed':null,r.minuteCoverage<.995?'incomplete minute coverage':null].filter(Boolean);
 return {symbol:r.symbol,tf:r.tf,variant:r.variant,qualifies:!reasons.length,reasons};
});
save();
