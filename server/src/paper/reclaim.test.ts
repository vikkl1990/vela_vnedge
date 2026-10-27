import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReclaim, advanceReclaim} from './reclaim.ts';
import {runBacktest} from './backtest.ts';
import {DEFAULT_CONFIG} from '../config.ts';
import type {Bar} from '../data/candleStore.ts';

const M = 60_000, T = Date.UTC(2026, 0, 1);
const candle = (i: number, open: number, high: number, low: number, close: number): Bar => ({time: T + i*M, open, high, low, close, volume: 1});
const make = () => createReclaim({side:'long', at:T, reference:100, atr:2, stop:97, tick:.01}, {pullbackAtr:.1, setupMinutes:10, orderMinutes:2});
const pullback = candle(0,100,100.1,99.5,99.8), reclaim = candle(1,99.8,100.5,99.7,100.3), fill = candle(2,100.3,100.6,100,100.2);
test('reclaim uses separate closed candles and never fills in the reclaim minute', () => {
  const s = make();
  assert.equal(advanceReclaim(s, pullback, T+M-1).kind,'waiting');
  assert.equal(s.phase,'pullback');
  assert.equal(advanceReclaim(s, {...pullback,time:T-M}, T).kind,'waiting');
  assert.equal(advanceReclaim(s,pullback,T+M).kind,'waiting');
  assert.equal(s.phase,'reclaim');
  assert.equal(advanceReclaim(s,reclaim,T+2*M).kind,'placed');
  assert.equal(s.placedAt,T+2*M);
  assert.equal(advanceReclaim(s,reclaim,T+2*M).kind,'waiting');
  assert.deepEqual(advanceReclaim(s,fill,T+3*M),{kind:'filled',price:100.1,stop:97,at:T+2*M});
});
test('short reclaim is symmetric, structural stop uses only the observed pullback', () => {
  const s = createReclaim({side:'short',at:T,reference:100,atr:2,stop:103,tick:.01},{pullbackAtr:.1,setupMinutes:10,orderMinutes:2,structuralStop:true,stopBufferAtr:.05});
  const mirror = (b:Bar):Bar => ({...b,open:200-b.open,high:200-b.low,low:200-b.high,close:200-b.close});
  advanceReclaim(s,mirror(pullback),T+M);
  assert.equal(advanceReclaim(s,mirror(reclaim),T+2*M).kind,'placed');
  const r = advanceReclaim(s,mirror(fill),T+3*M);
  assert.equal(r.kind,'filled');
  if(r.kind==='filled'){assert.equal(r.price,99.9);assert.equal(r.stop,100.6);}
});
test('reclaim invalidation, data gaps, TTL and through-versus-touch are explicit', () => {
  assert.equal(advanceReclaim(make(),candle(0,100,101,96,99),T+M).kind,'cancelled');
  assert.deepEqual(advanceReclaim(make(),reclaim,T+2*M),{kind:'cancelled',reason:'minute data gap'});
  const s=make();advanceReclaim(s,pullback,T+M);advanceReclaim(s,reclaim,T+2*M);
  assert.equal(advanceReclaim(s,{...fill,low:100.1},T+3*M).kind,'waiting');
  assert.equal(advanceReclaim(s,candle(3,100.3,100.6,100.2,100.4),T+4*M).kind,'waiting');
  assert.deepEqual(advanceReclaim(s,candle(4,100.4,100.5,99,100),T+5*M),{kind:'cancelled',reason:'order expired'});
  const z=make();advanceReclaim(z,pullback,T+M);advanceReclaim(z,reclaim,T+2*M);
  assert.equal(advanceReclaim(z,{...fill,low:100.1},T+3*M,false).kind,'filled');
  const exp=make();exp.options.setupMinutes=2;
  advanceReclaim(exp,candle(0,100,100.1,100,100),T+M);
  advanceReclaim(exp,candle(1,100,100.1,100,100),T+2*M);
  assert.deepEqual(advanceReclaim(exp,candle(2,100,100.1,100,100),T+3*M),{kind:'cancelled',reason:'setup expired'});
});
test('invalid reclaim parameters cannot silently fall back to immediate entries', () => {
  assert.throws(()=>createReclaim({...make(),atr:NaN},make().options),/invalid/);
  assert.throws(()=>createReclaim(make(),{...make().options,orderMinutes:0}),/invalid/);
});

