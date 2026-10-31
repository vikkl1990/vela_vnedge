import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeMarketOrder} from './probeOrder.ts';
test('quiet probes rotate through the universe rather than permanently testing the same first three',()=>{
 const markets=['BTC','ETH','SOL','XRP','DOGE','ADA','LINK'],seen=new Map<string,number>();
 const first=probeMarketOrder(markets,seen).slice(0,3);first.forEach(m=>seen.set(m,100));
 assert.deepEqual(first,['BTC','ETH','SOL']);
 const second=probeMarketOrder(markets,seen).slice(0,3);assert.deepEqual(second,['XRP','DOGE','ADA']);second.forEach(m=>seen.set(m,200));
 assert.deepEqual(probeMarketOrder(markets,seen).slice(0,3),['LINK','BTC','ETH']);assert.deepEqual(markets,['BTC','ETH','SOL','XRP','DOGE','ADA','LINK']);
});
