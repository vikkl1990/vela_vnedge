import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PinePool,processWorker} from './pool.ts';
const file=new URL('../../../scripts/pine/IV6eZF3w-Smart-Money-Breakout-Signals-AlgoAlpha.pine',import.meta.url);
const src=fs.readFileSync(file,'utf8');
const block=src.slice(src.indexOf('// Bot audit:'),src.indexOf('if TPs.size() > 0'));
test('actual Pine accounting: skip entry candle, ordered single hits, terminate every target at stop',async()=>{
 const pool=new PinePool(1,30000,processWorker);
 try{
  for(const [side,bars,expected]of [
   [1,[[110,90],[102,99],[104,99],[104,99]],[1,1,1]],
   [1,[[110,90],[104,94],[110,99]],[0,0,0]],
   [-1,[[110,90],[101,98],[101,96],[101,96]],[1,1,1]],
   [-1,[[110,90],[106,96],[101,90]],[0,0,0]]
  ]as const){
   const source=`//@version=6\nindicator("Accounting")\nvar active = ${side}\nvar active1 = ${side}\nvar active2 = ${side}\nvar tp1s = 0\nvar tp2s = 0\nvar tp3s = 0\nTP = ${side===1?103:97}\nTP1 = ${side===1?102:98}\nTP2 = ${side===1?101:99}\nSL = ${side===1?95:105}\ntrigger = bar_index == 0 ? 1 : 0\n${block}\nplot(tp1s,"first")\nplot(tp2s,"second")\nplot(tp3s,"third")`;
   const r=await pool.run({scannerId:'accounting-test',source,symbol:'BTCUSD',tf:'1m',tickSize:.1,bars:bars.map(([high,low],i)=>({time:1700000000000+i*60000,open:100,close:100,high,low,volume:1})),tailBars:'all',plotTail:10});
   assert.equal(r.ok,true,r.error);assert.deepEqual(['first','second','third'].map(title=>r.plots.find(p=>p.title===title)?.data.at(-1)?.value),expected);
   assert.deepEqual(['first','second','third'].map(title=>r.plots.find(p=>p.title===title)?.data[0]?.value),[0,0,0]);
  }
 }finally{await pool.stop();}
});
