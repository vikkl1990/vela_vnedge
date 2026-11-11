import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {PaperEngine} from './engine.ts';
import {passiveMakerPrice} from './makerPricing.ts';

const cell={scannerId:'macd',symbol:'LABUSD',tf:'1h'},H=3600000;
function fixture(t:any,enabled=true){
 const db=new Db(':memory:');t.after(()=>db.db.close());const cfg=structuredClone(DEFAULT_CONFIG);
 Object.assign(cfg.paper,{slippageBps:0,feeRatePct:.05,makerFeeRatePct:.02,liquidation:false,latencyMs:0,minRiskFeeRatio:6,
  useSpread:true,requireQuote:true,quoteMaxAgeMs:10000,skipScriptStops:false,fillSource:'tape',limitFill:'through',
  marginPerTrade:150,maxStopLossPct:3,makerQuoteCells:enabled?[cell]:undefined,
  limitEntry:{enabled:true,tfs:['1h'],atr:.1,bars:2,books:['account','shadow']}});
 const engine=new PaperEngine(db,()=>cfg,{book:2});
 const at=Math.floor(Date.now()/60000)*60000+33512;
 engine.quotes={executable:(_s,side)=>side==='buy'?.03959:.03957};
 const enter=(other:Partial<typeof cell>={})=>engine.onEntry({kind:'entry',side:'short',price:.03976,tp:[],label:'entry',message:'',source:'alert',barTime:at-H,barIndex:0},
  {...cell,...other,scannerName:'MACD',market:{tickSize:.00001,contractValue:1},refPrice:.03976,at,signalId:null,exitMode:'both',atr:.000631872634394561});
 return {db,cfg,engine,at,enter};
}

test('LAB regression: executable bid anchors the offset; unrelated cells retain signal anchor',t=>{
 const f=fixture(t);assert.equal(f.enter().action,'pending');const p=f.engine.pendingEntries()[0];
 assert.equal(p.limit!.price,.03964);assert.equal(p.limit!.quoteAnchor,.03957);assert.equal(p.signalPrice,.03976);
 assert.equal(p.limit!.expiresAt,f.at+2*H);assert.equal(f.cfg.paper.marginPerTrade,150);assert.equal(f.cfg.paper.maxStopLossPct,3);
 const old=fixture(t,false);assert.equal(old.enter().action,'pending');assert.equal(old.engine.pendingEntries()[0].limit!.price,.03983);
 for(const cell of [{scannerId:'other'},{symbol:'OTHERUSD'}]){
  const other=fixture(t);assert.equal(other.enter(cell).action,'pending');assert.equal(other.engine.pendingEntries()[0].limit!.price,.03983);
 }
});

test('both directions retain passive tick rounding even at zero offset',()=>{
 assert.equal(passiveMakerPrice('long',.03959,.1,.000631872634394561,.00001,.03959),.03952);
 assert.equal(passiveMakerPrice('short',.03957,.1,.000631872634394561,.00001,.03957),.03964);
 assert.equal(passiveMakerPrice('long',100,0,1,.1,100),99.9);
 assert.equal(passiveMakerPrice('short',100,0,1,.1,100),100.1);
});

test('new maker policy cannot fall back to an unquoted reference; fees, risk and depth still veto',t=>{
 const f=fixture(t);f.cfg.paper.requireQuote=false;f.engine.quotes={executable:()=>null};
 assert.match(f.enter().reason!,/fresh executable quote/);assert.equal(f.engine.pendingEntries().length,0);
 const fee=fixture(t);fee.cfg.paper.minRiskFeeRatio=100;assert.equal(fee.enter().action,'rejected');
 const risk=fixture(t);risk.engine.risk={gate:()=>({reject:'risk cap',leverageMult:1}),exposureCheck:()=>null};
 assert.match(risk.enter().reason!,/risk cap/);
 const depth=fixture(t);depth.engine.entryDepthGate=()=>({reject:'insufficient depth'});assert.match(depth.enter().reason!,/insufficient depth/);
});

test('quote-anchor orders preserve volume proof and price through restart and later config edits',t=>{
 const f=fixture(t);assert.equal(f.enter().action,'pending');const policy=f.engine.pendingEntries()[0].policy!;
 delete f.cfg.paper.makerQuoteCells;f.cfg.paper.limitEntry!.atr=1;
 const e=new PaperEngine(f.db,()=>f.cfg,{book:2});e.quotes=f.engine.quotes;
 assert.equal(e.pendingEntries()[0].limit!.price,.03964);assert.equal(e.pendingEntries()[0].policy!.id,policy.id);
 const minute=Math.ceil(f.at/60000)*60000;
 for(const [i,volume] of [undefined,0,NaN,-1].entries()){
  e.onBar('LABUSD',{time:minute+i*60000,high:.03976,low:.03976,close:.03976,volume},minute+(i+1)*60000);
  assert.equal(e.openPositions().length,0,'empty or unknown-volume carry-forward must not fill');
 }
 e.onBar('LABUSD',{time:minute+4*60000,high:.03967,low:.03960,close:.03965,volume:1},minute+5*60000);
 assert.equal(e.openPositions().length,1);assert.equal(e.openPositions()[0].entryPrice,.03964);
});

test('quote-anchor tape fills require positive traded quantity and respect expiry',t=>{
 const f=fixture(t);f.enter();
 for(const qty of [0,-1,NaN]){f.engine.onTrade('LABUSD',.03967,qty,f.at+1000,f.at+1000);assert.equal(f.engine.openPositions().length,0);}
 f.engine.onTrade('LABUSD',.03967,1,f.at+2000,f.at+2000);assert.equal(f.engine.openPositions().length,1);
 const expired=fixture(t);expired.enter();expired.engine.onTrade('LABUSD',.03967,1,expired.at+2*H+1,expired.at+2*H+1);
 assert.equal(expired.engine.openPositions().length,0);
});

test('only opted-in cell strategy identity changes; policy validation rejects ambiguous rules',t=>{
 const f=fixture(t,false);const before=f.engine.policyForCell(cell).strategyId;
 const other={...cell,scannerId:'other'},beforeOther=f.engine.policyForCell(other).strategyId;
 f.cfg.paper.makerQuoteCells=[cell];assert.notEqual(f.engine.policyForCell(cell).strategyId,before);
 assert.equal(f.engine.policyForCell(other).strategyId,beforeOther);
 assert.deepEqual(validateConfig(f.cfg).filter(x=>x.includes('makerQuoteCells')),[]);
 f.cfg.paper.makerQuoteCells=[cell,cell];assert.ok(validateConfig(f.cfg).some(x=>x.includes('duplicate paper.makerQuoteCells')));
 f.cfg.paper.makerQuoteCells=[{...cell,tf:'bad'}];assert.ok(validateConfig(f.cfg).some(x=>x.includes('invalid paper.makerQuoteCells')));
 f.cfg.paper.makerQuoteCells=[cell];f.cfg.paper.useSpread=false;assert.ok(validateConfig(f.cfg).some(x=>x.includes('requires executable quotes')));
});
