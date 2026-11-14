import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool} from '../pine/pool.ts';
import {variantCompatibleSource} from './variantCompat.ts';
import {extractEvents} from './extractor.ts';
import {BASKET_SCANNER,BASKET_MARKER} from '../paper/basket.ts';
const root=new URL('../../../',import.meta.url),raw=fs.readFileSync(new URL('scripts/pine/XuywwObg-RSI-Volume-Ladder.pine',root),'utf8');
const spec=JSON.parse(fs.readFileSync(new URL('scripts/specs.json',root),'utf8'))[BASKET_SCANNER];
const bars=Array.from({length:220},(_,i)=>{const close=100+10*Math.sin(i/18);return {time:1700000000000+i*900000,open:close+.1,high:close+.3,low:close-.3,close,volume:i%7===0?10000:1000};});
test('basket source exposes only the author RSI/volume candidate, causally on source prefixes', {timeout:60000},async t=>{
 const source=variantCompatibleSource(BASKET_SCANNER,raw).source;
 assert.equal(variantCompatibleSource('rsi-volume-ladder',raw).source,raw);
 assert.throws(()=>variantCompatibleSource(BASKET_SCANNER,raw+'\n'),/source changed/);
 const pool=new PinePool(1,20000);t.after(()=>pool.stop());
 const run=async (n:number)=>{const r=await pool.run({scannerId:BASKET_SCANNER,source,symbol:'ETHUSD',tf:'15m',tickSize:.01,bars:bars.slice(0,n),tailBars:'all',plotTail:0});assert.ok(r.ok,r.error);return extractEvents(r.alerts,r.shapes,{...spec,scannerId:BASKET_SCANNER,barMs:900000}).filter(e=>e.kind!=='info');};
 const all=await run(bars.length);assert.ok(all.length>=3);assert.ok(all.every(e=>e.kind==='entry'&&e.side==='long'&&e.label===BASKET_MARKER),JSON.stringify(all.slice(0,3)));
 for(const n of [50,70,90,120,170,200])assert.deepEqual((await run(n)).map(e=>e.barTime),all.filter(e=>e.barTime<=bars[n-1].time).map(e=>e.barTime));
});
