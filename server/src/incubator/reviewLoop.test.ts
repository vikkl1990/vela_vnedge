import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EvidenceReview,type ReviewSettings,type ReviewState} from './reviewLoop.ts';
const MIN=60_000;
function setup(){
  let now=100*MIN,screen=0,saved:ReviewState|undefined;
  const settings:ReviewSettings={enabled:true,paper:true,auto:true,minutes:15};
  const actors:string[]=[];
  let evaluate=async(actor:string)=>{actors.push(actor);return actors.length;};
  const create=()=>new EvidenceReview({settings:()=>settings,now:()=>now,screenAt:()=>screen,load:()=>saved,
    save:s=>{saved=s;},evaluate:actor=>evaluate(actor)});
  return {settings,actors,create,advance:(minutes:number)=>now+=minutes*MIN,screen:()=>screen=now,
    evaluate:(fn:typeof evaluate)=>{evaluate=fn;}};
}
test('closed trades bring a review forward; otherwise reviews use the configured interval',async()=>{
 const w=setup(),r=w.create();await r.tick();assert.deepEqual(w.actors,['scheduled evidence']);
 w.advance(4);r.noteEvidence();await r.tick();assert.equal(w.actors.length,1);
 w.advance(1);await r.tick();assert.equal(w.actors[1],'closed-trade evidence');
 w.advance(14);await r.tick();assert.equal(w.actors.length,2);
 w.advance(1);await r.tick();assert.equal(w.actors[2],'scheduled evidence');
});
test('disabled, live and auto-off periodic scheduling do not mutate allocations',async()=>{
 for(const field of ['enabled','paper','auto'] as const){
   const w=setup();w.settings[field]=false;const r=w.create();await r.tick();assert.equal(w.actors.length,0);
   w.screen();await r.tick();assert.equal(w.actors.length,field==='auto'?1:0,'paper screening still judges proposals with automatic promotion off');
 }
});
test('manual, pair-agent and timer reviews share one operation',async()=>{
 const w=setup();let finish!:(n:number)=>void;let runs=0;
 w.evaluate(()=>{runs++;return new Promise(resolve=>{finish=resolve;});});
 const r=w.create(),a=r.run('manual'),b=r.run('pair agents');assert.equal(a,b);
 await r.tick();assert.equal(runs,1);assert.equal(r.view().running,true);
 finish(7);assert.equal(await b,7);assert.equal(r.view().running,false);
});
test('failure preserves the last success and retries an unacknowledged screen after restart',async()=>{
 const w=setup(),r=w.create();await r.tick();const success=r.view().successAt;
 w.advance(15);w.screen();w.evaluate(async()=>{throw Error('offline');});
 await assert.rejects(r.tick(),/offline/);assert.equal(r.view().successAt,success);assert.equal(r.view().screenAt,0);
 const restarted=w.create();assert.equal(restarted.view().error,'offline');w.advance(4);await restarted.tick();
 w.evaluate(async()=>42);w.advance(1);assert.equal(await restarted.tick(),42);
 assert.ok(restarted.view().screenAt>0);assert.equal(restarted.view().error,null);
});
test('evidence arriving during an asynchronous review remains due for another review',async()=>{
 const w=setup();let finish!:(n:number)=>void;
 w.evaluate(()=>new Promise(resolve=>{finish=resolve;}));const r=w.create(),pending=r.run('manual');
 await Promise.resolve();w.advance(1);r.noteEvidence();finish(1);await pending;
 w.evaluate(async()=>9);w.advance(4);assert.equal(await r.tick(),9);
});
test('review state survives restart and changing cadence does not rewrite evidence settings',async()=>{
 const w=setup(),r=w.create();await r.tick();w.advance(6);const r2=w.create();await r2.tick();assert.equal(w.actors.length,1);
 w.settings.minutes=5;await r2.tick();assert.equal(w.actors.length,2);
 assert.deepEqual(w.settings,{enabled:true,paper:true,auto:true,minutes:5});
});
