import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inboxFixture } from './inboxFixture.ts';
import { RiskManager } from '../risk/manager.ts';

for(const point of ['receipt','entry-before-commit','entry-after-commit','exit-before-commit','exit-after-commit','limit-before-commit','limit-after-commit']) {
 test(`SIGKILL at ${point}: restart cannot lose a received decision or duplicate a fill`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'vnedge-inbox-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'db.sqlite');
  const child=spawnSync(process.execPath,['--no-warnings=ExperimentalWarning','--input-type=module','-e',`
    import { inboxFixture } from ${JSON.stringify(new URL('./inboxFixture.ts',import.meta.url).href)};
    const point=process.argv[2],x=inboxFixture(process.argv[1],{limit:point.startsWith('limit')}),kill=()=>process.kill(process.pid,'SIGKILL');
    if(point==='receipt')x.paper.prepareEntryDepth=async()=>kill();
    if(point.startsWith('exit'))await x.submit();
    if(point.endsWith('before-commit')){const complete=x.engine.inbox.complete.bind(x.engine.inbox);x.engine.inbox.complete=(...args)=>{complete(...args);kill();};}
    if(point.endsWith('after-commit'))x.paper.on(point.startsWith('limit')?'pending':'order',()=>kill());
    await x.submit(point.startsWith('exit')?x.exit:x.entry);
  `,file,point],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const x=inboxFixture(file,{limit:point.startsWith('limit')});t.after(()=>x.db.db.close());x.paper.setMark('BTCUSD',101);
  const before=x.db.all<any>('SELECT * FROM signal_inbox');
  assert.equal(before.at(-1).state,point.endsWith('after-commit')?'done':'pending');
  if(point==='receipt'||point==='entry-before-commit')assert.equal(x.paper.openPositions().length,0);
  const fillsBefore=x.db.get<{n:number}>('SELECT COUNT(*) n FROM orders')!.n;
  await x.engine.recoverSignals();await x.engine.recoverSignals();
  if(point.startsWith('limit')){
   assert.equal(x.engine.inbox.status().pending,0);assert.equal(x.paper.pendingEntries().length,1);assert.equal(x.paper.openPositions().length,0);
   assert.equal(x.db.get<any>('SELECT COUNT(*) n FROM positions').n,1);
   assert.equal(x.db.signals({})[0].positionId,x.paper.pendingEntries()[0].id);return;
  }
  assert.equal(x.engine.inbox.status().pending,0);assert.equal(x.paper.openPositions().length,1);
  const pos=x.paper.openPositions()[0];
  const orders=x.db.all<any>('SELECT reason FROM orders ORDER BY id');
  assert.equal(orders.filter(o=>o.reason==='entry').length,1);
  if(point.startsWith('exit')){assert.equal(orders.length,2);assert.ok(pos.qtyOpen>0&&pos.qtyOpen<pos.qty);}
  else {assert.equal(orders.length,1);assert.equal(pos.qtyOpen,pos.qty);if(!point.endsWith('after-commit'))assert.equal(pos.entryPrice,101,'recovery prices the current market, not the old signal');}
  if(point.endsWith('after-commit'))assert.equal(orders.length,fillsBefore);
  assert.ok(x.db.all<any>('SELECT payload FROM signal_inbox').every(r=>r.payload===null));
 });
}

