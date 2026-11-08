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
