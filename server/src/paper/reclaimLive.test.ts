import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {reclaimStatus} from './reclaimAudit.ts';
import type {Bar} from '../data/candleStore.ts';
const ID='smart-money-breakout-signals', M=60_000;
function setup(t:any,scale=1/3,book=0){
  const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
  cfg.scanners[ID]={...cfg.scanners[ID],enabled:true,pairs:[{symbol:'SOLUSD',tf:'15m'}]};
  Object.assign(cfg.paper,{fillSource:'tape',liquidation:false,feeRatePct:0,makerFeeRatePct:0,slippageBps:0,minRiskFeeRatio:0,maxSignalAgeSec:60,minSizeShare:0,requireQuote:true,useSpread:true,quoteMaxAgeMs:10000});
  cfg.paper.reclaimTrials=[{enabled:true,scannerId:ID,symbol:'SOLUSD',tf:'15m',pullbackAtr:.1,setupMinutes:10,orderMinutes:2,sizeScale:scale,maxDailyEntries:3}];
  const e=new PaperEngine(db,()=>cfg,{book});e.quotes={executable:()=>100.4};
  const start=Math.floor(Date.now()/M)*M,at=start+1000;
  const ev={kind:'entry' as const,side:'long' as const,price:100,tp:[],label:'entry',message:'',source:'alert' as const,barTime:at-900000,barIndex:0};
  const ctx={scannerId:ID,scannerName:'Smart Money',symbol:'SOLUSD',tf:'15m',market:{contractValue:.01,tickSize:.01},atr:2,refPrice:100,at,signalId:null,exitMode:'both' as const};
  const b=(i:number,open:number,high:number,low:number,close:number):Bar=>({time:start+i*M,open,high,low,close,volume:1});
  const p=b(1,100,100.1,99.5,99.8),r=b(2,99.8,100.5,99.7,100.3);
  const confirm=()=>{e.onClosedMinute('SOLUSD',p,p.time+M+1000);e.onClosedMinute('SOLUSD',r,r.time+M+1000);};
  return{db,cfg,e,ev,ctx,p,r,confirm};
}
test('live reclaim cannot enter on tape/partial bars; after closed confirmation it uses a reduced audited limit',t=>{
  const a=setup(t),full=setup(t,1);assert.equal(a.e.onEntry(a.ev,a.ctx).action,'pending');
  a.e.onTrade('SOLUSD',99,1,a.ctx.at+1000,a.ctx.at+1000);
  a.e.onBar('SOLUSD',a.p,a.p.time+1000);
  a.e.onClosedMinute('SOLUSD',a.p,a.p.time+1000);
  a.e.onClosedMinute('SOLUSD',a.p,a.p.time+M+1000,true);
  assert.equal(a.e.openPositions().length,0);assert.equal(a.e.pendingEntries()[0].reclaim?.state.phase,'pullback');
  let placements=0;a.e.on('pending',(x:any)=>{if(x.type==='placed')placements++;});a.confirm();
  const order=a.e.pendingEntries()[0];assert.ok(order.limit);assert.equal(order.limit.price,100.1);assert.equal(placements,1);
  a.e.onTrade('SOLUSD',100,1,order.at-1,order.at);assert.equal(a.e.openPositions().length,0);
  a.e.onTrade('SOLUSD',100,1,order.at+1000,order.at+1000);assert.equal(a.e.openPositions().length,1);
  assert.equal(a.e.openPositions()[0].features?.reclaim_trial,1);
  full.e.onEntry(full.ev,full.ctx);full.confirm();const fo=full.e.pendingEntries()[0];full.e.onTrade('SOLUSD',100,1,fo.at+1000,fo.at+1000);
  assert.equal(a.e.openPositions()[0].qty,Math.floor(full.e.openPositions()[0].qty/3));
  assert.equal(a.e.onEntry(a.ev,{...a.ctx,at:order.at+1001}).action,'ignored');
});
test('reclaim reservations survive cancellation and restart; pending setups and short trial orders do not replay after restart',t=>{
  const a=setup(t);a.cfg.paper.reclaimTrials![0].maxDailyEntries=1;
  a.e.onEntry(a.ev,a.ctx);a.confirm();assert.ok(a.e.pendingEntries()[0].limit);
  const restarted=new PaperEngine(a.db,()=>a.cfg);assert.equal(restarted.pendingEntries().length,0);
  assert.match(restarted.onEntry(a.ev,a.ctx).reason!,/daily order limit/);
  const b=setup(t);b.e.onEntry(b.ev,b.ctx);assert.equal(new PaperEngine(b.db,()=>b.cfg).pendingEntries().length,0);
});
test('reclaim mode, allocation and config checks apply again at fill',t=>{
  for(const change of ['disabled','executor','mode','allocation']as const){
    const a=setup(t);a.e.onEntry(a.ev,a.ctx);a.confirm();const order=a.e.pendingEntries()[0];
    if(change==='disabled')a.cfg.paper.reclaimTrials![0].enabled=false;
    if(change==='executor')a.e.limitEntryAllowed=()=>false;
    if(change==='mode')a.cfg.execution.mode='dry-run';
    if(change==='allocation')a.cfg.scanners[ID].pairs=[];
    a.e.onTrade('SOLUSD',100,1,order.at+1000,order.at+1000);
    assert.equal(a.e.openPositions().length,0,change);assert.equal(a.e.pendingEntries().length,0,change);
    assert.equal(a.e.onEntry(a.ev,a.ctx).action,'rejected',change);
  }
});
test('reclaim rejects stale setups, cancels source exits/gaps, and rechecks risk at order placement',t=>{
  const a=setup(t);assert.match(a.e.onEntry(a.ev,{...a.ctx,at:a.ctx.at+2*M}).reason!,/stale/);
  a.e.onEntry(a.ev,a.ctx);a.e.onScriptExit(ID,'SOLUSD','15m','close',100,a.ctx.at+2000,'both','long');assert.equal(a.e.pendingEntries().length,0);
  a.e.onEntry(a.ev,a.ctx);a.e.onClosedMinute('SOLUSD',a.r,a.r.time+M+1000);assert.equal(a.e.pendingEntries().length,0);
  a.e.onEntry(a.ev,a.ctx);a.e.risk={gate:()=>({reject:'paused',leverageMult:1}),exposureCheck:()=>null};a.confirm();assert.equal(a.e.pendingEntries().length,0);assert.equal(a.e.openPositions().length,0);
});
test('reclaim is scoped to one account cell and validates bounded settings',t=>{
  const a=setup(t);assert.equal(a.e.onEntry(a.ev,{...a.ctx,symbol:'ETHUSD'}).reason,'awaiting tape fill');
  const shadow=setup(t,1/3,2);assert.equal(shadow.e.onEntry(shadow.ev,shadow.ctx).reason,'awaiting tape fill');
  assert.ok(!validateConfig(a.cfg).some(x=>x.includes('reclaimTrials')));
  a.cfg.paper.reclaimTrials![0].sizeScale=2;assert.ok(validateConfig(a.cfg).some(x=>x.includes('reclaimTrials')));
});

