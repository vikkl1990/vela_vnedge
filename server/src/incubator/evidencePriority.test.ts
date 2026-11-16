import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {admissionEvidence,evidencePriority} from './evidencePriority.ts';
const inc=structuredClone(DEFAULT_CONFIG.incubator);
const row=(trades:number,days:number)=>({tf:'15m',screen:{trades,days,profitFactor:2,windowsUp:6}});
test('admission discounts slow evidence without changing its quality score or excluding it',()=>{
 const fast=admissionEvidence(row(40,40),inc),slow=admissionEvidence(row(40,400),inc);
 assert.equal(fast.qualityScore,slow.qualityScore);assert.ok(fast.score>slow.score);assert.ok(slow.factor>=.25);assert.ok(slow.score>0);
 assert.equal(admissionEvidence(row(40,NaN),inc).factor,1);
});
test('completion priority uses timeframe sample size, not return or failed gates',()=>{
 const r={stage:'shadow',tf:'15m',gate:{stats:{trades:inc.gate.minTrades-1,avgR:-2}}} as any;
 assert.ok(evidencePriority(r,inc)>.9);const v=evidencePriority(r,inc);r.gate.stats.avgR=2;assert.equal(evidencePriority(r,inc),v);
 r.gate.stats.trades=inc.gate.minTrades;assert.equal(evidencePriority(r,inc),0);r.stage='tracked';assert.equal(evidencePriority(r,inc),0);
});

test('time-to-evidence uses all counted trades across the full screen span without changing qualification',()=>{
 const r={tf:'15m',screen:{trades:28,holdoutTrades:12,days:40,profitFactor:2,windowsUp:6}};
 const v=admissionEvidence(r,inc);
 assert.equal(v.estimatedDays,inc.gate.minTrades);
 assert.equal(v.requiredTrades,inc.gate.minTrades);
 assert.equal(v.qualityScore,admissionEvidence({...r,screen:{...r.screen,holdoutTrades:0}},inc).qualityScore);
});

test('shadow scheduling completes the copy sample before the larger promotion sample, including losers',()=>{
 const c={...inc,mirror:{enabled:true,minTrades:5}};
 const r={stage:'shadow',tf:'1h',gate:{stats:{trades:4,avgR:-1}}} as any;
 assert.equal(evidencePriority(r,c),.8);
 r.gate.stats.avgR=1;assert.equal(evidencePriority(r,c),.8);
 assert.equal(evidencePriority(r,{...c,mirror:{enabled:false,minTrades:5}}),4/(c.gate.minTradesByTf?.['1h']??c.gate.minTrades));
 r.gate.stats.trades=5;assert.equal(evidencePriority(r,c),5/(c.gate.minTradesByTf?.['1h']??c.gate.minTrades));
 assert.equal(c.gate.minTrades,inc.gate.minTrades);
});
