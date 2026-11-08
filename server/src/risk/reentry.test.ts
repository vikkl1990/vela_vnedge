import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentPairStop } from './reentry.ts';

test('pair cooldown selects the latest observed stop and ignores future, unrelated and non-stop closes', () => {
  const at = 10_000_000;
  const stop = { symbol: 'BTCUSD', scannerId: 'a', exitReason: 'sl', exitAt: at - 1000 };
  const rows = [stop, {...stop,scannerId:'future',exitAt:at+1}, {...stop,scannerId:'old',exitAt:at-3600000}, {...stop,symbol:'ETHUSD',exitAt:at}, {...stop,exitReason:'trail',exitAt:at}];
  assert.equal(recentPairStop(rows,'BTCUSD',at,60),stop);
  assert.equal(recentPairStop(rows,'SOLUSD',at,60),undefined);
  assert.equal(recentPairStop([stop],'BTCUSD',at,0),undefined);
  assert.equal(recentPairStop([stop],'BTCUSD',stop.exitAt+3600000,60),undefined);
});
