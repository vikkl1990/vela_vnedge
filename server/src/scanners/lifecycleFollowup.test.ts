import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractEvents} from './extractor.ts';
import {PinePool} from '../pine/pool.ts';
import {DEFAULT_CONFIG,validateConfig} from '../config.ts';
import {strategyIdentity} from './identity.ts';
import {scannerExitPolicy} from '../paper/policy.ts';
import {exitConfigFor} from '../paper/logic.ts';
const root=new URL('../../../',import.meta.url);
const specs=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'));
const cases=[
 ['reactive-trail-system-author-native','73fIFFEV-Reactive-Trail-System-WillyAlgoTrader.pine'],
 ['reaction-level-matrix-author-native','kcyXDIFe-Reaction-Level-Matrix-WillyAlgoTrader.pine'],
 ['strat-trap-vwap-engine-author-native','ngb1s23R-STRAT-Trap-VWAP-Engine-WillyAlgoTrader.pine'],
 ['smart-swing-vwap-zeiierman-author-retests','K0dz3kws-Smart-Swing-VWAP-Zeiierman.pine'],
];
const a=(message:unknown)=>({type:'alert' as const,time:900000,barIndex:10,message:typeof message==='string'?message:JSON.stringify(message)});
const read=(id:string,m:unknown)=>extractEvents([a(m)],[],{scannerId:id,...specs[id]});
const native=(base:string,m:unknown)=>read(base+'-author-native',m);

test('new native profiles are disabled and separate, preserve $150 sizing and risk, and use author milestone allocations',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG);cfg.paper.marginPerTrade=150;
 cfg.paper.floorAtR=.3;cfg.paper.trailAfterR=.5;cfg.paper.breakEvenAfterTp1=true;cfg.paper.staleBars=10;
 const fixed=JSON.stringify([cfg.paper,cfg.risk]);
 for(const [id] of cases){
  cfg.scanners[id]={symbols:null,timeframes:null,...specs[id]};assert.equal(cfg.scanners[id].enabled,false);
  const base=id.replace(/-author-(native|retests)$/,'');
  cfg.scanners[base]={enabled:false,symbols:null,timeframes:null,exitMode:'both',...specs[base]};
  assert.notEqual(strategyIdentity('same source',cfg,base),strategyIdentity('same source',cfg,id));
  if(specs[id].reader===3){
   assert.equal(specs[id].entryProtection,'native');
   const exit=exitConfigFor(cfg.paper,'ETHUSD',scannerExitPolicy(cfg,id),'15m');
   assert.deepEqual(exit.tpSplit,[0,0,1]);assert.equal(exit.scriptTargets,'use');
   assert.equal(exit.floorAtR,0);assert.equal(exit.trailAfterR,0);assert.equal(exit.breakEvenAfterTp1,false);assert.equal(exit.staleBars,0);
  }
 }
 assert.deepEqual(validateConfig(cfg),[]);assert.equal(JSON.stringify([cfg.paper,cfg.risk]),fixed);
});

test('Reactive native BE amendment parses entry wording, reversal closes old side, filtered flips never enter',()=>{
 const base='reactive-trail-system';
 const m='🛡️ BREAK-EVEN | ETHUSD | SL moved to entry: 100.25';
 assert.deepEqual(native(base,m).map(e=>[e.kind,e.exitType,e.price]),[['exit','stop_update',100.25]]);
 assert.equal(extractEvents([a(m)],[],{scannerId:base,reader:1})[0].kind,'info','legacy is unchanged');
 for(const [dest,closed] of [['LONG','short'],['SHORT','long']]){
  const e=native(base,'🔄 REVERSAL → '+dest+' | ETHUSD | TF: 15 | Closed before TP1 (loss)')[0];
  assert.equal(e.exitType,'flip');assert.equal(e.side,closed);
 }
 for(const m of ['▲ BULL FLIP | Entry filtered','▼ BEAR FLIP | Entry filtered'])assert.equal(native(base,m)[0].kind,'info');
 const packet={action:'buy',price:100,sl:99,tp1:101,tp2:102,tp3:103};
 assert.equal(native(base,packet)[0].kind,'entry');
 assert.deepEqual(native(base,'🟢 LONG | Price: 100 | SL: 99 | TP1: 101 | TP2: 102 | TP3: 103')[0].tp,[101,102,103]);
 assert.equal(native(base,'🛡️ BE STOP-OUT | Long | Entry: 100 | SL: 100')[0].exitType,'be');
});