test('failed commit restores memory and suppresses fill notifications before retry',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());let observed=0;x.paper.on('order',()=>observed++);
 const complete=x.engine.inbox.complete.bind(x.engine.inbox);
 x.engine.inbox.complete=()=>{throw Error('injected commit failure');};
 await assert.rejects(x.submit(),/injected/);
 assert.equal(x.paper.openPositions().length,0);assert.equal(x.paper.pendingEntries().length,0);assert.equal(observed,0);
 assert.equal(x.db.get<any>('SELECT COUNT(*) n FROM orders').n,0);
 x.engine.inbox.complete=complete;x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.equal(x.paper.openPositions().length,1);assert.equal(observed,1);
 const pos=x.paper.openPositions()[0],qty=pos.qtyOpen;
 x.engine.inbox.complete=()=>{throw Error('partial rollback');};await assert.rejects(x.submit(x.exit),/partial/);
 assert.equal(pos.qtyOpen,qty);assert.equal(x.paper.openPositions()[0],pos);assert.equal(observed,1);
 x.engine.inbox.complete=complete;await x.engine.recoverSignals();assert.ok(pos.qtyOpen<qty);assert.equal(observed,2);
});

test('risk state and notifications roll back with a failed decision',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());x.cfg.risk.enabled=false;
 const now=Date.now();const risk=new RiskManager({db:x.db,paper:x.paper,candles:{get:()=>[]} as any,cfgRef:()=>x.cfg,now:()=>now});x.paper.risk=risk;
 const before=risk.state();let emitted=0;risk.on('kill',()=>emitted++);
 risk.gate=()=>{risk.kill('injected state mutation');return {leverageMult:1};};
 x.engine.inbox.complete=()=>{throw Error('write failure');};
 await assert.rejects(x.submit(),/write failure/);
 assert.equal(emitted,0);assert.deepEqual(risk.state(),before);
 assert.equal(x.paper.openPositions().length,0);
});

test('a nested fill write failure leaves its exit receipt pending and quantity unchanged',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());await x.submit();
 const pos=x.paper.openPositions()[0],qty=pos.qtyOpen;let emitted=0;x.paper.on('order',()=>emitted++);
 x.db.run("CREATE TEMP TRIGGER fail_exit BEFORE INSERT ON orders WHEN NEW.reason <> 'entry' BEGIN SELECT RAISE(ABORT,'injected fill write failure'); END");
 await assert.rejects(x.submit(x.exit),/injected fill write failure/);
 assert.equal(pos.qtyOpen,qty);assert.equal(x.engine.inbox.status().pending,1);assert.equal(emitted,0);
 assert.equal(x.db.get<any>('SELECT COUNT(*) n FROM orders').n,1);
 x.db.run('DROP TRIGGER fail_exit');x.paper.setMark('BTCUSD',101);await x.engine.recoverSignals();
 assert.ok(pos.qtyOpen<qty);assert.equal(x.engine.inbox.status().pending,0);assert.equal(emitted,1);
});

test('a reversal rolls back both its close and replacement when the decision fails',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());await x.submit();
 const first=x.paper.openPositions()[0];let emitted=0;x.paper.on('order',()=>emitted++);
 const complete=x.engine.inbox.complete.bind(x.engine.inbox);
 x.engine.inbox.complete=()=>{throw Error('interrupted reversal');};
 await assert.rejects(x.submit({...x.entry,side:'short',sl:102,tp:[98,96,94],label:'Short'}),/interrupted reversal/);
 assert.equal(x.paper.openPositions()[0],first);assert.equal(first.status,'open');assert.equal(emitted,0);
 assert.equal(x.db.get<any>('SELECT COUNT(*) n FROM orders').n,1);
 x.engine.inbox.complete=complete;x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.equal(first.status,'closed');assert.equal(x.paper.openPositions().length,1);assert.equal(x.paper.openPositions()[0].side,'short');
 assert.equal(x.db.get<any>('SELECT COUNT(*) n FROM orders').n,3);assert.equal(emitted,2);
});

test('pending entries cannot reopen the account after an operator reset',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());
 x.paper.prepareEntryDepth=async()=>{throw Error('interrupted preparation');};await assert.rejects(x.submit());x.paper.prepareEntryDepth=undefined;
 x.paper.reset();x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.equal(x.paper.openPositions().length,0);assert.equal(x.engine.inbox.status().pending,0);
 assert.match(x.db.signals({})[0].action,/account reset/);
});

