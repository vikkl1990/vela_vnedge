import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import {IncubatorStore} from '../incubator/store.ts';
import {signalActivity,filledEntries,proposalTimes,sizingDescription} from './uiMetrics.ts';
import {positionView} from '../paper/engine.ts';
import {exitConfigFor} from '../paper/logic.ts';
import {quantityText,targetR,protectionText} from '../../../dashboard/src/lib/protection.ts';

test('activity counts the full rolling window, excluding exits and future events',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const now=2*86400000;
 const add=(at:number,kind:string)=>db.run("INSERT INTO signals(at,bar_time,scanner_id,scanner_name,symbol,tf,kind,label,message,source,action) VALUES(?,?,'s','s','ETHUSD','15m',?,'x','','alert','opened')",at,at,kind);
 for(let i=0;i<111;i++)add(now-i,'entry');
 add(now-86400001,'entry');add(now+1,'entry');add(now-200,'exit');
 assert.equal(signalActivity(db,now).entries,111);
 assert.equal(signalActivity(db,now+86400001).entries,1);
});
test('filled entries exclude pending, voided and other books, including across restart',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());
 for(const [status,book,at,qty] of [['open',2,20,1],['closed',2,30,1],['pending',2,40,0],['voided',2,40,1],['open',0,20,1],['closed',2,9,1]] as const)
 db.run("INSERT INTO positions(status,scanner_id,scanner_name,symbol,tf,side,qty,qty_open,contract_value,entry_price,entry_at,bt) VALUES(?,'s','s','ETHUSD','1h','long',?,0,1,100,?,?)",status,qty,at,book);
 assert.equal(filledEntries(db,2,10,50),2);assert.equal(filledEntries(db,2,25,50),1);
});
test('proposal time is the latest stage transition, not preserved evidence or rejudging',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const store=new IncubatorStore(db),key={scannerId:'s',symbol:'ETHUSD',tf:'1h'};
 const p=store.move(key,'live','test',null,null,100);store.move(key,'demote_proposed','test',null,null,200,{keepSince:true});
 store.move(key,'demote_proposed','test',null,null,300);store.restartEvidence(p.id,'test','new evidence',400);
 assert.equal(proposalTimes(db).get(p.id),200);
 store.move(key,'live','test',null,null,500);store.move(key,'demote_proposed','test',null,null,600,{keepSince:true});assert.equal(proposalTimes(db).get(p.id),600);
});
test('sizing descriptions follow the mode without changing the margin budget',()=>{
 const c=structuredClone(DEFAULT_CONFIG.paper);Object.assign(c,{sizingMode:'margin',marginPerTrade:150,riskPerTradePct:1,maxStopLossPct:3});
 assert.match(sizingDescription(c),/\$150 margin budget/);assert.doesNotMatch(sizingDescription(c),/1% of equity/);assert.match(sizingDescription(c),/3% of equity/);
 c.sizingMode='risk';assert.match(sizingDescription(c),/Risk sizing · 1%/);c.sizingMode='quality';assert.match(sizingDescription(c),/Quality sizing/);
});
test('position explanation follows effective overrides, trail steps and actual target R',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG.paper);cfg.exitByTf={'1h':{floorAtR:0.7}};cfg.exitBySymbol={ETHUSD:{trailAfterR:1}};
 const effective=exitConfigFor(cfg,'ETHUSD',{trailGiveBackPct:10,trailSteps:[[2,8],[4,6]]},'1h');
 const p:any={id:1,side:'long',entryPrice:100,slOriginal:90,sl:90,qty:33,qtyOpen:20,contractValue:.01,realizedPnl:0,fees:0,riskAmount:3.3,tp:[158],tpHit:[false],legs:[20],peakR:4,peakAt:100,marginLeverage:5,fills:[]};
 const view=positionView(p,110,null,effective,100) as any;
 assert.equal(view.protection.floorAtR,.7);assert.equal(view.protection.trailAfterR,1);assert.equal(view.protection.keepPct,94);
 assert.equal(targetR(view,158),5.8);assert.equal(quantityText(33,.01),'0.33');assert.equal(quantityText(1,.1),'0.1');assert.equal(quantityText(view.qtyOpen,view.contractValue),'0.2');
 assert.match(protectionText(view),/94.0%/);assert.equal(view.notional,22);
});