test('Reaction level breaks remain context; entry, BE and old-side reversal retain native geometry',()=>{
 const base='reaction-level-matrix';
 for(const d of ['UP','DOWN'])assert.equal(native(base,'LEVEL BROKEN '+d+' | Price: 100 | Now support')[0].kind,'info');
 assert.equal(native(base,'🟢 LONG | Price: 100 | Score: 70/100 | SL: 99 | TP1: 101 | TP2: 102 | TP3: 103')[0].kind,'entry');
 assert.equal(native(base,'🔄 REVERSAL | ETHUSD | TF: 15 | Long → Short | Exit: 100')[0].side,'long');
 assert.equal(native(base,'🛡️ BREAK-EVEN | ETHUSD | Long | SL moved to 100')[0].price,100);
});

test('STRAT admits only confirmed full-risk entries; setup, filtered trigger and unsupported schemas cannot trade',()=>{
 const base='strat-trap-vwap-engine',p={ind:'STRAT',v:'1.9.0',action:'trap_long',entry:100,sl:99,tp1:101,tp2:102,tp3:103};
 assert.equal(native(base,p)[0].side,'long');
 assert.equal(native(base,{...p,action:'trigger_bull'})[0].kind,'entry');
 assert.equal(native(base,{...p,action:'trap_short',sl:101,tp1:99,tp2:98,tp3:97})[0].side,'short');
 for(const m of [{...p,action:'buy'},{...p,action:'setup_bull'},{ind:'STRAT',v:'1.9.0',action:'trigger_bull',price:100,trig:99,stop:98},{...p,v:'2.0.0'},{...p,ind:'OTHER'},'STRAT TRAP_LONG @ 100 | SL 99'])assert.equal(native(base,m)[0].kind,'info');
 assert.equal(native(base,{ind:'STRAT',v:'1.9.0',action:'be',entry:100,sl:100})[0].exitType,'stop_update');
 assert.equal(native(base,{ind:'STRAT',v:'1.9.0',action:'sl_hit',dir:'short',sl:100,be_stop:true})[0].exitType,'be');
 assert.equal(native(base,{ind:'STRAT',v:'1.9.0',action:'tp3_close',dir:'long',level:103})[0].exitType,'tp3');
});

test('Smart Swing retest variant excludes crosses and flips while the current reader retains them',()=>{
 const id=cases[3][0],base='smart-swing-vwap-zeiierman';
 const titles=['Bullish AVWAP retest','Bearish AVWAP retest','Cross above AVWAP','Cross below AVWAP','Bullish polarity flip','Bearish polarity flip','New ranked anchor','Any ranked AVWAP event'];
 const alerts=titles.map((title,i)=>({type:'alertcondition' as const,title,message:title,time:900000*(i+1),barIndex:i+1}));
 assert.deepEqual(extractEvents(alerts,[],{scannerId:id,...specs[id]}).map(e=>e.side),['long','short']);
 assert.equal(extractEvents(alerts,[],{scannerId:base,...specs[base]}).filter(e=>e.kind==='entry').length,6);
});

test('four actual Pine sources compile and configured readers observe source entries without context entries', {timeout:120000},async t=>{
 const pool=new PinePool(1,30000);t.after(()=>pool.stop());
 const bars=Array.from({length:700},(_,i)=>{const c=100+12*Math.sin(i/20)+4*Math.sin(i/6)+Math.sin(i*1.7),o=100+12*Math.sin((i-1)/20)+4*Math.sin((i-1)/6);return {time:1700000100000+i*900000,open:o,high:Math.max(o,c)+.5,low:Math.min(o,c)-.5,close:c,volume:1000+700*Math.sin(i/13)**2};});
 for(const [id,file] of cases){
  const source=fs.readFileSync(new URL('scripts/pine/'+file,root),'utf8');
  const r=await pool.run({scannerId:id,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars,tailBars:'all',plotTail:0,inputs:specs[id].inputs});
  assert.equal(r.ok,true,`${id}: ${r.error}`);
  const events=extractEvents(r.alerts,r.shapes,{scannerId:id,...specs[id]});
  assert.ok(events.some(e=>e.kind==='entry'),`${id}: no source entries`);
  if(specs[id].reader===3){
   assert.ok(events.some(e=>e.kind==='exit'&&e.exitType!=='stop_update'),`${id}: no exits`);
   assert.ok(!events.some(e=>/Unsupported|invalid native geometry|Invalid author stop amendment/.test(e.label)),`${id}: malformed events`);
   for(const e of events.filter(e=>e.kind==='entry'))assert.equal(e.tp.length,3);
  }
 }
});
