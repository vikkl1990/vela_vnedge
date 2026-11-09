import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Position } from '../src/api/types.ts'
import { positionTargets, targetR } from '../src/lib/protection.ts'
test('zero allocation references cannot be presented as executable targets', () => {
  const targets = positionTargets({tp:[102,104,106],legs:[0,0,3],tpHit:[false,false,false]})
  assert.deepEqual(targets.map(t=>t.state),['reference','reference','active'])
})
test('hit targets and missing allocations are not active', () => {
  assert.deepEqual(positionTargets({tp:[102,104,106],legs:[1,1,1],tpHit:[true,false,false]}).map(t=>t.state),['hit','active','active'])
  assert.equal(positionTargets({tp:[102,null,null],legs:undefined} as unknown as Position)[0].state,'unknown')
  assert.deepEqual(positionTargets({tp:[NaN,0,-1]} as Position),[])
})
test('target R uses original stop for both directions; a trailing stop is not original risk', () => {
  const p={side:'long',entryPrice:100,slOriginal:98,sl:101} as Position
  assert.equal(targetR(p,106),3)
  assert.equal(targetR({...p,side:'short',slOriginal:102},94),3)
  assert.equal(targetR({...p,slOriginal:undefined},106),null)
})
