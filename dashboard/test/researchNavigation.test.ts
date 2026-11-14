import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choice, patchSearch, researchHref, sectionFromUrl, sectionLocation, signalSectionFromUrl, scannerSectionFromUrl } from '../src/lib/researchNavigation.ts'

test('changing a research view keeps market filters and clearing filters keeps the view', () => {
  const original = new URLSearchParams('symbol=ETHUSD&tf=15m&section=shadow')
  const account = patchSearch(original, { section: 'account' })
  assert.equal(account.get('symbol'), 'ETHUSD')
  assert.equal(account.get('tf'), '15m')
  assert.equal(original.get('section'), 'shadow')
  const cleared = patchSearch(account, { symbol: null, tf: null, q: null })
  assert.equal(cleared.toString(), 'section=account')
})

test('old disclosure bookmarks open their new views, unknown sections fall back safely', () => {
  const sections = ['directory', 'readiness', 'contributions'] as const
  assert.equal(sectionFromUrl(new URLSearchParams('section=directory'), '#readiness', sections, 'directory', { '#readiness': 'readiness' }), 'readiness')
  assert.equal(sectionFromUrl(new URLSearchParams('section=unknown'), '', sections, 'directory'), 'directory')
  assert.equal(choice('bad', ['', 'entry', 'exit', 'info'], ''), '')
})

test('market links carry encoded cell filters without losing symbols or injecting query parameters', () => {
  const href = researchHref('/incubator', { symbol: 'ETHUSD', tf: '15m', section: 'shadow' })
  const url = new URL(href, 'https://example.test')
  assert.equal(url.pathname, '/incubator')
  assert.equal(url.searchParams.get('symbol'), 'ETHUSD')
  assert.equal(url.searchParams.get('tf'), '15m')
  assert.equal(new URL(researchHref('/scanners', { q: 'A&B / trend', book: 'account' }), url).searchParams.get('q'), 'A&B / trend')
})


test('signals follow tab links and history, including legacy diagnostics bookmarks', () => {
  const p = (query: string) => new URLSearchParams(query)
  assert.equal(signalSectionFromUrl(p('section=outcomes'), ''), 'outcomes')
  assert.equal(signalSectionFromUrl(p('section=recovery'), ''), 'recovery')
  assert.equal(signalSectionFromUrl(p('section=diagnostics'), ''), 'trace')
  assert.equal(signalSectionFromUrl(p('section=events'), ''), 'signals')
  assert.equal(signalSectionFromUrl(p(''), '#execution-costs'), 'costs')
  assert.equal(signalSectionFromUrl(p(''), ''), 'signals')
})

test('scanner directory filters reach inactive scanners and explicit tabs survive history', () => {
  const p = (query: string) => new URLSearchParams(query)
  for (const query of ['activity=off', 'book=none', 'q=VWAP', 'section=directory', 'removed=1']) {
    assert.equal(scannerSectionFromUrl(p(query), ''), 'catalogue')
  }
  assert.equal(scannerSectionFromUrl(p('activity=off&section=trading'), ''), 'trading')
  assert.equal(scannerSectionFromUrl(p('section=quarantined&view=table'), ''), 'quarantined')
  assert.equal(scannerSectionFromUrl(p(''), '#contribution-ledger'), 'contributions')
  assert.equal(scannerSectionFromUrl(p(''), ''), 'trading')
})

test('leaving an Incubator anchor preserves filters and allows the default tab', () => {
  const search = new URLSearchParams('symbol=ETHUSD&tf=15m&section=operations')
  const next = sectionLocation('/incubator', search, null)
  assert.equal(next.pathname, '/incubator')
  assert.equal(next.hash, '')
  assert.equal(next.search, '?symbol=ETHUSD&tf=15m')
  assert.equal(sectionFromUrl(new URLSearchParams(next.search), next.hash, ['shadow', 'operations'], 'shadow', { '#screen-queue': 'operations' }), 'shadow')
  assert.equal(search.get('section'), 'operations')
})
