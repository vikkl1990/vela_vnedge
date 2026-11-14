import { test } from 'node:test'
import assert from 'node:assert/strict'
import { choice, patchSearch, researchHref, sectionFromUrl } from '../src/lib/researchNavigation.ts'

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
