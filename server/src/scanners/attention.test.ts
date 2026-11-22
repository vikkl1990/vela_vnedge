import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scannerAttentionReadiness} from './attention.ts';
import type {PairRow} from '../incubator/store.ts';
import type {ScannerWeek} from './activity.ts';

test('attention evaluates only ordinary shadow evidence, read-only, and never combines scanner identities',()=>{
 const at=123456,calls:string[]=[];
 const pair=(scannerId:string,stage:PairRow['stage'],symbol='ETHUSD')=>({scannerId,stage,symbol,tf:'15m'} as PairRow);
 const result=scannerAttentionReadiness({
   scanners:[{id:'enabled',enabled:true,scheduledCells:0},{id:'copy',enabled:false,scheduledCells:0},
     {id:'unrelated',enabled:true,scheduledCells:1},{id:'hidden',enabled:true,hidden:true,scheduledCells:0}],
   week:new Map([['copy',{entries:3,opened:0} as ScannerWeek]]),at,copyEnabled:true,
   mirror:undefined,turnover:s=>s==='ETHUSD'?50000:null,
   pairs:[pair('enabled','tracked'),pair('enabled','candidate'),pair('enabled','shadow'),
     pair('copy','shadow'),pair('copy','proposed','SOLUSD'),pair('copy','live'),pair('copy','retired'),
     pair('unrelated','shadow'),pair('hidden','shadow')],
   store:{copyRefusal:(cell,mirror,turnover,now,options)=>{
     assert.equal(mirror,undefined);assert.equal(now,at);assert.deepEqual(options,{readOnly:true});
     calls.push(cell.scannerId+':'+cell.symbol);
     if(cell.symbol==='SOLUSD'){assert.equal(turnover,null);return 'market data unavailable';}
     assert.equal(turnover,50000);
     return cell.scannerId==='enabled'?'2 of 5 qualified closes':null;
   }},
 });
 assert.deepEqual(calls,['enabled:ETHUSD','copy:ETHUSD','copy:SOLUSD']);
 assert.equal(result.size,2);assert.equal(result.get('enabled')!.eligible,0);
 assert.equal(result.get('enabled')!.tracked,1);assert.equal(result.get('enabled')!.candidates,1);
 assert.equal(result.get('copy')!.eligible,1);assert.equal(result.get('copy')!.shadow,2);
 assert.equal(result.get('copy')!.holds[0].reason,'market data unavailable');
});

test('copy switch and sample limits remain separate from eligibility counts',()=>{
 const pairs=Array.from({length:5},(_,i)=>({scannerId:'s',stage:'shadow',symbol:'S'+i,tf:'1h'} as PairRow));
 const result=scannerAttentionReadiness({scanners:[{id:'s',enabled:true,scheduledCells:0}],
   week:new Map(),pairs,at:1,copyEnabled:false,mirror:undefined,turnover:()=>null,
   store:{copyRefusal:()=> 'insufficient evidence'}});
 assert.equal(result.get('s')!.copyEnabled,false);assert.equal(result.get('s')!.shadow,5);
 assert.equal(result.get('s')!.eligible,0);assert.equal(result.get('s')!.holds.length,3);
});
test('one unavailable evidence check does not break the scanner list or qualify the cell',()=>{
 const result=scannerAttentionReadiness({scanners:[{id:'s',enabled:true,scheduledCells:0}],
   week:new Map(),pairs:[{scannerId:'s',stage:'shadow',symbol:'ETHUSD',tf:'1h'} as PairRow],
   at:1,copyEnabled:true,mirror:undefined,turnover:()=>50000,
   store:{copyRefusal:()=>{throw new Error('invalid policy');}}});
 assert.equal(result.get('s')!.eligible,0);
 assert.match(result.get('s')!.holds[0].reason,/unavailable/);
});
