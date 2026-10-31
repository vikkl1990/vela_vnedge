import assert from 'node:assert/strict'
import { test } from 'node:test'
import { journalFilters, updateJournalFilters } from '../src/lib/journalFilters.ts'

const now = Date.parse('2026-10-31T20:00:00Z') // 1 Nov in India: still 31 Oct in Daily.
test('UTC closing windows agree with Daily across local midnight and month boundaries', () => {
  for (const [period, from, to] of [
    ['today', '2026-10-31', '2026-11-01'], ['yesterday', '2026-10-30', '2026-10-31'],
    ['7d', '2026-10-25', '2026-11-01'], ['30d', '2026-10-02', '2026-11-01'],
  ]) {
    const f = journalFilters(new URLSearchParams({ period }), now)
    assert.equal(f.query.from, Date.parse(`${from}T00:00:00Z`))
    assert.equal(f.query.to, Date.parse(`${to}T00:00:00Z`))
  }
  assert.equal(journalFilters(new URLSearchParams({period:'today'}), Date.parse('2026-11-01T00:00:00Z')).query.from, Date.parse('2026-11-01T00:00:00Z'))
})
test('custom ranges include the whole end date and reject invalid or reversed dates', () => {
  const p = new URLSearchParams('period=custom&start=2024-02-29&end=2024-02-29')
  assert.equal(journalFilters(p, now).query.to, Date.parse('2024-03-01T00:00:00Z'))
  for (const [start,end] of [['2026-02-29','2026-03-01'], ['2026-10-31','2026-10-30'], ['', '2026-10-31']]) {
    assert.ok(journalFilters(new URLSearchParams({period:'custom',start,end}), now).error)
  }
})
test('bookmark filters are applied before paging and updates reset paging without losing context', () => {
  const p = new URLSearchParams('scanner=abc&symbol=ETHUSD&tf=1h&side=short&reason=sl&period=today&page=2')
  const f = journalFilters(p, now)
  assert.equal(f.query.offset, 100)
  assert.equal(f.query.limit, 50)
  assert.deepEqual([f.query.scanner,f.query.symbol,f.query.tf,f.query.side,f.query.reason], ['abc','ETHUSD','1h','short','sl'])
  const next = updateJournalFilters(p, {tf:'4h'})
  assert.equal(next.get('page'), null)
  assert.equal(next.get('symbol'), 'ETHUSD')
  assert.equal(p.get('tf'), '1h', 'never mutate the router parameters')
  assert.equal(journalFilters(new URLSearchParams('page=-1'), now).page, 0)
  assert.ok(journalFilters(new URLSearchParams('period=nonsense'),now).error)
})
