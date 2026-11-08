import assert from 'node:assert/strict'
import { test } from 'node:test'
import { journalExportQuery, fetchJournalCsv } from '../src/lib/journalExport.ts'
const query = { book:'shadow',status:'closed',scope:'evidence',history:'current',dateBy:'exit',sort:'worst',scanner:'a & b',symbol:'ETHUSD',tf:'15m',side:'long',reason:'sl',from:1000,to:2000,limit:50,offset:200 }

test('filtered export preserves the complete selection while removing pagination', () => {
  const exported = journalExportQuery(query, 'filtered')
  assert.equal(exported.offset, undefined); assert.equal(exported.limit, undefined)
  assert.deepEqual(exported, Object.fromEntries(Object.entries(query).filter(([k]) => !['limit','offset'].includes(k))))
  assert.equal(query.offset, 200)
})
test('complete export retains the book and includes archives without leaking active filters', () => {
  assert.deepEqual(journalExportQuery(query, 'complete'), {book:'shadow',status:'closed',scope:'all',history:'all',dateBy:'exit',sort:'newest'})
})
test('CSV download sends authentication, preserves encoded filters and returns the server filename', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const p = new URL(url, 'http://localhost').searchParams
    assert.equal(p.get('scanner'),'a & b'); assert.equal(p.get('kind'),'fills'); assert.equal(p.get('offset'),null)
    assert.equal(options.credentials,'include'); assert.equal(options.cache,'no-store')
    return new Response('\uFEFFbook,id\r\nshadow,1\r\n', {headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="vn-edge-shadow-fills-2026-11-08.csv"'}})
  })
  const file = await fetchJournalCsv(journalExportQuery(query,'filtered'),'fills')
  assert.equal(file.filename,'vn-edge-shadow-fills-2026-11-08.csv'); assert.match(await file.blob.text(), /shadow,1/)
})
test('failed or non-CSV responses cannot be downloaded as trade history', async t => {
  const cases = [
    [new Response('{}',{status:401}),/Sign in again/],
    [new Response('{"error":"Invalid date range"}',{status:400}),/Invalid date range/],
    [new Response('<html>Login</html>',{headers:{'Content-Type':'text/html'}}),/did not return a CSV/],
    [new Response('',{headers:{'Content-Type':'text/csv'}}),/empty file/],
  ] as const
  for (const [response,expected] of cases) {
    const mock=t.mock.method(globalThis,'fetch',async()=>response)
    await assert.rejects(fetchJournalCsv(query,'trades'),expected);mock.mock.restore()
  }
})

test('both-book export applies identical filters and preserves escaped records under one header', async t => {
  const requests: string[] = []
  const paper = '"paper","1","scanner, with ""quotes""\nand newline","\'=SUM(A1)"\r\n'
  const shadow = '"shadow","1","another scanner","2"\r\n'
  const header = '"book","id","scanner","value"\r\n'
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const p = new URL(url, 'http://localhost').searchParams
    requests.push(p.get('book')!)
    assert.equal(p.get('scanner'), 'a & b'); assert.equal(p.get('from'), '1000')
    assert.equal(p.get('history'), 'current'); assert.equal(p.get('scope'), 'evidence')
    assert.equal(p.get('offset'), null); assert.equal(p.get('limit'), null)
    return new Response('\uFEFF' + header + (p.get('book') === 'paper' ? paper : shadow), { headers: { 'Content-Type': 'text/csv' } })
  })
  const file = await fetchJournalCsv(journalExportQuery(query, 'filtered'), 'trades', 'both')
  assert.deepEqual(requests.sort(), ['paper', 'shadow'])
  assert.equal(await file.blob.text(), header + paper + shadow)
  assert.match(file.filename, /^vn-edge-paper-and-shadow-trades-\d{4}-\d{2}-\d{2}\.csv$/)
  assert.deepEqual([...new Uint8Array(await file.blob.arrayBuffer()).slice(0, 3)], [239, 187, 191])
})

test('complete both-book fills include archives even when paper has no matching rows', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const p = new URL(url, 'http://localhost').searchParams
    assert.equal(p.get('history'), 'all'); assert.equal(p.get('scope'), 'all')
    assert.equal(p.get('kind'), 'fills'); assert.equal(p.get('status'), 'closed')
    assert.equal(p.get('scanner'), null); assert.equal(p.get('from'), null)
    return new Response('book,position_id\r\n' + (p.get('book') === 'paper' ? '' : 'shadow,42\r\n'), { headers: { 'Content-Type': 'text/csv' } })
  })
  const file = await fetchJournalCsv(journalExportQuery(query, 'complete'), 'fills', 'both')
  assert.equal(await file.blob.text(), 'book,position_id\r\nshadow,42\r\n')
  assert.match(file.filename, /paper-and-shadow-fills/)
})

test('both-book export fails as a whole if either book fails', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => new URL(url, 'http://localhost').searchParams.get('book') === 'paper'
    ? new Response('book,id\r\npaper,1\r\n', { headers: { 'Content-Type': 'text/csv' } })
    : new Response('{"error":"Shadow export unavailable"}', { status: 500 }))
  await assert.rejects(fetchJournalCsv(query, 'trades', 'both'), /Shadow export unavailable/)
})

test('both-book export rejects incompatible column layouts', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(
    new URL(url, 'http://localhost').searchParams.get('book') === 'paper' ? 'book,id\r\n' : 'book,position_id\r\n',
    { headers: { 'Content-Type': 'text/csv' } }))
  await assert.rejects(fetchJournalCsv(query, 'trades', 'both'), /columns do not match/)
})

test('a single book can be exported without switching the displayed journal', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(new URL(url, 'http://localhost').searchParams.get('book'), 'paper')
    return new Response('book,id\r\npaper,1\r\n', { headers: { 'Content-Type': 'text/csv' } })
  })
  const file = await fetchJournalCsv(query, 'trades', 'paper')
  assert.match(file.filename, /^vn-edge-paper-trades-/)
  assert.equal(query.book, 'shadow')
})
