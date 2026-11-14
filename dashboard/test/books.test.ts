import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOOK_ORDER, inScope, journalBookFor, ladderOf, nextStep, parseScope } from '../src/lib/books.ts'

test('a scope is one of the four books or all, and anything else means all', () => {
  assert.equal(parseScope('paper'), 'paper')
  assert.equal(parseScope('live'), 'live')
  assert.equal(parseScope('nonsense'), 'all')
  assert.equal(parseScope(null), 'all')
  assert.equal(inScope('all', ['shadow']), true)
  assert.equal(inScope('paper', ['shadow']), false)
  assert.equal(inScope('shadow', ['shadow', 'paper']), true)
})

test('the book ladder reflects reported allocations without replacing evidence rules', () => {
  assert.deepEqual(BOOK_ORDER, ['backtest', 'shadow', 'paper', 'live'])
  const none = ladderOf({ stages: {} })
  assert.deepEqual(none.steps, { backtest: 'todo', shadow: 'todo', paper: 'todo', live: 'todo' })
  assert.equal(none.reached, null)
  const screened = ladderOf({ stages: { candidate: 2 } })
  assert.deepEqual(screened.steps, { backtest: 'done', shadow: 'todo', paper: 'todo', live: 'todo' })
  assert.equal(screened.reached, 'backtest')
  const collecting = ladderOf({ stages: { shadow: 3 } })
  assert.deepEqual(collecting.steps, { backtest: 'done', shadow: 'now', paper: 'todo', live: 'todo' })
  const account = ladderOf({ stages: { live: 1, shadow: 2 } })
  assert.deepEqual(account.steps, { backtest: 'done', shadow: 'now', paper: 'now', live: 'todo' })
  assert.equal(account.reached, 'paper')
})

test('account admission alone never implies verified live execution', () => {
  assert.equal(ladderOf({ stages: { live: 1 } }).steps.live, 'todo')
  assert.equal(ladderOf({ stages: { live: 1 }, liveTrades: 2 }).steps.live, 'done')
  assert.equal(ladderOf({ stages: { shadow: 1 } }).steps.live, 'todo')
})

test('trades alone place a strategy even when the incubator has no pair for it', () => {
  assert.equal(ladderOf({ stages: {}, paperTrades: 12 }).steps.paper, 'done')
  assert.equal(ladderOf({ stages: {}, shadowTrades: 40 }).steps.shadow, 'done')
})

test('the next step is one plain sentence per situation', () => {
  assert.match(nextStep({ stages: { proposed: 1 } }), /decision/i)
  assert.match(nextStep({ stages: { live: 1 } }), /paper/i)
  assert.match(nextStep({ stages: { shadow: 1 } }), /shadow/i)
  assert.match(nextStep({ stages: { candidate: 1 } }), /slot/i)
  assert.match(nextStep({ stages: {}, quarantined: true }), /quarantined/i)
  assert.match(nextStep({ stages: {}, runs: false }), /does not run/i)
  assert.match(nextStep({ stages: {} }), /No screening evidence/i)
})

test('only paper and shadow have a trade journal today', () => {
  assert.equal(journalBookFor('paper'), 'paper')
  assert.equal(journalBookFor('shadow'), 'shadow')
  assert.equal(journalBookFor('live'), null)
  assert.equal(journalBookFor('backtest'), null)
  assert.equal(journalBookFor('all'), null)
})

test('tracked cells do not imply a passed screen, and old trades do not imply active allocation', () => {
  assert.equal(ladderOf({ stages: { tracked: 10 } }).steps.backtest, 'todo')
  const old = ladderOf({ stages: { retired: 1 }, paperTrades: 20, shadowTrades: 30 })
  assert.equal(old.steps.paper, 'done')
  assert.equal(old.steps.shadow, 'done')
  assert.equal(old.reached, 'paper')
  assert.equal(ladderOf({ stages: { live: 2 }, enabled: false }).steps.paper, 'done')
  assert.equal(ladderOf({ stages: { live: 2 }, runs: false }).steps.paper, 'done')
  assert.equal(ladderOf({ stages: { shadow: 2 }, enabled: false }).steps.shadow, 'now')
  assert.match(nextStep({ stages: { live: 1 }, enabled: false }), /disabled/)
  assert.match(nextStep({ stages: {}, paperTrades: 1 }), /history/)
})
