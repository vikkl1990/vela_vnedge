import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigStore,DEFAULT_CONFIG} from '../config.ts';
import {BASKET_SHADOW_PLAN,enableBasketShadow} from '../../../ops/enable-basket-shadow.ts';
import {BASKET_SCANNER} from './basket.ts';
import {MAX_RESEARCH_PLANS,planSnapshot} from './executionPlans.ts';
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'basket-activate-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),raw=structuredClone(DEFAULT_CONFIG);
 raw.execution.mode='paper';raw.paper.sizingMode='margin';raw.paper.marginPerTrade=150;raw.paper.maxStopLossPct=3;raw.incubator.enabled=true;
 raw.executionPlans=Array.from({length:36},(_,i)=>({id:`prior-${i}`,revision:1,enabled:true,scannerId:'control',symbol:'BTCUSD',tf:'15m',variant:'current',referenceEquity:1000}));
 fs.writeFileSync(file,JSON.stringify(raw));return {file,raw,dir};
}
test('basket activation adds exactly one experimental plan to 36, without altering any prior plan or protected setting',t=>{
 const {file,raw,dir}=fixture(t),original=fs.readFileSync(file,'utf8');
 const dry=enableBasketShadow(file,true);assert.equal(dry.totalPlans,37);assert.equal(fs.readFileSync(file,'utf8'),original);
 const result=enableBasketShadow(file);assert.equal(result.changed,true);
 const next=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(next.executionPlans.slice(0,36),raw.executionPlans);assert.deepEqual(next.executionPlans[36],BASKET_SHADOW_PLAN);
 assert.deepEqual({...next,executionPlans:raw.executionPlans},raw);
 const cfg=new ConfigStore(file).get(),snap=planSnapshot(cfg,BASKET_SHADOW_PLAN);
 assert.equal(cfg.scanners[BASKET_SCANNER].enabled,false);assert.equal(snap.basketAccountingVersion,2);assert.equal(snap.partialExitVersion,1);
 assert.equal(snap.paper.marginPerTrade,150);assert.equal(snap.paper.maxStopLossPct,3);assert.equal(snap.paper.scalperOffer?.enabled,false);
 const bytes=fs.readFileSync(file,'utf8'),files=fs.readdirSync(dir),mtime=fs.statSync(file).mtimeMs;
 assert.equal(enableBasketShadow(file).changed,false);assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.deepEqual(fs.readdirSync(dir),files);assert.equal(fs.statSync(file).mtimeMs,mtime);
});
test('activation refuses wrong capital, edited plans, edited readers and a genuinely full research registry',t=>{
 for(const kind of ['mode','margin','cap','reader','plan','full']){
  const {file,raw}=fixture(t);
  if(kind==='mode')raw.execution.mode='dry-run';
  if(kind==='margin')raw.paper.marginPerTrade=151;
  if(kind==='cap')raw.paper.maxStopLossPct=4;
  if(kind==='reader')raw.scanners[BASKET_SCANNER]={enabled:false,symbols:null,timeframes:null,exitMode:'levels',inputs:{rsiLength:2}};
  if(kind==='plan')raw.executionPlans!.push({...BASKET_SHADOW_PLAN,symbol:'BTCUSD'});
  if(kind==='full')raw.executionPlans!.push({...raw.executionPlans![0],id:'last-existing-slot'});
  fs.writeFileSync(file,JSON.stringify(raw));const bytes=fs.readFileSync(file,'utf8');
  if(kind==='full')assert.throws(()=>enableBasketShadow(file),new RegExp(String(MAX_RESEARCH_PLANS)));else assert.throws(()=>enableBasketShadow(file));
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
 }
});
