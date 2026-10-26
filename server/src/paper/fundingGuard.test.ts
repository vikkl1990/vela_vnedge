import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG} from '../config.ts';
import {fundingAssessment} from './fundingGuard.ts';
const now=1000000;
const cfg={...DEFAULT_CONFIG.paper,fundingGuard:{enabled:true,leadMinutes:5,maxAgeSec:120,scalpMaxR:.1,swingMaxR:.2}};
const f={ratePct:1,predictedRatePct:null,intervalSec:28800,nextAt:now+60000,at:now,lastChargedAt:null};
test('funding direction and timeframe budgets',()=>{
 assert.equal(fundingAssessment(f,cfg,'long','15m',150,10,now).trigger,true);
 assert.equal(fundingAssessment(f,cfg,'long','1h',150,10,now).trigger,false);
 assert.equal(fundingAssessment(f,cfg,'short','15m',150,10,now).cost,0);
 assert.equal(fundingAssessment({...f,ratePct:-1},cfg,'short','15m',150,10,now).trigger,true);
});
test('never avoid overdue settlement, stale or missing rates, disabled charging or invalid risk',()=>{
 for(const rate of [undefined,{...f,at:now-121000},{...f,nextAt:now},{...f,nextAt:now+360000},{...f,ratePct:NaN}]) assert.equal(fundingAssessment(rate,cfg,'long','15m',1000,10,now).trigger,false);
 assert.equal(fundingAssessment(f,{...cfg,fundingCharges:false},'long','15m',1000,10,now).trigger,false);
 assert.equal(fundingAssessment(f,DEFAULT_CONFIG.paper,'long','15m',1000,10,now).trigger,false);
 assert.equal(fundingAssessment(f,cfg,'long','15m',1000,0,now).trigger,false);
});
