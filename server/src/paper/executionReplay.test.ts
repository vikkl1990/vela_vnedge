import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../config.ts';
import { compareExecution, type ExecutionObservation } from './executionReplay.ts';
const T=1792950480000;
function fixture(){
  const config=structuredClone(DEFAULT_CONFIG);
  Object.assign(config.paper,{feeRatePct:0,makerFeeRatePct:0,slippageBps:0,liquidation:false,useSpread:false,latencyMs:0,maxSignalAgeSec:0,maxStopLossPct:0});
  const entry:ExecutionObservation={kind:'entry',at:T+1000,signal:{kind:'entry',side:'long',price:100,sl:95,tp:[105,110,115],label:'entry',message:'',source:'alert',barTime:T,barIndex:0},context:{scannerId:'audit',scannerName:'audit',symbol:'BTCUSD',tf:'15m',market:{tickSize:.25,contractValue:1},refPrice:100,at:T+1000,signalId:null,exitMode:'both'}};
  const trade=(offset:number,price:number):ExecutionObservation=>({kind:'trade',at:T+offset,trade:{symbol:'BTCUSD',price,qty:1000,timeMs:T+offset,aggressor:'sell'}});
  return{config,entry,trade};
}
test('receipt-ordered replay exposes candle/tape stop differences without changing configuration',()=>{
  const {config,entry,trade}=fixture(),before=structuredClone(config);
  const events=[entry,trade(2000,100),trade(3000,94),trade(3000,94)];
  const [candles,tape]=compareExecution(config,events);
  assert.equal(candles.open,1);assert.equal(tape.open,0);
  assert.equal(tape.fills.filter(f=>f.reason==='sl').length,1,'replayed duplicate cannot close twice');
  assert.equal(tape.fills.filter(f=>f.reason==='entry').length,1);
  assert.deepEqual(config,before);
  assert.deepEqual(compareExecution(config,events),[candles,tape],'deterministic repeat');
});
test('replay preserves arrival order, rejects backwards receipt clocks and ignores delayed older prints',()=>{
  const {config,entry,trade}=fixture();
  const stale=trade(3000,94);if(stale.kind==='trade')stale.trade.timeMs=T+1500;
  const result=compareExecution(config,[entry,trade(2000,100),stale]);
  assert.equal(result[1].open,1,'pre-entry/out-of-order print cannot stop the position');
  assert.throws(()=>compareExecution(config,[trade(2000,100),entry]),/receipt time/);
});
