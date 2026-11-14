import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture} from './inboxFixture.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

for(const reason of ['exchange feed disconnected','exchange system status awaiting snapshot','exchange product status unknown or stale']){
 test(`a fresh entry survives ${reason}, rechecks admission and fills exactly once`,async t=>{
  const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
  let blocked:string|null=reason;x.paper.entryBlock=()=>blocked;
  await x.submit();
  assert.equal(x.engine.inbox.status().pending,1);
  assert.equal(x.engine.inbox.status().failed,0,'a planned wait is not an inbox fault');
  assert.equal(x.paper.openPositions().length,0);
  assert.match(x.db.signals({})[0].action,/received:waiting for exchange/);
  await x.engine.recoverSignals();assert.equal(x.paper.openPositions().length,0);
  blocked=null;x.paper.setMark('BTCUSD',101);
  await x.engine.recoverSignals();await x.engine.recoverSignals();await x.submit();
  assert.equal(x.engine.inbox.status().pending,0);
  assert.equal(x.paper.openPositions().length,1);
  assert.equal(x.paper.openPositions()[0].entryPrice,101,'use the recovered market, never the disconnected price');
  assert.equal(x.db.get<any>('SELECT count(*) n FROM orders').n,1);
 });
}

test('disconnect during depth preparation is caught at the atomic decision boundary',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let reason:string|null=null;x.paper.entryBlock=()=>reason;
 x.paper.prepareEntryDepth=async()=>{reason='exchange feed disconnected';};
 await x.submit();assert.equal(x.engine.inbox.status().pending,1);
 assert.equal(x.paper.openPositions().length,0);
 x.paper.prepareEntryDepth=undefined;reason=null;x.paper.setMark('BTCUSD',100);
 await x.engine.recoverSignals();assert.equal(x.paper.openPositions().length,1);
});

for(const reason of ['exchange system maintenance','exchange product halted']){
 test(`a definitive ${reason} is rejected without waiting`,async t=>{
  const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
  x.paper.entryBlock=()=>reason;await x.submit();
  assert.equal(x.engine.inbox.status().pending,0);
  assert.equal(x.db.signals({})[0].action,`rejected:${reason}`);
  assert.equal(x.paper.openPositions().length,0);
 });
}

test('waiting survives restart, retains its deadline, and cannot reserve or duplicate a limit order',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'vnedge-exchange-wait-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'db.sqlite');const a=inboxFixture(file,{limit:true});
 a.paper.entryBlock=()=> 'exchange feed disconnected';await a.submit();
 const receipt=a.engine.inbox.pending()[0];
 assert.equal(a.paper.pendingEntries().length,0);assert.equal(a.db.get<any>('SELECT count(*) n FROM positions').n,0);
 a.engine.stop();a.db.db.close();
 const b=inboxFixture(file,{limit:true});t.after(()=>{b.engine.stop();b.db.db.close();});
 b.paper.setMark('BTCUSD',100);await b.engine.recoverSignals();await b.engine.recoverSignals();
 assert.equal(b.paper.pendingEntries().length,1);assert.equal(b.paper.openPositions().length,0);
 assert.equal(b.db.get<any>('SELECT received_at FROM signal_inbox').received_at,receipt.received_at);
 assert.equal(b.db.get<any>('SELECT count(*) n FROM orders').n,0,'a resting limit is not a fill');
});

test('the recovery deadline expires even when the exchange is still unavailable',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 x.paper.entryBlock=()=> 'exchange feed disconnected';await x.submit();
 x.db.run('UPDATE signal_inbox SET received_at=received_at-61000');
 await x.engine.recoverSignals();
 assert.equal(x.engine.inbox.status().pending,0);assert.match(x.db.signals({})[0].action,/expired/);
 assert.equal(x.paper.openPositions().length,0);
});

test('recovery also enforces bar-close freshness, not just time since receipt',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let reason:string|null='exchange feed disconnected';x.paper.entryBlock=()=>reason;
 await x.submit({...x.entry,barTime:x.entry.barTime-600_000});
 reason=null;x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.equal(x.engine.inbox.status().pending,0);assert.match(x.db.signals({})[0].action,/stale signal/);
 assert.equal(x.paper.openPositions().length,0);
});

