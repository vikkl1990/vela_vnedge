import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Scanner } from '../src/api/types.ts'
import { worthActingOn, weekBlockers } from '../src/lib/scannerFleet.ts'
const base = {
  id: 's',
  name: 'Scanner',
  enabled: false,
  status: 'ok',
  scheduledCells: 0,
  books: { account: [], shadow: ['ETHUSD 1h'], proposed: [] },
  week: { entries: 3, opened: 0, pending: 0, gate: 0, fee: 0, regime: 1, guard: 1, other: 1 },
  paperReadiness: { at: 1, copyEnabled: true, shadow: 1, eligible: 1, tracked: 0, candidates: 0, holds: [] },
} as Scanner

test('historical refusals do not masquerade as a current majority block', () => {
  const [row] = worthActingOn([base])
  assert.match(row.text, /7-day paper history/)
  assert.doesNotMatch(row.text, /Most|held by/)
  assert.match(row.evidence!, /1 of 1 shadow cells pass/)
  assert.match(row.evidence!, /fresh signal and entry checks/)
  assert.equal(row.href, '/signals?scanner=s&kind=entry')
  assert.equal(row.history, true)
})
test('shadow and watch-only scanners are not told to bypass evidence by assigning paper pairs', () => {
  const [shadow] = worthActingOn([{ ...base, enabled: true, week: null }])
  assert.match(shadow.text, /shadow allocations/)
  assert.doesNotMatch(shadow.text, /Assign pairs/)
  const [watch] = worthActingOn([
    {
      ...base,
      enabled: true,
      week: null,
      books: { account: [], shadow: [], proposed: [], tracked: ['ETHUSD'] },
      paperReadiness: { ...base.paperReadiness!, shadow: 0, eligible: 0, tracked: 32, candidates: 1 },
    },
  ])
  assert.match(watch.evidence!, /32 watch-only cells/)
  assert.match(watch.evidence!, /do not count toward promotion/)
  assert.equal(watch.href, '/incubator?q=s')
})
test('native-stop policy refusals are not reported as stopped trades; duplicate identities stay separate', () => {
  assert.deepEqual(weekBlockers({ ...base.week!, regime: 0, guard: 0, other: 0, protection: 5 }), [
    ['native-stop policy', 5],
  ])
  const rows = worthActingOn([base, { ...base, id: 's-copy' }])
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].s.id, rows[1].s.id)
})