test('recovery pauses outside paper mode without dispatching an exit',async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());await x.submit();
 const pos=x.paper.openPositions()[0],qty=pos.qtyOpen,complete=x.engine.inbox.complete.bind(x.engine.inbox);
 x.engine.inbox.complete=()=>{throw Error('interrupted exit');};await assert.rejects(x.submit(x.exit));x.engine.inbox.complete=complete;
 x.cfg.execution.mode='testnet';x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.equal(pos.qtyOpen,qty);assert.equal(x.engine.inbox.status().pending,1);
 assert.match(x.engine.inbox.status().recent[0].last_error,/outside paper mode/);
 x.cfg.execution.mode='paper';await x.engine.recoverSignals();assert.ok(pos.qtyOpen<qty);
});

test('recovery freshness stays bounded when the ordinary quote age limit is disabled',t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());x.cfg.paper.quoteMaxAgeMs=0;
 assert.equal(x.paper.hasFreshPrice('BTCUSD','buy'),false);
 x.paper.setMark('BTCUSD',100);x.paper.setMark('BTCUSD',Infinity);
 assert.equal(x.paper.mark('BTCUSD'),100);assert.equal(x.paper.hasFreshPrice('BTCUSD','buy'),true);
 assert.equal(x.paper.hasFreshPrice('BTCUSD','buy',Date.now()+20_000),false);
});

for(const reason of ['expired','policy changed','source changed','fresh price','replacement position'])test(`recovery handles ${reason} without stale or misdirected execution`,async t=>{
 const x=inboxFixture();t.after(()=>x.db.db.close());
 if(reason==='replacement position')await x.submit();
 const complete=x.engine.inbox.complete.bind(x.engine.inbox);
 if(reason==='replacement position'){
  x.engine.inbox.complete=()=>{throw Error('interrupt exit');};await assert.rejects(x.submit(x.exit));x.engine.inbox.complete=complete;
  const first=x.paper.openPositions()[0];x.paper.closeManual(first.id);
  await x.submit({...x.entry,barTime:x.entry.barTime+1,label:'replacement'});
  const next=x.paper.openPositions()[0],qty=next.qtyOpen;
  await x.engine.recoverSignals();assert.equal(next.qtyOpen,qty);assert.equal(x.db.signals({kind:'exit'})[0].action,'ignored:no position');return;
 }
 x.paper.prepareEntryDepth=async()=>{throw Error('interrupt preparation');};await assert.rejects(x.submit());x.paper.prepareEntryDepth=undefined;
 if(reason==='expired')x.db.run('UPDATE signal_inbox SET received_at=received_at-120000');
 if(reason==='policy changed')x.cfg.paper.marginPerTrade=151;
 if(reason==='source changed')x.source.patched='source v2';
 await x.engine.recoverSignals();assert.equal(x.paper.openPositions().length,0);
 if(reason==='fresh price'){
  assert.equal(x.engine.inbox.status().pending,1);x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();assert.equal(x.paper.openPositions().length,1);
 }else {assert.equal(x.engine.inbox.status().pending,0);assert.match(x.db.signals({})[0].action,reason==='expired'?/expired/:/policy changed/);}
});

test('nested commit observers run only after outer success; listener failure does not undo a commit',()=>{
 const {db}=inboxFixture();const seen:string[]=[];
 db.transaction(()=>{db.afterCommit(()=>seen.push('first'));assert.throws(()=>db.transaction(()=>{db.afterCommit(()=>seen.push('discard'));throw Error('rollback');}));db.transaction(()=>db.afterCommit(()=>seen.push('last')));assert.deepEqual(seen,[]);});
 assert.deepEqual(seen,['first','last']);
 assert.doesNotThrow(()=>db.transaction(()=>{db.kvSet('committed',1);db.afterCommit(()=>{throw Error('observer failure');});}));
 assert.equal(db.kvGet('committed'),1);db.db.close();
});
