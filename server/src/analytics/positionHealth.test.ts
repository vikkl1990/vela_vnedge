import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {openPosition,fillExit} from '../paper/logic.ts';
import {positionHealth} from './positionHealth.ts';
const T=1800000000000;
const cfg={...DEFAULT_CONFIG.paper,feeRatePct:.05,makerFeeRatePct:.02,feeTaxPct:18,slippageBps:0,quotedSlippageBps:0,depthUsdPerBp:0,liquidation:false,scalperOffer:undefined};
const coverage={entry:'missing' as const,pendingFunding:0,replay:null};
function position(side:'long'|'short'='long'){
 return openPosition({id:1,scannerId:'test',scannerName:'Test',symbol:'ETHUSD',tf:'15m',side,qty:10,contractValue:1,entryPrice:100,
  at:T-60000,sl:side==='long'?95:105,tp:[],riskAmount:51,levelsSource:'script',signalId:null,cfg,bt:false});
}
const book={receivedAt:T-20,exchangeAt:T-40,bids:[{price:102,size:4},{price:101,size:8}],asks:[{price:103,size:10}]};
const near=(a:number|null,b:number)=>assert.ok(a!==null&&Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('close-now walks the correct side at remaining size, includes tax and never mutates the position',()=>{
 const p=position(),before=structuredClone(p),h=positionHealth(p,cfg,book,T,coverage);
 near(h.closeNow.price,101.4);near(h.closeNow.netUsd,14-.59-1014*.00059);
 near(h.closeNow.grossExitFee,1014*.00059);assert.equal(h.closeNow.validForMs,960);assert.deepEqual(p,before);
 const short=positionHealth(position('short'),cfg,book,T,coverage);near(short.closeNow.netUsd,-30-.59-1030*.00059);
});
test('realized partial exits and booked funding are included exactly once',()=>{
 const p=position();fillExit(p,101,4,'tp1',T-20000,cfg,false);p.realizedPnl-=.25;
 p.fills.push({at:T-10000,price:0,qty:0,reason:'funding',pnl:-.25,fee:0});
 const h=positionHealth(p,cfg,book,T,{...coverage,pendingFunding:2});
 near(h.closeNow.price,(4*102+2*101)/6);near(h.closeNow.netUsd,4-.25+10-p.fees-610*.00059);
 assert.equal(h.coverage.pendingFunding,2);assert.equal(h.closeNow.requestedQty,6);assert.equal(p.qtyOpen,6);
});
test('no midpoint fallback on missing, stale, future, crossed or incomplete depth',()=>{
 for(const b of [null,{...book,receivedAt:T-1001},{...book,exchangeAt:T+1},{...book,asks:[{price:102,size:10}]}])
  assert.equal(positionHealth(position(),cfg,b,T,coverage).closeNow.netUsd,null);
 const h=positionHealth(position(),cfg,{...book,bids:[{price:102,size:2}]},T,coverage);
 assert.equal(h.closeNow.netUsd,null);assert.equal(h.closeNow.filledQty,2);assert.equal(h.closeNow.cashExitFee,null);
});
test('current offer discount is separate, and never promised for a future stop',()=>{
 const c={...cfg,scalperOffer:{enabled:true,joinedAt:T-120000,majors:['ETHUSD'],majorsMinutes:30,othersMinutes:15,excluded:[]}};
 const p=position();p.sl=100.01;
 const h=positionHealth(p,c,book,T,coverage);
 near(h.closeNow.cashExitFee,0);near(h.closeNow.feeDiscount,1014*.00059);near(h.closeNow.netUsd,14-p.fees);
 assert.equal(h.stop.state,'profit-level');assert.ok(h.stop.netAtLevel!<0,'above entry does not guarantee net profit');
 const expired=positionHealth(p,c,{...book,receivedAt:T+1800000,exchangeAt:T+1800000},T+1800000,coverage);
 assert.ok(expired.closeNow.cashExitFee!>0);
 const unverified=positionHealth(p,{...c,scalperOffer:{...c.scalperOffer,joinedAt:undefined}},book,T,coverage);
 assert.ok(unverified.closeNow.cashExitFee!>0);
});
test('stop state uses the acknowledged stop; no projection through liquidation',()=>{
 const p=position();assert.equal(positionHealth(p,cfg,book,T,coverage).stop.state,'initial');
 p.sl=98;assert.equal(positionHealth(p,cfg,book,T,coverage).stop.state,'reduced-loss');
 p.sl=100;assert.equal(positionHealth(p,cfg,book,T,coverage).stop.state,'entry-price');
 p.sl=90;p.liqPrice=92;const h=positionHealth(p,cfg,book,T,coverage);
 assert.equal(h.stop.netAtLevel,null);assert.equal(h.stop.liquidationBeforeStop,true);
 p.sl=null;assert.equal(positionHealth(p,cfg,book,T,coverage).stop.state,'none');
});
