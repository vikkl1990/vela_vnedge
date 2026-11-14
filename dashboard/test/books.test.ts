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

test('the ladder climbs backtest, shadow, paper, live and never skips a step', () => {
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
  assert.deepEqual(account.steps, { backtest: 'done', shadow: 'done', paper: 'now', live: 'todo' })
  assert.equal(account.reached, 'paper')
})

test('account admission alone never implies verified live execution', () => {
  assert.equal(ladderOf({ stages: { live: 1 } }).steps.live, 'todo')
  assert.equal(ladderOf({ stages: { live: 1 }, liveTrades: 2 }).steps.live, 'now')
  assert.equal(ladderOf({ stages: { shadow: 1 } }).steps.live, 'todo')
})

test('trades alone place a strategy even when the incubator has no pair for it', () => {
  assert.equal(ladderOf({ stages: {}, paperTrades: 12 }).steps.paper, 'now')
  assert.equal(ladderOf({ stages: {}, shadowTrades: 40 }).steps.shadow, 'now')
})

test('the next step is one plain sentence per situation', () => {
  assert.match(nextStep({ stages: { proposed: 1 } }), /decision/i)
  assert.match(nextStep({ stages: { live: 1 } }), /paper/i)
  assert.match(nextStep({ stages: { shadow: 1 } }), /shadow/i)
  assert.match(nextStep({ stages: { candidate: 1 } }), /slot/i)
  assert.match(nextStep({ stages: {}, quarantined: true }), /quarantined/i)
  assert.match(nextStep({ stages: {}, runs: false }), /does not run/i)
  assert.match(nextStep({ stages: {} }), /not screened/i)
})

test('only paper and shadow have a trade journal today', () => {
  assert.equal(journalBookFor('paper'), 'paper')
  assert.equal(journalBookFor('shadow'), 'shadow')
  assert.equal(journalBookFor('live'), null)
  assert.equal(journalBookFor('backtest'), null)
  assert.equal(journalBookFor('all'), null)
})
