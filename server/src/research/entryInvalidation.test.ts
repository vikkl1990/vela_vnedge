import test from 'node:test';import assert from 'node:assert/strict';
import {invalidationTrigger as trigger,type InvalidationInput} from './entryInvalidation.ts';
const at=1700001000000;
const base:InvalidationInput={side:'long',entryAt:at,entryPrice:100,stop:95,tfMs:60000,actualTriggerAt:at+180000,
 signalBar:{time:at-60000,low:98,high:102,close:100},samples:[{at:at+60000,price:97},{at:at+120000,price:97.5}]};
test('invalidation triggers on received samples, never retrospectively on the signal candle',()=>{
 assert.equal(trigger(base,'signal-wick').at,at+60000);
 assert.equal(trigger(base,'signal-wick-confirmed').at,at+120000);
 assert.equal(trigger({...base,samples:[{at:at-1000,price:90},...base.samples]},'signal-wick').at,at+60000);
 assert.throws(()=>trigger({...base,signalBar:{...base.signalBar,time:at}},'signal-wick'),/non-causal/);
 assert.equal(trigger({...base,actualTriggerAt:at+60000},'signal-wick').status,'unverified');
});
test('a recovered wick resets confirmation and gaps cannot produce a proven result',()=>{
 assert.equal(trigger({...base,actualTriggerAt:at+240000,samples:[{at:at+60000,price:97},{at:at+120000,price:99},{at:at+180000,price:97}]},'signal-wick-confirmed').status,'unchanged');
 assert.equal(trigger({...base,samples:[{at:at+150000,price:97}]},'signal-wick').status,'unverified');
});
test('short invalidation is symmetric and a wick beyond the existing stop offers no earlier exit',()=>{
 assert.equal(trigger({...base,side:'short',stop:105,samples:[{at:at+60000,price:103}]},'signal-wick').at,at+60000);
 assert.equal(trigger({...base,signalBar:{...base.signalBar,low:94}},'signal-wick').status,'inapplicable');
});
test('no-follow-through uses only the running peak and waits two full entry timeframes',()=>{
 const xs=[{at:at+60000,price:98},{at:at+120000,price:98}];
 assert.equal(trigger({...base,samples:xs},'no-follow-through-2bars').at,at+120000);
 assert.equal(trigger({...base,samples:[{at:at+60000,price:102},xs[1]]},'no-follow-through-2bars').status,'unchanged');
 assert.throws(()=>trigger({...base,samples:[xs[1],xs[0]]},'signal-wick-confirmed'),/nonmonotonic/);
});
