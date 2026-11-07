import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Db} from '../db.ts';
import {DepthRecorder,crc32} from '../execution/depthRecorder.ts';
import {evaluateDepthExit,quoteExitSensitivity} from './executionValidation.ts';
const T=1_800_000_000_000;
const book={receivedAt:T,exchangeAt:T-50,bids:[{price:99,size:2},{price:98,size:3}],asks:[{price:101,size:2},{price:102,size:3}]};
const request={side:'long' as const,qty:4,contractValue:.01,at:T,maxAgeMs:1000,book,feeRatePct:.05,feeTaxPct:18};
test('long exits sell bids and short exits buy asks, walking contract quantities',()=>{
 const sell=evaluateDepthExit(request),buy=evaluateDepthExit({...request,side:'short'});
 assert.equal(sell.price,98.5);assert.equal(buy.price,101.5);assert.equal(sell.status,'complete');
 assert.ok(Math.abs(sell.fee!-(98.5*4*.01*.0005*1.18))<1e-12);
});
test('insufficient depth exposes remainder rather than inventing a full exit',()=>{
 const r=evaluateDepthExit({...request,qty:10});assert.equal(r.status,'partial');assert.equal(r.filledQty,5);assert.equal(r.remainingQty,5);assert.equal(r.coverage,.5);
});
test('stale, future, missing, crossed, duplicate and malformed books stay unpriced',()=>{
 for(const b of [null,{...book,receivedAt:T+1},{...book,exchangeAt:T+1},{...book,exchangeAt:T-1001},{...book,bids:[]},{...book,bids:[{price:103,size:1}]},{...book,bids:[{price:99,size:1},{price:99,size:2}]},{...book,asks:[{price:101,size:NaN}]}])assert.equal(evaluateDepthExit({...request,book:b}).status,'unpriced');
 for(const patch of [{qty:NaN},{qty:1.2},{qty:0},{feeRatePct:-1},{feeTaxPct:NaN},{contractValue:0},{at:NaN},{maxAgeMs:Infinity}])assert.equal(evaluateDepthExit({...request,...patch}).status,'unpriced');
});
test('quote sensitivity accounts for both sides, effective fees and unknown quote coverage',()=>{
 const base={side:'long' as const,qty:2,contractValue:1,price:100,fee:.118,at:T,bid:99,ask:101,quoteAt:T-50,maxAgeMs:1000};
 const r=quoteExitSensitivity(base)!;assert.equal(r.grossDelta,-2);assert.ok(Math.abs(r.netDelta-(-1.99882))<1e-10);
 assert.equal(quoteExitSensitivity({...base,side:'short'})!.grossDelta,-2);
 assert.equal(quoteExitSensitivity({...base,fee:0})!.feeDelta,0);
 for(const patch of [{quoteAt:T+1},{quoteAt:T-1001},{bid:null},{bid:102},{price:0},{at:NaN}])assert.equal(quoteExitSensitivity({...base,...patch}),null);
});
test('validated books cannot be read before arrival or after gap, and views are detached',t=>{
 const db=new Db(':memory:');t.after(()=>db.db.close());const r=new DepthRecorder(db,['BTCUSD']);
 const snap={sy:'BTCUSD',action:'snapshot',seq:1,ts:T*1000,a:[['101','3']],b:[['99','2']],cs:crc32('101:3|99:2')};
 r.onDepth(snap,T+50);assert.equal(r.bookAt('BTCUSD',T),null);assert.equal(r.bookAt('BTCUSD',T+1001),null);
 const view=r.bookAt('BTCUSD',T+51)!;assert.equal(view.bids[0].price,99);view.bids[0].price=0;assert.equal(r.bookAt('BTCUSD',T+51)!.bids[0].price,99);
 r.onDepth({...snap,action:'update',seq:3},T+60);assert.equal(r.bookAt('BTCUSD',T+61),null);
 r.onDepth({...snap,seq:4,ts:(T+70)*1000},T+70);assert.ok(r.bookAt('BTCUSD',T+71));r.disconnect(T+72);assert.equal(r.bookAt('BTCUSD',T+73),null);
});
