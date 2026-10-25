import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradingStatus } from './tradingStatus.ts';
test('status gate blocks startup, halts, auctions and stale products; old system snapshot remains valid on receipt', () => {
  const s=new TradingStatus();assert.match(s.block('BTCUSD',1000)!,/disconnected/);
  s.connection(true,1000);s.product('BTCUSD','operational',1001);
  assert.match(s.block('BTCUSD',1002)!,/snapshot/);
  s.systemUpdate('live',10,1002);assert.equal(s.block('BTCUSD',1003),null);
  s.product('BTCUSD','disrupted_cancel_only',1004);assert.match(s.block('BTCUSD',1005)!,/cancel_only/);
  s.product('BTCUSD','operational',1003);assert.match(s.block('BTCUSD',1005)!,/cancel_only/);
  s.product('BTCUSD','disrupted_post_only',1006);assert.match(s.block('BTCUSD',1007)!,/post_only/);
  s.product('BTCUSD','operational',1008);s.systemUpdate('maintenance',1008,1008);assert.match(s.block('BTCUSD',1009)!,/maintenance/);
  s.systemUpdate('live',1009,1009);assert.equal(s.block('BTCUSD',1010),null);
  assert.match(s.block('BTCUSD',122000)!,/stale/);
});
test('reconnect requires both a new system snapshot and revalidated products', () => {
  const s=new TradingStatus();s.connection(true,100);s.product('BTCUSD','operational',101);s.systemUpdate('live',90,101);
  s.connection(false,200);s.connection(true,300);s.systemUpdate('live',90,301);
  assert.match(s.block('BTCUSD',302)!,/unknown|stale/);
  s.product('BTCUSD','operational',303);assert.equal(s.block('BTCUSD',304),null);
});