function replay(fillMinuteStop=false) {
  const bars=Array.from({length:24},(_,i)=>({...candle(i*15,100,101,99,100)}));
  const sub=Array.from({length:24*15},(_,i)=>candle(i,100,100.1,99.9,100));
  const start=21*15;
  sub[start]={...pullback,time:T+start*M}; sub[start+1]={...reclaim,time:T+(start+1)*M};
  sub[start+2]={...fill,time:T+(start+2)*M,...(fillMinuteStop?{high:200,low:96}:{})};
  sub[start+3]=candle(start+3,100,100.1,96,98);
  const cfg={...structuredClone(DEFAULT_CONFIG.paper),slippageBps:0,feeRatePct:0,makerFeeRatePct:0,minRiskFeeRatio:0,maxStopLossPct:0,liquidation:false,trendGate:{enabled:false,mode:'follow' as const,emaLen:21,tf:'15m'}};
  return {scannerId:'s',scannerName:'s',symbol:'ETHUSD',tf:'15m',bars,subBars:sub,cfg,exitMode:'both' as const,contractValue:1,tickSize:.01,
    events:[{kind:'entry' as const,side:'long' as const,price:100,tp:[],label:'entry',message:'',source:'alert' as const,barTime:bars[20].time,barIndex:20}],
    entry:{reclaim:{pullbackAtr:.1,setupMinutes:10,orderMinutes:2}}};
}
test('minute reclaim replay opens only after confirmation and charges a same-minute stop before any target', () => {
  for(const sameMinute of [false,true]) {
    const r=runBacktest(replay(sameMinute));
    assert.equal(r.entries,1); assert.equal(r.trades.length,1);
    assert.equal(r.trades[0].entryAt,T+(21*15+2)*M);
    assert.equal(r.trades[0].exitReason,'sl');
    assert.ok(r.trades[0].rMultiple! < 0);
    assert.equal(r.entryFlow?.fills,1);
    assert.equal(r.entryFlow?.['fill minute stop']??0,sameMinute?1:0);
  }
  assert.throws(()=>runBacktest({...replay(),subBars:undefined}),/requires minute/);
  assert.throws(()=>runBacktest({...replay(),entry:{...replay().entry,pullbackAtr:.1}}),/combined/);
});
test('reclaim time exit closes a stalled position at the completed minute close', () => {
  const inp=replay();
  for(let i=21*15+3;i<inp.subBars.length;i++) inp.subBars[i]=candle(i,100.2,100.25,100.15,100.2);
  const r=runBacktest({...inp,entry:{reclaim:{...inp.entry.reclaim,maxHoldMinutes:5}}});
  assert.equal(r.trades.length,1);
  assert.equal(r.trades[0].exitReason,'scalp_time');
  assert.equal(r.trades[0].exitAt!-r.trades[0].entryAt,5*M);
  assert.equal(r.trades[0].setupAt,T+21*15*M);
});
test('common conservative maker control charges a fill-minute stop too', () => {
  const inp=replay();
  inp.subBars[21*15]=candle(21*15,100,200,96,100);
  const r=runBacktest({...inp,conservativeEntryMinute:true,entry:{pullbackAtr:.1,pullbackBars:1}});
  assert.equal(r.trades.length,1);
  assert.equal(r.trades[0].exitReason,'sl');
  assert.equal(r.trades[0].exitAt,r.trades[0].entryAt);
  assert.ok(r.trades[0].rMultiple!<0);
});
