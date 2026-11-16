import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchFits,parseResearchCells,researchCellKey} from './researchFit.ts';
import type {ResearchScreen} from './researchFit.ts';

const screen=(symbol:string,avgR1:number,avgR2:number,tf='15m',scannerId='trend'):ResearchScreen=>({
 scannerId,symbol,tf,result:{at:1,pass:true,trades:100,avgR1,avgR2,holdoutAvgR:999,holdoutPass:true} as any,
});
test('research fit uses other markets and the same scanner/class/timeframe; holdout is never a ranking input',()=>{
 const rows=[screen('ETHUSD',.2,.1),screen('SOLUSD',.4,-.2),screen('BTCUSD',10,10),screen('DOGEUSD',10,10),screen('XRPUSD',10,10,'4h'),screen('XRPUSD',10,10,'15m','other')];
 const a=researchFits(rows)('trend','BTCUSD','15m');
 assert.equal(a.markets,2);assert.equal(a.trades,200);assert.equal(a.score,-.1/5);
 for(const r of rows){r.result.holdoutAvgR=-999;r.result.holdoutPass=false;r.result.pass=false;}
 assert.deepEqual(researchFits(rows)('trend','BTCUSD','15m'),a);
 assert.equal(researchFits(rows)('unknown','BTCUSD','15m').score,0);
});
test('one lucky busy market has bounded influence; missing or invalid training halves are ignored',()=>{
 const rows=[screen('ETHUSD',100,100),screen('SOLUSD',NaN,1),screen('XRPUSD',1,Infinity)];
 rows[0].result.trades=1e6;
 assert.equal(researchFits(rows)('trend','BTCUSD','15m').score,.25);
 assert.equal(researchFits(rows)('trend','BTCUSD','15m').markets,1);
 assert.equal(researchFits([screen('OILUSD',1,1)])('trend','XAUTUSD','15m').markets,0);
});
test('explicit research cells do not add unintended combinations and invalid masks fail rather than screen everything',()=>{
 const cells=parseResearchCells(JSON.stringify([{id:'a',symbol:'BTCUSD'},{id:'b',symbol:'ETHUSD'}]))!;
 assert.ok(cells.has(researchCellKey('a','BTCUSD')));
 assert.ok(!cells.has(researchCellKey('a','ETHUSD')));
 assert.equal(parseResearchCells(undefined),null);
 for(const raw of ['','[]','{}','[{"id":"a","symbol":"bad"}]'])assert.throws(()=>parseResearchCells(raw));
});
