import assert from 'node:assert/strict'
import { test } from 'node:test'
import { followsChordPrefix } from '../src/lib/hotkeys.ts'

const isG = (k: string) => k === 'g'

test('a single key right after a chord prefix belongs to the chord', () => {
  assert.equal(followsChordPrefix({ key: 'g', at: 1000 }, 1300, isG), true)
  assert.equal(followsChordPrefix({ key: 'g', at: 1000 }, 1900, isG), true, 'the window is inclusive')
})

test('after the chord window, or after any other key, a single key is its own shortcut', () => {
  assert.equal(followsChordPrefix({ key: 'g', at: 1000 }, 1901, isG), false)
  assert.equal(followsChordPrefix({ key: 'x', at: 1000 }, 1100, isG), false)
  assert.equal(followsChordPrefix(null, 1100, isG), false)
})