test('reclaim audit persists the funnel and reports only filled trial outcomes for the current settings',t=>{
  const a=setup(t), status=()=>reclaimStatus(a.db,a.cfg,a.e,a.ctx.at).trials[0];
  assert.equal(status().state,'Waiting for a fresh setup');
  a.e.onEntry(a.ev,a.ctx);assert.equal(status().counts.setup,1);
  assert.equal(status().state,'Waiting for pullback');
  a.confirm();assert.equal(status().state,'Maker order resting');
  assert.equal(status().counts.pullback,1);assert.equal(status().counts.confirmed,1);assert.equal(status().counts.ordered,1);
  const order=a.e.pendingEntries()[0];a.e.onTrade('SOLUSD',100,1,order.at+1000,order.at+1000);
  assert.equal(status().counts.filled,1);assert.equal(status().open,1);
  a.e.onScriptExit(ID,'SOLUSD','15m','close',101,order.at+2000,'both','long');
  const row=a.db.get<{realized_pnl:number;fees:number;risk_amount:number}>('SELECT realized_pnl,fees,risk_amount FROM positions WHERE id=?',order.id)!;
  assert.equal(status().closed,1);assert.equal(status().net,row.realized_pnl-row.fees);
  assert.equal(status().sumR,(row.realized_pnl-row.fees)/row.risk_amount);
  a.cfg.paper.reclaimTrials![0].pullbackAtr=.2;
  assert.equal(status().closed,0);assert.equal(status().counts.filled,undefined);
});
test('reclaim audit retains cancellation reasons after restart and refuses blocked confirmations',t=>{
  const a=setup(t);a.e.onEntry(a.ev,a.ctx);a.confirm();
  const e=new PaperEngine(a.db,()=>a.cfg);
  const v=reclaimStatus(a.db,a.cfg,e,a.ctx.at).trials[0];
  assert.equal(v.counts.cancelled,1);assert.match(v.events[0].reason!,/restart/);
  assert.equal(v.usedToday,1);assert.equal(v.pending.length,0);
  const b=setup(t);b.e.onEntry(b.ev,b.ctx);b.e.risk={gate:()=>({reject:'paused',leverageMult:1}),exposureCheck:()=>null};b.confirm();
  const rejected=reclaimStatus(b.db,b.cfg,b.e,b.ctx.at).trials[0];
  assert.equal(rejected.counts.refused,1);assert.match(rejected.events[0].reason!,/paused/);
});

test('level-only exits preserve reclaim setups, resting orders and positions; script exits still cancel',t=>{
  for(const mode of ['levels','script','both'] as const){
    for(const phase of ['setup','order'] as const){
      const a=setup(t);a.e.onEntry(a.ev,{...a.ctx,exitMode:mode});
      if(phase==='order')a.confirm();
      a.e.onScriptExit(ID,'SOLUSD','15m','close',100,a.ctx.at+1000,mode,'short');
      assert.equal(a.e.pendingEntries().length,1,'opposite side is ignored');
      a.e.onScriptExit(ID,'SOLUSD','15m','close',100,a.ctx.at+2000,mode,'long');
      assert.equal(a.e.pendingEntries().length,mode==='levels'?1:0,`${mode} ${phase}`);
      const audit=reclaimStatus(a.db,a.cfg,a.e,a.ctx.at).trials[0];
      assert.equal(audit.counts.cancelled??0,mode==='levels'?0:1);
    }
  }
  const a=setup(t);a.e.onEntry(a.ev,a.ctx);a.confirm();const order=a.e.pendingEntries()[0];
  a.e.onTrade('SOLUSD',100,1,order.at+1000,order.at+1000);
  assert.equal(a.e.onScriptExit(ID,'SOLUSD','15m','close',100,order.at+2000,'levels','long'),undefined);
  assert.equal(a.e.openPositions().length,1);
});
