import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushRecent, rankItems, scoreItem, type PaletteItem } from '../src/lib/commandSearch.ts'

const items: PaletteItem[] = [
  {
    id: 'p:overview',
    kind: 'page',
    title: 'Overview',
    subtitle: 'Trade',
    keywords: 'home dashboard',
    to: '/',
  },
  { id: 'p:signals', kind: 'page', title: 'Signals', subtitle: 'Trade', to: '/signals' },
  { id: 'p:scanners', kind: 'page', title: 'Scanners', subtitle: 'Research', to: '/scanners' },
  { id: 'a:theme', kind: 'action', title: 'Toggle light / dark theme', keywords: 'appearance colour' },
  {
    id: 's:tic',
    kind: 'scanner',
    title: 'Trend Impulse Channels (Zeiierman)',
    subtitle: 'Zeiierman',
    to: '/scanners/trend-impulse-channels-zeiierman',
  },
  {
    id: 's:ltm',
    kind: 'scanner',
    title: 'Liquidity Trail Matrix',
    subtitle: 'WillyAlgoTrader',
    to: '/scanners/liquidity-trail-matrix',
  },
]

test('an empty query lists pages and actions, not the scanner long tail', () => {
  const out = rankItems(items, '')
  assert.deepEqual(
    out.map((i) => i.id),
    ['p:overview', 'p:signals', 'p:scanners', 'a:theme'],
  )
})

test('recent items lead an empty query and drop out when they no longer exist', () => {
  const out = rankItems(items, '', { recent: ['s:ltm', 'gone', 'p:signals'] })
  assert.deepEqual(
    out.slice(0, 2).map((i) => i.id),
    ['s:ltm', 'p:signals'],
  )
  assert.equal(out.filter((i) => i.id === 'p:signals').length, 1)
})

test('a title prefix beats a substring, and pages beat scanners on a tie', () => {
  assert.equal(rankItems(items, 'sig')[0].id, 'p:signals')
  assert.equal(rankItems(items, 'scan')[0].id, 'p:scanners')
})

test('every token has to match, in any field, in any order', () => {
  assert.deepEqual(
    rankItems(items, 'zeiierman impulse').map((i) => i.id),
    ['s:tic'],
  )
  assert.deepEqual(
    rankItems(items, 'willy trail').map((i) => i.id),
    ['s:ltm'],
  )
  assert.deepEqual(rankItems(items, 'impulse nonsense'), [])
})

test('keywords find an item without being shown, and accents and case do not matter', () => {
  assert.equal(rankItems(items, 'DASHBOARD')[0].id, 'p:overview')
  assert.equal(rankItems(items, 'colour')[0].id, 'a:theme')
})

test('a scattered match needs three characters, so one stray letter does not flood the list', () => {
  assert.equal(scoreItem('z', items[0]), 0)
  assert.ok(scoreItem('lqt', items[5]) > 0)
})

test('the limit is honoured and recents are remembered newest first without duplicates', () => {
  assert.equal(rankItems(items, 'a', { limit: 2 }).length, 2)
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b', 3), ['b', 'a', 'c'])
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
})
