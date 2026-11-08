import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchCandidates,replayReentry,replayCapacity,type Snapshot} from './reentryPilotReplay.ts';
const position=(id:number,entry_at:number,exit_at:number|null,exit_reason='sl')=>({id,entry_at,exit_at,exit_reason,bt:0,status:exit_at===null?'open':'closed',scanner_id:String(id),symbol:'BTCUSD',tf:'15m',side:'long',realized_pnl:-10,fees:1,risk_amount:10,signal_id:id,pilot:1});
const signal=(id:number,at:number,action='opened')=>({id,at,scanner_id:String(id),symbol:'BTCUSD',tf:'15m',side:'long',action,position_id:id});
test('recorded cooldown uses only accepted prior stops, not future exits or removed trades; reset books do not leak',()=>{
 const p=[position(1,0,100),position(2,50,150),position(3,110,200),position(4,600150,700000),{...position(5,120,300),bt:-1}];
 const out=replayReentry(p,10);
 assert.deepEqual(out.removed.map(x=>x.id),[3]);
 assert.ok(out.accepted.some(x=>x.id===2),'stop at 100 was not known at 50');
 assert.ok(out.accepted.some(x=>x.id===4),'rejected trade 3 cannot extend cooldown');
 assert.ok(out.accepted.some(x=>x.id===5),'independent archived account is not blocked');
});
test('candidate matching refuses ambiguity, future nearby entries, wrong sides and unlinked paper positions',()=>{
 const s:Snapshot={at:10000,positions:[{...position(1,1010,2000),pilot:null,bt:2,scanner_id:'9'},{...position(2,1011,2000),pilot:null,bt:2,scanner_id:'9'}],signals:[{...signal(9,1000,'rejected:copy pilot open position limit'),position_id:null}],shadow_admissions:[{position_id:1,scanner_id:'9',symbol:'BTCUSD',tf:'15m',at:1005,stage:'pending'}],pilot_config:{sizeScale:1/3,maxOpenPositions:2,maxDailyEntries:10}};
 assert.equal(matchCandidates(s).result[0].position.id,1);
 s.shadow_admissions.push({...s.shadow_admissions[0],position_id:2});assert.equal(matchCandidates(s).result.length,0);
 s.shadow_admissions.pop();s.shadow_admissions[0].at=7000;assert.equal(matchCandidates(s).result.length,0);
 s.shadow_admissions[0].at=1005;s.positions[0].side='short';assert.equal(matchCandidates(s).result.length,0);
});
test('capacity replay reserves from signal receipt, keeps open paths occupied, frees only at exit and does not rank outcomes',()=>{
 const c=[{signal:{...signal(1,100),tf:'1h'},position:{...position(1,120,null),tf:'1h'},source:'paper' as const},
 {signal:{...signal(2,200),tf:'4h'},position:{...position(2,220,300),tf:'4h',realized_pnl:999999},source:'shadow' as const},
 {signal:signal(3,210),position:position(3,230,400),source:'shadow' as const},
 {signal:signal(4,220),position:position(4,240,500),source:'shadow' as const},
 {signal:signal(5,400),position:position(5,420,600),source:'shadow' as const}];
 const cfg={sizeScale:1/3,maxDailyEntries:10,maxOpenPositions:2,byHorizon:{scalp:{maxDailyEntries:8,maxOpenPositions:1},swing:{maxDailyEntries:2,maxOpenPositions:1}}};
 const out=replayCapacity(c,cfg);assert.deepEqual(out.acceptedIds,[1,3,5]);assert.equal(out.swing,1);assert.equal(out.scalp,2);
});
