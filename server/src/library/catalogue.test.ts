import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanCatalogue} from './catalogue.ts';
import {AUTHORS} from './sync.ts';
test('daily catalogue covers MarkitTick, deduplicates pages and never fetches private source',async()=>{
 assert.ok(AUTHORS.includes('MarkitTick'));
 const row={script_id_part:'PUB;1',chart_url:'https://www.tradingview.com/script/a/',name:'a',updated_at:'2026-11-20',script_access:1};
 const seen:string[]=[];const fetcher=async(url:string)=>{seen.push(url);return JSON.stringify({results:[row],next:new URL(url).searchParams.get('page')==='1'});};
 const a=await scanCatalogue([],fetcher,undefined,['MarkitTick']);assert.equal(a.publications.length,1);assert.equal(a.changes[0].kind,'not-installed');
 const b=await scanCatalogue([],fetcher,a,['MarkitTick']);assert.deepEqual(b.changes,[]);
 row.script_access=2;const c=await scanCatalogue([],fetcher,b,['MarkitTick']);assert.equal(c.changes[0].kind,'metadata-changed');
 assert.ok(seen.every(url=>url.includes('/api/v1/scripts/')));
});
test('unavailable and incomplete catalogues stay explicit and preserve last observed metadata',async()=>{
 const a=await scanCatalogue([],async()=>JSON.stringify({results:[{script_id_part:'PUB;1',chart_url:'url',name:'a',script_access:1}],next:false}),undefined,['WillyAlgoTrader']);
 for(const fetcher of [async()=>{throw Error('HTTP 429');},async()=>JSON.stringify({results:[],next:true}),async()=>JSON.stringify({})]){
  const b=await scanCatalogue([],fetcher,a,['WillyAlgoTrader']);assert.equal(b.complete,false);assert.equal(b.issues.length,1);assert.deepEqual(b.publications,a.publications);assert.deepEqual(b.changes,[]);
 }
});
