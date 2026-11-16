import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_CONFIG} from '../config.ts';
import {turnoverAlignment} from './turnoverAlignment.ts';
import {alignResearchTurnover} from '../../../ops/align-research-turnover.ts';
import {makeTradePolicy} from '../paper/tradePolicy.ts';

const config=()=>{
 const c=structuredClone(DEFAULT_CONFIG);
 Object.assign(c.risk.marketGate!,{enabled:true,freshDepth:true,minTurnoverUsd:50000,maxBookCostPct:.25,exempt:[]});
 c.incubator.minTurnoverUsd=1e6;c.incubator.mirror={enabled:true,minTrades:5,minNetR:0,minTurnoverUsd:2e6};
 c.incubator.gate.minTurnoverUsd=5e6;return c;
};
test('alignment changes only the three eligibility floors, retaining risk, costs, samples and strategy identity',()=>{
 const c=config(),snapshot=structuredClone(c),{config:n,floor}=turnoverAlignment(c);
 assert.equal(floor,50000);assert.deepEqual(c,snapshot);
 assert.deepEqual(n.risk,c.risk);assert.deepEqual(n.paper,c.paper);assert.deepEqual(n.execution,c.execution);
 const restored=structuredClone(n);
 restored.incubator.minTurnoverUsd=c.incubator.minTurnoverUsd;
 restored.incubator.mirror!.minTurnoverUsd=c.incubator.mirror!.minTurnoverUsd;
 restored.incubator.gate.minTurnoverUsd=c.incubator.gate.minTurnoverUsd;
 assert.deepEqual(restored,c);
 const cell={scannerId:'test',symbol:'LINKUSD',tf:'15m',exitMode:'both' as const};
 assert.deepEqual(makeTradePolicy(c,cell,c.paper,c.paper,'hash',0),makeTradePolicy(n,cell,n.paper,n.paper,'hash',0));
});
test('alignment requires actual-size depth and paper isolation',()=>{
 for(const mutate of [(c:any)=>c.risk.marketGate.freshDepth=false,(c:any)=>c.risk.marketGate.exempt=['LINKUSD'],(c:any)=>c.risk.marketGate.maxBookCostPct=0,(c:any)=>c.risk.marketGate.minTurnoverUsd=NaN,(c:any)=>c.execution.mode='live',(c:any)=>c.execution.allowProduction=true]){
  const c=config();mutate(c);assert.throws(()=>turnoverAlignment(c));
 }
});
test('ops alignment is dry-run safe, atomic, private and idempotent',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vnedge-turnover-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'config.json'),before=JSON.stringify(config());
 fs.writeFileSync(file,before,{mode:0o600});
 assert.equal(alignResearchTurnover(file,true).changed,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 const r=alignResearchTurnover(file);
 assert.ok('backup' in r);assert.equal(fs.readFileSync(r.backup!,'utf8'),before);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(alignResearchTurnover(file).changed,false);
 assert.equal(fs.readdirSync(dir).length,2);
});
