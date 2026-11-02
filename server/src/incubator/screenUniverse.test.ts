import {test} from 'node:test';
import assert from 'node:assert/strict';
import {screenUniverse} from './screenUniverse.ts';
const tickers=['XRPUSD','LINKUSD','DOGEUSD'].map((symbol,i)=>({symbol,contract_type:'perpetual_futures',turnover_usd:3e6-i*1e6}));
const opts={freshDepth:false,onlyMarkets:null,top:1,floor:1e6};
test('a complete all-refused market assessment cannot fall back to turnover',()=>{
  const today={enabled:true,markets:tickers.map(t=>({symbol:t.symbol,allowed:false,reasons:['dead: below floor']}))} as any;
  assert.deepEqual(screenUniverse(tickers,{...opts,today}).symbols,[]);
});
test('explicit pair batches are not silently cut by the normal top-N limit',()=>{
  assert.deepEqual(screenUniverse(tickers,{...opts,onlyMarkets:new Set(['LINKUSD','DOGEUSD'])}).symbols,['LINKUSD','DOGEUSD']);
});
test('fresh-depth screening removes only cached book refusals, not turnover or other restrictions',()=>{
  const today={enabled:true,markets:[{symbol:'XRPUSD',allowed:false,reasons:['costly book: yesterday']},{symbol:'LINKUSD',allowed:false,reasons:['costly book: yesterday','dead: below floor']},{symbol:'DOGEUSD',allowed:false}]} as any;
  assert.deepEqual(screenUniverse(tickers,{...opts,today,freshDepth:true,top:10}).symbols,['XRPUSD']);
});
test('fallback discovery excludes non-crypto instruments and low turnover',()=>{
  const ts=[...tickers,{symbol:'GOLDUSD',description:'Gold Token',contract_type:'perpetual_futures',turnover_usd:9e6},{symbol:'DUSTUSD',contract_type:'perpetual_futures',turnover_usd:1}];
  assert.deepEqual(screenUniverse(ts,{...opts,top:10}).symbols,tickers.map(t=>t.symbol));
});