test('copy eligibility is rechecked again after asynchronous depth preparation',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let exchange:string|null='exchange feed disconnected',evidence:string|null=null,checks=0;
 x.engine.copyRecoveryRefusal=()=>{checks++;return evidence;};x.paper.entryBlock=()=>exchange;
 await x.submit(x.entry,true);
 exchange=null;x.paper.setMark('BTCUSD',100);
 x.paper.prepareEntryDepth=async()=>{evidence='mirror held: net R no longer positive';};
 await x.engine.recoverSignals();
 assert.ok(checks>=2);assert.equal(x.engine.inbox.status().pending,0);
 assert.match(x.db.signals({})[0].action,/mirror held/);assert.equal(x.paper.openPositions().length,0);
 assert.equal(x.db.get<any>('SELECT promotion_eligible FROM gated_signals').promotion_eligible,0);
});

test('copy recovery fails closed without a current evidence resolver',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let exchange:string|null='exchange feed disconnected';x.paper.entryBlock=()=>exchange;
 await x.submit(x.entry,true);exchange=null;x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.match(x.db.signals({})[0].action,/copy evidence unavailable/);
 assert.equal(x.paper.openPositions().length,0);
});

test('a qualified copied entry still obeys risk refusal after exchange recovery',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let exchange:string|null='exchange feed disconnected';x.paper.entryBlock=()=>exchange;
 x.engine.copyRecoveryRefusal=()=>null;await x.submit(x.entry,true);
 x.paper.risk={gate:()=>({reject:'daily risk cap',leverageMult:1}),exposureCheck:()=>null};
 exchange=null;x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();
 assert.match(x.db.signals({})[0].action,/daily risk cap/);assert.equal(x.paper.openPositions().length,0);
});

test('a recovered qualified pilot preserves the ordinary path quantity, fees, policy and usage',async t=>{
 const baseline=inboxFixture(),recovered=inboxFixture();
 t.after(()=>{for(const x of [baseline,recovered]){x.engine.stop();x.db.db.close();}});
 for(const x of [baseline,recovered]){
  x.cfg.scanners.s.enabled=false;
  x.cfg.incubator.mirror!.pilot={sizeScale:1/3,maxDailyEntries:0,maxOpenPositions:0};
  x.engine.copyRecoveryRefusal=()=>null;x.paper.setMark('BTCUSD',100);
 }
 await baseline.submit(baseline.entry,true);
 let exchange:string|null='exchange feed disconnected';recovered.paper.entryBlock=()=>exchange;
 await recovered.submit(recovered.entry,true);
 assert.equal(recovered.db.kvGet('incubator.copyPilot'),undefined,'waiting does not consume pilot usage');
 exchange=null;await recovered.engine.recoverSignals();await recovered.engine.recoverSignals();
 const a=baseline.paper.openPositions()[0],b=recovered.paper.openPositions()[0];
 assert.ok(a&&b);assert.equal(a.qty,b.qty);assert.equal(a.fees,b.fees);
 assert.equal(a.riskAmount,b.riskAmount);assert.equal(a.policy?.id,b.policy?.id);
 assert.deepEqual(baseline.db.kvGet('incubator.copyPilot'),recovered.db.kvGet('incubator.copyPilot'));
 assert.equal(recovered.db.get<any>('SELECT count(*) n FROM orders').n,1);
});

test('exchange recovery requires a new price observation',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 let exchange:string|null='exchange feed disconnected';x.paper.entryBlock=()=>exchange;await x.submit();
 exchange=null;await x.engine.recoverSignals();
 assert.equal(x.engine.inbox.status().pending,1);assert.equal(x.paper.openPositions().length,0);
 x.paper.setMark('BTCUSD',100);await x.engine.recoverSignals();assert.equal(x.paper.openPositions().length,1);
});

test('protective exits do not wait behind entry exchange-status recovery',async t=>{
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});await x.submit();
 const pos=x.paper.openPositions()[0],qty=pos.qtyOpen;
 x.paper.entryBlock=()=> 'exchange feed disconnected';await x.submit(x.exit);
 assert.equal(x.engine.inbox.status().pending,0);assert.ok(pos.qtyOpen<qty);
});

for(const mode of ['testnet','executor'] as const){
 test(`this paper recovery change cannot defer ${mode} exchange commands`,async t=>{
  const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
  if(mode==='testnet')x.cfg.execution.mode='testnet';else x.engine.executorAttached=()=>true;
  x.paper.entryBlock=()=> 'exchange feed disconnected';await x.submit();
  assert.equal(x.engine.inbox.status().pending,0);assert.equal(x.paper.openPositions().length,0);
  assert.match(x.db.signals({})[0].action,/rejected:exchange/);
 });
}
