import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {runBacktest, type BacktestInput} from './backtest.ts';

const M = 60_000, TF = 15 * M;
function input(side: 'long' | 'short' = 'long'): BacktestInput {
  const bars = Array.from({length: 25}, (_, i) => ({time:i*TF,open:100,high:101,low:99,close:100,volume:1}));
  const subBars = Array.from({length:60}, (_, i) => ({time:21*TF+i*M,open:101,high:102,low:100.5,close:101,volume:1}));
  const cfg = {...structuredClone(DEFAULT_CONFIG.paper),slippageBps:0,feeRatePct:0,makerFeeRatePct:0,minRiskFeeRatio:0,
    liquidation:false,trailAfterR:0,floorAtR:0,breakEvenAfterTp1:false,scalperOffer:undefined};
  return {scannerId:'s',scannerName:'s',symbol:'XUSD',tf:'15m',bars,subBars,cfg,exitMode:'levels',contractValue:1,tickSize:.1,
    entry:{pullbackAtr:0,pullbackBars:1},
    events:[{kind:'entry',side,price:100,sl:side==='long'?95:105,tp:[side==='long'?120:80],barTime:20*TF,barIndex:20,source:'alert',label:'entry',message:''}]};
}

test('ordinary maker replay charges the fill-minute stop without opting into sensitivity mode', () => {
  for (const side of ['long','short'] as const) for (const gap of [false,true]) {
    const x=input(side), stop=side==='long'?95:105, opening=gap?(side==='long'?94:106):100;
    x.bars[21]={time:21*TF,open:opening,high:130,low:70,close:100,volume:1};
    x.subBars![0]={time:21*TF,open:opening,high:130,low:70,close:100,volume:1};
    const r=runBacktest(x);
    assert.equal(r.entries,1);assert.equal(r.trades.length,1);
    assert.equal(r.trades[0].exitReason,'sl');assert.equal(r.trades[0].exitPrice,gap?opening:stop);
    assert.equal(r.trades[0].exitAt,r.trades[0].entryAt);
  }
});

test('minute-confirmed maker replay cannot manufacture a fill from the parent candle', () => {
  for (const minutes of ['different-range','missing','empty'] as const) {
    const x=input();
    if(minutes==='missing')x.subBars=x.subBars!.filter(b=>b.time>=22*TF);
    if(minutes==='empty')x.subBars=[];
    const r=runBacktest(x);
    assert.equal(r.entries,0,minutes);
    assert.ok(r.rejected['resting fill unconfirmed by minute data']>0,minutes);
  }
});

test('a five-minute limit expires inside its signal timeframe; later extremes cannot fill it', () => {
  for (const minute of [4,5,7]) {
    const x=input();x.entry!.pullbackBars=1/3;
    x.subBars![minute]={time:21*TF+minute*M,open:101,high:102,low:99.5,close:101,volume:1};
    const r=runBacktest(x);
    assert.equal(r.entries,minute===4?1:0,`minute ${minute}`);
  }
});

test('a candle spanning expiry cannot prove a fill before the deadline', () => {
  const x=input();x.entry!.pullbackBars=4.5/15;
  x.subBars![4]={time:21*TF+4*M,open:101,high:102,low:99.5,close:101,volume:1};
  assert.equal(runBacktest(x).entries,0);
  const coarse=input();delete coarse.subBars;coarse.entry!.pullbackBars=1/3;
  assert.equal(runBacktest(coarse).entries,0,'a whole 15m bar cannot locate a fill within five minutes');
});
