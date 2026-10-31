import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.ts';
import { OrderLedger } from './ledger.ts';

test('all ledger access paths isolate environments, including writes and legacy unknown rows',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());
  const demo=new OrderLedger(db,()=>1,'testnet'),prod=new OrderLedger(db,()=>2,'production'),legacy=new OrderLedger(db);
  const payload=(id:string)=>({product_id:27,size:1,side:'sell' as const,order_type:'market_order' as const,purpose:'stop' as const,client_order_id:id});
  const a=demo.intent(payload('demo'),1,'BTCUSD'),b=prod.intent(payload('prod'),1,'BTCUSD');
  legacy.intent(payload('legacy'),1,'BTCUSD');demo.acknowledged(a.id,123);
  assert.equal(prod.get(a.id),undefined);assert.equal(prod.byClientId('demo'),undefined);
  assert.deepEqual(prod.forPosition(1).map(r=>r.id),[b.id]);assert.deepEqual(prod.unsettled().map(r=>r.id),[b.id]);
  assert.deepEqual(prod.restingFor(1),[]);assert.deepEqual(prod.recent().map(r=>r.id),[b.id]);
  prod.cancelled(a.id);assert.equal(demo.get(a.id)?.state,'acknowledged');
  assert.equal(prod.get(b.id)?.state,'intent','pre-acknowledgement intent is recoverable');
});

test('exposure recovery includes entries older than the recent-display window',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const ledger=new OrderLedger(db,()=>1,'testnet');
  const p={product_id:27,size:10,side:'buy' as const,order_type:'market_order' as const,purpose:'entry' as const};
  const old=ledger.intent({...p,client_order_id:'old'},9,'BTCUSD');ledger.filled(old.id,{filledSize:10,avgPrice:100,fee:0});
  db.transaction(()=>{for(let i=0;i<5001;i++){const r=ledger.intent({...p,client_order_id:`noise-${i}`},0,'BTCUSD');ledger.rejected(r.id,'fixture');}});
  assert.equal(ledger.recent(5000).some(r=>r.id===old.id),false);
  assert.deepEqual(ledger.filledExposure().map(r=>({...r})),[{positionId:9,qty:10}]);
});

test('cumulative observations validate quantity and cash while retaining known values at the same quantity',t=>{
  const db=new Db(':memory:');t.after(()=>db.db.close());const ledger=new OrderLedger(db,()=>1,'testnet');
  const r=ledger.intent({product_id:27,size:200,side:'buy',order_type:'market_order',purpose:'entry',client_order_id:'partial'},1,'BTCUSD');
  ledger.observed(r.id,{filledSize:50,avgPrice:100,fee:.1});ledger.acknowledged(r.id,1);
  ledger.observed(r.id,{filledSize:50,avgPrice:null,fee:null});assert.equal(ledger.get(r.id)?.fee,.1);
  for(const filledSize of [-1,49,201,NaN,1.5])assert.throws(()=>ledger.observed(r.id,{filledSize,avgPrice:100,fee:.1}),/quantity/);
  assert.throws(()=>ledger.observed(r.id,{filledSize:50,avgPrice:0,fee:.1}),/price/);
  assert.throws(()=>ledger.observed(r.id,{filledSize:50,avgPrice:100,fee:NaN}),/commission/);
  ledger.observed(r.id,{filledSize:100,avgPrice:101,fee:null});assert.equal(ledger.get(r.id)?.fee,null,'50-contract fee cannot cover 100 contracts');
  ledger.cancelled(r.id);assert.deepEqual(ledger.filledExposure().map(x=>({...x})),[{positionId:1,qty:100}]);
});
