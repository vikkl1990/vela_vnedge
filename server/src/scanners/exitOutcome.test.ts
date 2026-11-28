import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture} from './inboxFixture.ts';

test('a causal script exit acknowledges intent without claiming a reduced fill; retries cannot change execution',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const x=inboxFixture(),control=inboxFixture();
 t.after(()=>{x.engine.stop();control.engine.stop();x.db.db.close();control.db.db.close();});
 x.paper.causalExits=control.paper.causalExits=true;
 const cfg=JSON.stringify(x.cfg);
 await x.submit();await control.submit();
 const p=x.paper.openPositions()[0],baseline=control.paper.openPositions()[0],qty=p.qtyOpen;
 const ev={...x.exit,exitType:'close' as const,label:'Exit long'};
 const beforeOrders=x.db.all('SELECT * FROM orders');
 await x.submit(ev);
 control.paper.commitDecision(()=>control.paper.onScriptExit('s','BTCUSD','15m','close',ev.price,Date.now(),'both','long',{positionId:baseline.id,pendingIds:[]}));
 assert.equal(x.db.signals({kind:'exit'})[0].action,'exit-requested');
 assert.equal(p.qtyOpen,qty);assert.equal(p.status,'open');
 assert.deepEqual(x.db.all('SELECT * FROM orders'),beforeOrders,'receipt cannot invent a fill');
 assert.deepEqual(x.paper.pendingExits(),control.paper.pendingExits(),'same exit intent, quantity, price reference and timing');
 await x.submit(ev);await x.engine.recoverSignals();
 assert.equal(x.paper.pendingExits().length,1);assert.equal(x.engine.inbox.status().pending,0);
 const at=Date.now()+10,depth={receivedAt:at,exchangeAt:at,bids:[{price:99,size:100000}],asks:[{price:99.1,size:100000}]};
 x.paper.settleExits('BTCUSD',depth,at);control.paper.settleExits('BTCUSD',depth,at);
 assert.equal(p.status,'closed');
 assert.deepEqual(x.db.all('SELECT * FROM orders'),control.db.all('SELECT * FROM orders'),'post-report fills and fees are identical to current execution');
 assert.deepEqual(x.paper.trades(),control.paper.trades(),'net profit and closed-trade evidence unchanged');
 assert.equal(JSON.stringify(x.cfg),cfg);
});

test('an immediately executed partial exit remains reduced; a stop request never claims a fill',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 await x.submit();const p=x.paper.openPositions()[0];
 await x.submit(x.exit);
 assert.equal(x.db.signals({kind:'exit'})[0].action,'reduced');assert.ok(p.qtyOpen<p.qty);
 const orders=x.db.all('SELECT * FROM orders'),qty=p.qtyOpen;
 await x.submit({...x.exit,exitType:'stop_update',price:99,label:'Stop amendment'});
 assert.equal(x.db.signals({kind:'exit'}).find(s=>s.label==='Stop amendment')?.action,'stop-update-requested');
 assert.equal(p.qtyOpen,qty);assert.deepEqual(x.db.all('SELECT * FROM orders'),orders);
});

test('an already consumed script target cannot be reported as another reduction',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1800000000000});
 const x=inboxFixture();t.after(()=>{x.engine.stop();x.db.db.close();});
 await x.submit();await x.submit(x.exit);
 const p=x.paper.openPositions()[0],qty=p.qtyOpen;
 await x.submit({...x.exit,barTime:x.exit.barTime+1,label:'Repeated TP1 notification'});
 assert.equal(p.qtyOpen,qty);
 assert.equal(x.db.signals({kind:'exit'}).find(s=>s.label==='Repeated TP1 notification')?.action,'ignored:script exit left exposure unchanged');
});
