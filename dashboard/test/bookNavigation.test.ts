import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scopeFromLocation, scopeLocation, rememberScopeLocation } from '../src/lib/bookNavigation.ts'

test('client navigation and browser history resolve each explicit book link independently', () => {
  assert.equal(scopeFromLocation('/strategies', '?book=shadow', 'paper'), 'shadow')
  assert.equal(scopeFromLocation('/trades', '?book=paper', 'shadow'), 'paper')
  assert.equal(scopeFromLocation('/strategies', '?book=shadow', 'paper'), 'shadow')
  assert.equal(scopeFromLocation('/overview', '?bookScope=all', 'shadow'), 'all')
})

test('legacy catalogue and journal scope filters keep their original meanings', () => {
  assert.equal(scopeFromLocation('/scanners', '?book=shadow', 'paper'), 'paper')
  assert.equal(scopeFromLocation('/scanners', '?book=account', 'all'), 'all')
  assert.equal(scopeFromLocation('/trades', '?scope=watch', 'shadow'), 'shadow')
  const loc = scopeLocation('/scanners', '?book=account&section=catalogue', '#readiness', 'shadow')
  assert.equal(new URLSearchParams(loc.search).get('book'), 'account')
  assert.equal(loc.hash, '#readiness')
})

test('changing journal book clears a selected trade and pagination but preserves research filters', () => {
  const loc = scopeLocation('/trades', '?book=paper&trade=42&page=4&symbol=ETHUSD&period=7d&scope=all', '', 'shadow')
  const p = new URLSearchParams(loc.search)
  assert.equal(p.get('book'), 'shadow')
  assert.equal(p.get('bookScope'), 'shadow')
  assert.equal(p.get('symbol'), 'ETHUSD')
  assert.equal(p.get('period'), '7d')
  assert.equal(p.has('trade'), false)
  assert.equal(p.has('page'), false)
  assert.equal(scopeFromLocation('/trades', loc.search, 'paper'), 'shadow')
})

test('live and backtest scopes never become unsupported journal API books', () => {
  for (const scope of ['live', 'backtest', 'all'] as const) {
    const loc = scopeLocation('/trades', '?book=paper', '', scope)
    assert.equal(new URLSearchParams(loc.search).get('book'), 'paper')
    assert.equal(scopeFromLocation('/trades', loc.search, 'shadow'), scope)
  }
})

test('Back restores an inherited shadow selection after switching the journal to paper', () => {
  const previous = rememberScopeLocation('/trades', '?trade=42&symbol=ETHUSD&page=2', '', 'shadow')!
  const next = scopeLocation('/trades', previous.search, '', 'paper')
  assert.equal(scopeFromLocation('/trades', next.search, 'shadow'), 'paper')
  assert.equal(scopeFromLocation('/trades', previous.search, 'paper'), 'shadow')
  const p = new URLSearchParams(previous.search)
  assert.equal(p.get('trade'), '42')
  assert.equal(p.get('page'), '2')
  assert.equal(p.get('symbol'), 'ETHUSD')
  assert.equal(rememberScopeLocation('/trades', previous.search, '', 'paper'), null)
})
