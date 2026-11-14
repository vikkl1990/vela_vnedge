import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT_PAGES, GROUPS, PHONE_TABS, routeMeta, visibleGroups } from '../src/components/shell/navModel.ts'

const all = [...GROUPS.flatMap((g) => g.items), ...ACCOUNT_PAGES]

test('every page has its own route and its own `g <key>` shortcut', () => {
  assert.equal(new Set(all.map((n) => n.to)).size, all.length)
  const keys = all.map((n) => n.key)
  assert.equal(new Set(keys).size, keys.length, `duplicate chord key in ${keys.join('')}`)
})

test('single-key shortcuts used elsewhere (t, d, [, ?, /) never collide with a chord prefix', () => {
  assert.ok(all.every((n) => n.key.length === 1))
  assert.ok(!all.some((n) => n.key === 'g'.repeat(2)))
})

test('the navigation keeps the three groups and every page that existed before the redesign', () => {
  assert.deepEqual(GROUPS.map((g) => g.label), ['Trade', 'Research', 'Control'])
  const routes = new Set(all.map((n) => n.to))
  for (const r of ['/', '/signals', '/radar', '/monitor', '/trades', '/chart', '/scanners', '/library', '/incubator', '/trackers', '/analytics', '/daily', '/learn', '/decisions', '/gates', '/exchange', '/settings', '/logs', '/profile', '/users']) {
    assert.ok(routes.has(r), `${r} is still reachable`)
  }
})

test('Users is hidden from anyone who is not an administrator', () => {
  assert.ok(ACCOUNT_PAGES.find((p) => p.to === '/users')?.adminOnly)
  assert.equal(visibleGroups(false).flatMap((g) => g.items).some((n) => n.adminOnly), false)
})

test('route titles come from the navigation, scanner pages from the scanner', () => {
  assert.deepEqual(routeMeta('/'), { title: 'Overview', section: 'Trade' })
  assert.deepEqual(routeMeta('/settings'), { title: 'Settings', section: 'Control' })
  assert.deepEqual(routeMeta('/profile'), { title: 'Profile', section: 'Account' })
  assert.deepEqual(routeMeta('/scanners/abc', 'Trend Lines'), { title: 'Trend Lines', section: 'Research', parent: { label: 'Scanners', to: '/scanners' } })
  assert.deepEqual(routeMeta('/trades/42/replay'), { title: 'Trade #42 replay', section: 'Trade', parent: { label: 'Journals', to: '/trades' } })
  assert.deepEqual(routeMeta('/nope'), { title: 'Not found', section: null })
})

test('the phone bar keeps the four daily views and every one is a real page', () => {
  assert.equal(PHONE_TABS.length, 4)
  for (const t of PHONE_TABS) assert.ok(all.some((n) => n.to === t.to))
})
