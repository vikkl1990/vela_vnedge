import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Scanner } from '../src/api/types.ts'
import { readerLabel, scannerActivity } from '../src/lib/scannerPresentation.ts'
const base = {enabled:true,status:'ok',scheduledCells:3,reads:{sources:null},week:{entries:0,opened:0}} as Scanner

test('an explicit empty reader disables entries; missing configuration means automatic', () => {
  assert.equal(readerLabel({}), 'Automatic reader')
  assert.equal(readerLabel({reads:{sources:[]} as Scanner['reads']}), 'Entries disabled')
  assert.equal(scannerActivity({...base,reads:{sources:[]} as Scanner['reads']}).key, 'context')
})
test('quarantine, missing allocation and normal silence are distinct', () => {
  assert.equal(scannerActivity({...base, health:{quarantined:true,reason:'memory'} as Scanner['health']}).key,'fault')
  assert.equal(scannerActivity({...base,scheduledCells:0}).key,'unallocated')
  assert.equal(scannerActivity({...base,scheduledCells:undefined}).key,'unknown')
  assert.equal(scannerActivity(base).key,'scheduled')
  assert.match(scannerActivity(base).detail,/0 entry signals/)
  assert.equal(scannerActivity({...base,enabled:false}).key,'off')
})
test('runtime errors remain visible on a scheduled scanner', () => {
  assert.equal(scannerActivity({...base,lastRun:{error:'timeout'} as Scanner['lastRun']}).key,'fault')
})
